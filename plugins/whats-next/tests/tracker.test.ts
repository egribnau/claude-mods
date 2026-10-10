import { expect, test } from 'claude-code/testing'

import { changesSince, epicGroups, loadRepo, milestoneIssues, milestoneKnown, noteChange, whatsNext } from '../hooks/load'
import type { EpicRow, OpenIssue, Tracker } from '../hooks/tracker'
import type { EpicChild, IssueDetail, IssueRow } from '../types'

// What's next and Epics against a fake tracker: no URLs, no Forgejo.

function row(number: number, created: string, milestone: string | null = null): IssueRow {
  return { number, title: `Issue ${number}`, milestone, labels: [], created, url: `fake:${number}`, body: '' }
}

function child(number: number, extra: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    assignees: [],
    mine: false,
    blocked: false,
    labels: [],
    milestone: null,
    created: '2026-10-01T00:00:00Z',
    blockedBy: [],
    ...extra,
  }
}

type Fake = {
  mine?: IssueRow[]
  open?: OpenIssue[]
  epics?: EpicRow[]
  blockers?: Record<number, number[] | null>
  children?: Record<number, EpicChild[] | null>
  failing?: 'mine' | 'epics'
}

// A tracker answering from `f`, recording each call.
function fake(f: Fake, calls: string[] = []): Tracker {
  const fail = (what: string) => {
    throw new Error(`${what}: HTTP 500`)
  }
  return {
    name: 'Forgejo',
    tokensUrl: 'fake:tokens',
    scopes: 'fake scopes',
    setting: 'Forgejo tokens',
    writeScope: 'fake:write',
    check: async () => ({ version: 'fake', setup: { kind: 'checking' } }),
    milestones: async () => {
      calls.push('milestones')
      return [{ title: 'v1', due: '2026-11-01T00:00:00Z', closed: 1, total: 4 }]
    },
    closedMilestones: async () => {
      calls.push('closed milestones')
      return []
    },
    mine: async () => {
      calls.push('mine')
      return f.failing === 'mine' ? fail('your issues') : (f.mine ?? [])
    },
    open: async () => {
      calls.push('open')
      return f.open ?? []
    },
    epics: async () => {
      calls.push('epics')
      return f.failing === 'epics' ? fail('epics') : (f.epics ?? [])
    },
    blockers: async n => {
      calls.push(`blockers ${n}`)
      return f.blockers?.[n] ?? []
    },
    children: async (n, me) => {
      calls.push(`children ${n} ${me}`)
      return f.children?.[n] ?? null
    },
    issue: async () => fail('issue'),
    assign: async () => null,
    close: async () => null,
  }
}

const free = (i: IssueRow, assignees: string[] = []): OpenIssue => ({ ...i, assignees })

test("What's next: yours, then the oldest free issue with no open blockers, the ones skipped blocked", async () => {
  const calls: string[] = []
  const t = fake(
    {
      mine: [row(42, '2026-09-25T00:00:00Z')],
      open: [
        free(row(42, '2026-09-25T00:00:00Z'), ['alice']),
        free(row(37, '2026-10-02T00:00:00Z')),
        free(row(33, '2026-09-11T00:00:00Z')),
        free(row(29, '2026-09-18T00:00:00Z')),
        free(row(60, '2026-09-01T00:00:00Z'), ['jdoe']),
      ],
      blockers: { 33: [37] },
    },
    calls,
  )
  const { memory, issuesError } = await loadRepo(t, true)
  expect(issuesError).toBe(null)
  const next = await whatsNext(t, memory, 'all', true)
  expect(next.inProgress.map(i => i.number)).toEqual([42])
  expect(next.next?.number).toBe(29)
  expect(next.queue.map(i => i.number)).toEqual([37])
  expect(next.blocked).toEqual([{ issue: row(33, '2026-09-11T00:00:00Z'), by: [37] }])
  // Walked through Next and the Queue, and remembered: a second look asks nothing.
  expect(calls.filter(c => c.startsWith('blockers'))).toEqual(['blockers 33', 'blockers 29', 'blockers 37'])
  await whatsNext(t, memory, 'all', true)
  expect(calls.filter(c => c.startsWith('blockers'))).toHaveLength(3)
})

test("What's next within a milestone, and without dependencies no blockers are asked", async () => {
  const calls: string[] = []
  const t = fake(
    { open: [free(row(5, '2026-09-01T00:00:00Z')), free(row(6, '2026-09-02T00:00:00Z', 'v1'))], blockers: { 6: [5] } },
    calls,
  )
  const { memory } = await loadRepo(t, true)
  const next = await whatsNext(t, memory, 'm:v1', false)
  expect(next.next?.number).toBe(6)
  expect(next.blocked).toEqual([])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test('without dependencies the Queue is only limited: 10, the rest counted, nothing asked', async () => {
  const calls: string[] = []
  const day = (k: number) => `2026-09-${String(k).padStart(2, '0')}T00:00:00Z`
  const t = fake({ open: Array.from({ length: 15 }, (_, k) => free(row(k + 1, day(k + 1)))), blockers: { 3: [1] } }, calls)
  const { memory } = await loadRepo(t, true)
  const next = await whatsNext(t, memory, 'all', false)
  expect(next.next?.number).toBe(1)
  expect(next.queue.map(i => i.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  expect(next.more).toBe(4)
  expect(next.blocked).toEqual([])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test('a list that fails is named, and the rest still loads', async () => {
  const issues = await loadRepo(fake({ failing: 'mine', epics: [{ number: 1, title: 'E', state: 'open', milestone: null }] }), true)
  expect(issues.issuesError).toBe('your issues: HTTP 500')
  expect(issues.memory.epics).toHaveLength(1)
  const epics = await loadRepo(fake({ failing: 'epics' }), true)
  expect(epics.epicsError).toBe('epics: HTTP 500')
})

test('with epics off, the tracker is not asked for them', async () => {
  const calls: string[] = []
  const { memory } = await loadRepo(fake({ epics: [{ number: 1, title: 'E', state: 'open', milestone: null }] }, calls), false)
  expect(memory.epics).toEqual([])
  expect(calls).not.toContain('epics')
})

test('Epics: grouped by milestone, open first, children asked once with who you are', async () => {
  const calls: string[] = []
  const t = fake(
    {
      epics: [
        { number: 9, title: 'Closed epic', state: 'closed', milestone: 'v1' },
        { number: 3, title: 'Open epic', state: 'open', milestone: 'v1' },
        { number: 4, title: 'Loose epic', state: 'open', milestone: null },
      ],
      children: { 3: [child(10, { mine: true, assignees: ['alice'] }), child(11, { state: 'closed' })] },
    },
    calls,
  )
  const { memory } = await loadRepo(t, true)
  const groups = await epicGroups(t, memory, 'all', 'alice')
  expect(groups.map(g => g.title)).toEqual(['v1', null])
  expect(groups[0]?.epics.map(e => [e.number, e.state])).toEqual([
    [3, 'open'],
    [9, 'closed'],
  ])
  expect(groups[0]?.epics[0]?.children?.map(c => c.number)).toEqual([10, 11])
  expect(groups[0]?.epics[1]?.children).toBe(null)
  expect(groups[1]?.epics[0]?.children).toBe(null)
  expect(groups[0]).toMatchObject({ due: '2026-11-01T00:00:00Z', closed: 1, total: 4 })
  // Closed epics are not asked about; each open one once.
  expect(calls.filter(c => c.startsWith('children')).sort()).toEqual(['children 3 alice', 'children 4 alice'])
  await epicGroups(t, memory, 'm:v1', 'alice')
  expect(calls.filter(c => c.startsWith('children'))).toHaveLength(2)
})

// An issue as the detail view read it right after a change.
function changed(number: number, state: string, assignees: string[], created = '2026-09-18T00:00:00Z'): IssueDetail {
  return {
    ...row(number, created, 'v1'),
    state,
    author: 'jdoe',
    updated: '2026-10-09T00:00:00Z',
    comments: 0,
    milestone: { title: 'v1', due: null },
    due: null,
    branch: null,
    logged: null,
    estimate: null,
    assignees,
    blockedBy: null,
    blocks: null,
    pulls: null,
    commits: null,
    lastComment: null,
  }
}

test('changes win over lists that lag them: assigned, unassigned, closed and reopened', async () => {
  // The lists as they were before every change below.
  const t = fake({
    mine: [row(10, '2026-09-10T00:00:00Z'), row(11, '2026-09-11T00:00:00Z')],
    open: [
      free(row(10, '2026-09-10T00:00:00Z'), ['alice']),
      free(row(11, '2026-09-11T00:00:00Z'), ['alice']),
      free(row(12, '2026-09-12T00:00:00Z')),
      free(row(13, '2026-09-13T00:00:00Z')),
    ],
  })
  const changes = [
    // Unassigned: free now.
    changed(10, 'open', [], '2026-09-10T00:00:00Z'),
    // Closed while yours: in neither list.
    changed(11, 'closed', ['alice'], '2026-09-11T00:00:00Z'),
    // Assigned to you: yours now.
    changed(12, 'open', ['alice'], '2026-09-12T00:00:00Z'),
    // Given to someone else: in neither list.
    changed(13, 'open', ['jdoe'], '2026-09-13T00:00:00Z'),
    // Reopened, free: back in the list.
    changed(14, 'open', [], '2026-09-14T00:00:00Z'),
  ]
  const { memory } = await loadRepo(t, false, changes, 'alice')
  expect(memory.mine.map(i => i.number)).toEqual([12])
  expect(memory.free.map(i => i.number)).toEqual([10, 14])
  expect(memory.free[0]).toEqual(expect.objectContaining({ milestone: 'v1', url: 'fake:10', body: '' }))
})

test('a change counts for 30 seconds, then the lists are trusted again', () => {
  const at = Date.parse('2026-10-09T12:00:00Z')
  noteChange('fake/boats/radar', changed(10, 'open', []), at)
  noteChange('fake/boats/other', changed(11, 'open', []), at)
  expect(changesSince('fake/boats/radar', at + 30_000).map(i => i.number)).toEqual([10])
  expect(changesSince('fake/boats/radar', at + 30_001)).toEqual([])
  // Forgotten once past: an earlier time no longer finds it.
  expect(changesSince('fake/boats/radar', at)).toEqual([])
  expect(changesSince('fake/boats/other', at).map(i => i.number)).toEqual([11])
  expect(changesSince('fake/nothing', at)).toEqual([])
})

test("a milestone's open issues: yours, free and someone else's, those not yours checked for blockers once", async () => {
  const calls: string[] = []
  const t = fake(
    {
      mine: [row(30, '2026-10-01T00:00:00Z', 'v1')],
      open: [
        free(row(30, '2026-10-01T00:00:00Z', 'v1'), ['alice']),
        free(row(33, '2026-10-02T00:00:00Z', 'v1')),
        free(row(36, '2026-10-03T00:00:00Z', 'v1'), ['jdoe']),
        free(row(40, '2026-10-04T00:00:00Z', 'v1')),
        free(row(50, '2026-10-05T00:00:00Z', 'v2')),
      ],
      blockers: { 40: [33] },
    },
    calls,
  )
  const { memory } = await loadRepo(t, false, [], 'alice')
  const issues = await milestoneIssues(t, memory, 'v1', 'alice', true)
  expect(issues?.map(c => [c.number, c.mine, c.assignees, c.blocked, c.blockedBy])).toEqual([
    [30, true, ['alice'], false, []],
    [33, false, [], false, []],
    [36, false, ['jdoe'], false, []],
    [40, false, [], true, [33]],
  ])
  expect(issues?.every(c => c.state === 'open' && c.milestone === 'v1')).toBe(true)
  expect(calls.filter(c => c.startsWith('blockers'))).toEqual(['blockers 33', 'blockers 36', 'blockers 40'])
  // Remembered with What's next's: asked again, nothing more is sent.
  await milestoneIssues(t, memory, 'v1', 'alice', true)
  await whatsNext(t, memory, 'm:v1', true)
  expect(calls.filter(c => c.startsWith('blockers'))).toHaveLength(3)
})

test("without dependencies a milestone's issues are not checked for blockers", async () => {
  const calls: string[] = []
  const t = fake({ open: [free(row(40, '2026-10-04T00:00:00Z', 'v1'))], blockers: { 40: [33] } }, calls)
  const { memory } = await loadRepo(t, false)
  const issues = await milestoneIssues(t, memory, 'v1', null, false)
  expect(issues?.map(c => c.blocked)).toEqual([false])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test("what is known of a milestone without asking: without dependencies nothing is blocked, so all of it", async () => {
  const calls: string[] = []
  const t = fake({ open: [free(row(40, '2026-10-04T00:00:00Z', 'v1'))], blockers: { 40: [33] } }, calls)
  const { memory } = await loadRepo(t, false)
  expect(milestoneKnown(memory, 'v1', false)).toEqual({ checked: true, mine: 0, free: 1, taken: 0, blocked: 0 })
  expect(milestoneKnown(memory, 'v1', true)).toEqual({ checked: false, mine: 0, free: 1, taken: 0, blocked: 0 })
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test("when the issues could not be listed, a milestone's issues are unknown", async () => {
  const t = fake({ failing: 'mine' })
  const { memory } = await loadRepo(t, false)
  expect(await milestoneIssues(t, memory, 'v1', null, true)).toBe(null)
})

test("a milestone's epic carries its children, asked once, and is not blocked by them", async () => {
  const calls: string[] = []
  const t = fake(
    {
      open: [free(row(29, '2026-10-01T00:00:00Z', 'v1')), free(row(33, '2026-10-02T00:00:00Z', 'v1'))],
      epics: [{ number: 29, title: 'Issue 29', state: 'open', milestone: 'v1' }],
      blockers: { 29: [33] },
      children: { 29: [child(33), child(34, { state: 'closed' })] },
    },
    calls,
  )
  const { memory } = await loadRepo(t, true, [], 'alice')
  const issues = await milestoneIssues(t, memory, 'v1', 'alice', true)
  const epic = issues?.find(c => c.number === 29)
  expect(epic?.children?.map(c => c.number)).toEqual([33, 34])
  expect(epic?.blocked).toBe(false)
  expect(issues?.find(c => c.number === 33)?.children).toBeUndefined()
  // Shared with the Epics pane: its children are not asked again.
  await epicGroups(t, memory, 'all', 'alice')
  expect(calls.filter(c => c.startsWith('children'))).toEqual(['children 29 alice'])
})

test('an epic blocked by an issue outside it is blocked by that one only', async () => {
  const t = fake({
    open: [free(row(29, '2026-10-01T00:00:00Z', 'v1'))],
    epics: [{ number: 29, title: 'Issue 29', state: 'open', milestone: 'v1' }],
    blockers: { 29: [33, 99] },
    children: { 29: [child(33)] },
  })
  const { memory } = await loadRepo(t, true)
  const issues = await milestoneIssues(t, memory, 'v1', null, true)
  expect(issues?.map(c => [c.blocked, c.blockedBy])).toEqual([[true, [99]]])
})
