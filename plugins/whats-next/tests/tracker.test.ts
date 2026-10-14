import { expect, test } from 'claude-code/testing'

import { childOf } from '../hooks/epics'
import { ALL, NONE, ofMilestone } from '../hooks/filter'
import { changesSince, loadRepo, noteChange } from '../hooks/load'
import type { Closed, EpicRow, OpenIssue, Tracker } from '../hooks/tracker'
import type { EpicChild, IssueDetail, IssueRow } from '../types'

// What is known of a repo, through its interface, against a fake tracker:
// no URLs, no Forgejo.

function row(number: number, created: string, milestone: string | null = null): IssueRow {
  return { number, title: `Issue ${number}`, milestone, labels: [], created, due: null, url: `fake:${number}`, body: '', updated: created }
}

function child(number: number, extra: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    assignees: [],
    labels: [],
    milestone: null,
    created: '2026-10-01T00:00:00Z',
    due: null,
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
  // The issues whose children request fails.
  failingChildren?: number[]
  // Where you work: your last closed issue within each milestone filter
  // setting, the epic each issue is a child of, each epic's children's
  // numbers, and whether children nest.
  lastClosed?: Record<string, Closed | null>
  parents?: Record<number, number>
  members?: Record<number, number[]>
  nested?: boolean
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
    children: async n => {
      calls.push(`children ${n}`)
      return f.failingChildren?.includes(n) ? fail(`children of #${n}`) : (f.children?.[n] ?? null)
    },
    members: async n => {
      calls.push(`members ${n}`)
      return f.members?.[n] ?? null
    },
    parentOf: async n => {
      calls.push(`parent ${n}`)
      return f.parents?.[n] ?? null
    },
    nested: f.nested ?? false,
    lastClosed: async within => {
      const key = typeof within === 'object' ? within.title : within
      calls.push(`last closed ${key}`)
      return f.lastClosed?.[key] ?? null
    },
    issue: async () => fail('issue'),
    assign: async () => null,
    close: async () => null,
    closeMilestone: async () => null,
  }
}

const free = (i: IssueRow, assignees: string[] = []): OpenIssue => ({ ...i, assignees })

// What is known of the repo `t` answers, built as a load builds it.
const load = (t: Tracker, o: { me?: string | null; deps?: boolean; epics?: boolean; changes?: IssueDetail[] } = {}) =>
  loadRepo(t, { me: o.me ?? null, features: { time: true, deps: o.deps ?? true, epics: o.epics ?? true }, changes: o.changes })

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
  const known = await load(t)
  expect(known.issuesError).toBe(null)
  const next = await known.whatsNext(ALL)
  expect(next.inProgress.map(i => i.number)).toEqual([42])
  expect(next.next?.number).toBe(29)
  expect(next.queue.map(i => i.number)).toEqual([37])
  expect(next.blocked).toEqual([{ issue: row(33, '2026-09-11T00:00:00Z'), by: [37] }])
  // Walked through Next and the Queue, and remembered: a second look asks nothing.
  expect(calls.filter(c => c.startsWith('blockers'))).toEqual(['blockers 33', 'blockers 29', 'blockers 37'])
  await known.whatsNext(ALL)
  expect(calls.filter(c => c.startsWith('blockers'))).toHaveLength(3)
})

test("What's next within a milestone, and without dependencies no blockers are asked", async () => {
  const calls: string[] = []
  const t = fake(
    { open: [free(row(5, '2026-09-01T00:00:00Z')), free(row(6, '2026-09-02T00:00:00Z', 'v1'))], blockers: { 6: [5] } },
    calls,
  )
  const known = await load(t, { deps: false })
  const next = await known.whatsNext(ofMilestone('v1'))
  expect(next.next?.number).toBe(6)
  expect(next.blocked).toEqual([])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test('without dependencies the Queue is only limited: 10, the rest counted, nothing asked', async () => {
  const calls: string[] = []
  const day = (k: number) => `2026-09-${String(k).padStart(2, '0')}T00:00:00Z`
  const t = fake({ open: Array.from({ length: 15 }, (_, k) => free(row(k + 1, day(k + 1)))), blockers: { 3: [1] } }, calls)
  const known = await load(t, { deps: false })
  const next = await known.whatsNext(ALL)
  expect(next.next?.number).toBe(1)
  expect(next.queue.map(i => i.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  expect(next.more).toBe(4)
  expect(next.blocked).toEqual([])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test('a list that fails is named, and the rest still loads', async () => {
  const issues = await load(fake({ failing: 'mine', epics: [{ number: 1, title: 'E', state: 'open', milestone: null, due: null }] }))
  expect(issues.issuesError).toBe('your issues: HTTP 500')
  expect(issues.listed).toBe(false)
  expect([...issues.openEpics]).toEqual([1])
  const epics = await load(fake({ failing: 'epics' }))
  expect(epics.epicsError).toBe('epics: HTTP 500')
})

test('with epics off, the tracker is not asked for them', async () => {
  const calls: string[] = []
  const known = await load(fake({ epics: [{ number: 1, title: 'E', state: 'open', milestone: null, due: null }] }, calls), { epics: false })
  expect(known.openEpics.size).toBe(0)
  expect(calls).not.toContain('epics')
})

test('Epics: grouped by milestone, open first, children asked once, standing for who you are', async () => {
  const calls: string[] = []
  const t = fake(
    {
      epics: [
        { number: 9, title: 'Closed epic', state: 'closed', milestone: 'v1', due: null },
        { number: 3, title: 'Open epic', state: 'open', milestone: 'v1', due: null },
        { number: 4, title: 'Loose epic', state: 'open', milestone: null, due: null },
      ],
      children: { 3: [child(10, { assignees: ['alice'] }), child(11, { state: 'closed' })] },
    },
    calls,
  )
  const known = await load(t, { me: 'alice' })
  const { groups } = await known.epics(ALL)
  expect(groups.map(g => g.title)).toEqual(['v1', null])
  expect(groups[0]?.epics.map(e => [e.number, e.state])).toEqual([
    [3, 'open'],
    [9, 'closed'],
  ])
  expect(groups[0]?.epics[0]?.children?.map(c => c.number)).toEqual([10, 11])
  expect(groups[0]?.epics[0]?.children?.map(c => c.mine)).toEqual([true, false])
  expect(groups[0]?.epics[1]?.children).toBe(null)
  expect(groups[1]?.epics[0]?.children).toBe(null)
  expect(groups[0]).toMatchObject({ due: '2026-11-01T00:00:00Z', closed: 1, total: 4 })
  // Closed epics are not asked about; each open one once.
  expect(calls.filter(c => c.startsWith('children')).sort()).toEqual(['children 3', 'children 4'])
  await known.epics(ofMilestone('v1'))
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
    commentList: null,
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
  const known = await load(t, { me: 'alice', deps: false, epics: false, changes })
  const next = await known.whatsNext(ALL)
  expect(next.inProgress.map(i => i.number)).toEqual([12])
  expect([next.next?.number, ...next.queue.map(i => i.number)]).toEqual([10, 14])
  expect(next.next).toEqual(expect.objectContaining({ milestone: 'v1', url: 'fake:10', body: '' }))
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
  const known = await load(t, { me: 'alice', epics: false })
  const issues = await known.milestone('v1')
  expect(issues?.map(c => [c.number, c.mine, c.assignees, c.blocked, c.blockedBy])).toEqual([
    [30, true, ['alice'], false, []],
    [33, false, [], false, []],
    [36, false, ['jdoe'], false, []],
    [40, false, [], true, [33]],
  ])
  expect(issues?.every(c => c.state === 'open' && c.milestone === 'v1')).toBe(true)
  expect(calls.filter(c => c.startsWith('blockers'))).toEqual(['blockers 33', 'blockers 36', 'blockers 40'])
  // Remembered with What's next's: asked again, nothing more is sent.
  await known.milestone('v1')
  await known.whatsNext(ofMilestone('v1'))
  expect(calls.filter(c => c.startsWith('blockers'))).toHaveLength(3)
})

test("without dependencies a milestone's issues are not checked for blockers", async () => {
  const calls: string[] = []
  const t = fake({ open: [free(row(40, '2026-10-04T00:00:00Z', 'v1'))], blockers: { 40: [33] } }, calls)
  const known = await load(t, { deps: false, epics: false })
  const issues = await known.milestone('v1')
  expect(issues?.map(c => c.blocked)).toEqual([false])
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test("what is known of a milestone without asking: without dependencies nothing is blocked, so all of it", async () => {
  const calls: string[] = []
  const t = fake({ open: [free(row(40, '2026-10-04T00:00:00Z', 'v1'))], blockers: { 40: [33] } }, calls)
  const without = await load(t, { deps: false, epics: false })
  expect(without.forYou('v1')).toEqual({ checked: true, yours: 0, available: 1, withOthers: 0, blocked: 0 })
  const withDeps = await load(t, { epics: false })
  expect(withDeps.forYou('v1')).toEqual({ checked: false, yours: 0, available: 1, withOthers: 0, blocked: 0 })
  expect(calls.some(c => c.startsWith('blockers'))).toBe(false)
})

test("when the issues could not be listed, a milestone's issues are unknown", async () => {
  const known = await load(fake({ failing: 'mine' }), { epics: false })
  expect(await known.milestone('v1')).toBe(null)
})

test("a milestone's epic carries its children, asked once, and is not blocked by them", async () => {
  const calls: string[] = []
  const t = fake(
    {
      open: [free(row(29, '2026-10-01T00:00:00Z', 'v1')), free(row(33, '2026-10-02T00:00:00Z', 'v1'))],
      epics: [{ number: 29, title: 'Issue 29', state: 'open', milestone: 'v1', due: null }],
      blockers: { 29: [33] },
      children: { 29: [child(33), child(34, { state: 'closed' })] },
    },
    calls,
  )
  const known = await load(t, { me: 'alice' })
  const issues = await known.milestone('v1')
  const epic = issues?.find(c => c.number === 29)
  expect(epic?.children?.map(c => c.number)).toEqual([33, 34])
  expect(epic?.blocked).toBe(false)
  expect(issues?.find(c => c.number === 33)?.children).toBeUndefined()
  // Shared with the Epics pane: its children are not asked again.
  await known.epics(ALL)
  expect(calls.filter(c => c.startsWith('children'))).toEqual(['children 29'])
})

test('an epic blocked by an issue outside it is blocked by that one only', async () => {
  const t = fake({
    open: [free(row(29, '2026-10-01T00:00:00Z', 'v1'))],
    epics: [{ number: 29, title: 'Issue 29', state: 'open', milestone: 'v1', due: null }],
    blockers: { 29: [33, 99] },
    children: { 29: [child(33)] },
  })
  const known = await load(t)
  const issues = await known.milestone('v1')
  expect(issues?.map(c => [c.blocked, c.blockedBy])).toEqual([[true, [99]]])
})

// Where you work (docs/whats-next/ORDERING.md). Epic #30 holds #43 and #44;
// #41, closed last, was in it. v1 holds #29 and #37; #50 has no milestone.
const NOW = Date.parse('2026-10-09T12:00:00Z')
const LAST: Closed = { number: 41, title: 'Issue 41', closed: '2026-10-09T10:00:00Z', milestone: 'v1' }
const WORK: Fake = {
  open: [
    free(row(29, '2026-09-01T00:00:00Z', 'v1')),
    free(row(37, '2026-09-02T00:00:00Z', 'v1')),
    free(row(43, '2026-09-20T00:00:00Z', 'v1')),
    free(row(44, '2026-09-21T00:00:00Z', 'v1')),
    free(row(50, '2026-08-01T00:00:00Z')),
  ],
  lastClosed: { all: LAST },
  parents: { 41: 30 },
  members: { 30: [41, 43, 44] },
}

test('where you work: Next follows on in the epic of the issue you closed last, then its milestone, then the rest', async () => {
  const calls: string[] = []
  const t = fake(WORK, calls)
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  const next = await known.whatsNext(ALL, NOW)
  expect(next.next?.number).toBe(43)
  expect(next.queue.map(i => i.number)).toEqual([44, 29, 37, 50])
  expect(next.scopes).toEqual({
    43: { kind: 'epic', number: 30 },
    44: { kind: 'epic', number: 30 },
    29: { kind: 'milestone', title: 'v1' },
    37: { kind: 'milestone', title: 'v1' },
  })
  expect(next.lastClosed).toEqual({ ...LAST, epic: 30 })
  // Three requests: your last closed issue, its epic, the epic's children.
  expect(calls.filter(c => /^(last closed|parent|members)/.test(c))).toEqual(['last closed all', 'parent 41', 'members 30'])
  // Remembered until Refresh: a second look asks nothing more.
  await known.whatsNext(ALL, NOW)
  expect(calls.filter(c => /^(last closed|parent|members)/.test(c))).toHaveLength(3)
})

test('where you work: your issue in progress updated last wins over the one you closed last', async () => {
  const calls: string[] = []
  const older = { ...row(60, '2026-09-01T00:00:00Z'), updated: '2026-10-01T00:00:00Z' }
  const newer = { ...row(61, '2026-09-02T00:00:00Z', 'v1'), updated: '2026-10-08T00:00:00Z' }
  const t = fake({ ...WORK, mine: [older, newer], parents: { 41: 30, 61: 12 }, members: { 30: [43, 44], 12: [37, 61] } }, calls)
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  const next = await known.whatsNext(ALL, NOW)
  // #61 was updated last: its epic #12 first, then v1.
  expect(next.next?.number).toBe(37)
  expect(next.scopes[37]).toEqual({ kind: 'epic', number: 12 })
  expect(next.queue.map(i => i.number)).toEqual([29, 43, 44, 50])
  // Last closed still names its own epic, asked for it.
  expect(next.lastClosed?.epic).toBe(30)
  expect(calls.filter(c => c.startsWith('parent'))).toEqual(['parent 61', 'parent 41'])
})

test('where you work widens through each parent up the tree where children nest', async () => {
  const t = fake({ ...WORK, parents: { 41: 30, 30: 12 }, members: { 30: [43], 12: [30, 44] }, nested: true })
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  const next = await known.whatsNext(ALL, NOW)
  expect([next.next?.number, ...next.queue.map(i => i.number)]).toEqual([43, 44, 29, 37, 50])
  expect(next.scopes[43]).toEqual({ kind: 'epic', number: 30 })
  expect(next.scopes[44]).toEqual({ kind: 'epic', number: 12 })
})

test('where you work: without children that nest, an epic above an epic is not followed', async () => {
  const calls: string[] = []
  const t = fake({ ...WORK, parents: { 41: 30, 30: 12 } }, calls)
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  await known.whatsNext(ALL, NOW)
  expect(calls.filter(c => c.startsWith('parent'))).toEqual(['parent 41'])
})

test('where you work, per milestone filter setting: the last closed within it, asked once; All also answers for its milestone', async () => {
  const calls: string[] = []
  const t = fake({ ...WORK, lastClosed: { all: LAST, none: null } }, calls)
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  await known.whatsNext(ALL, NOW)
  const inV1 = await known.whatsNext(ofMilestone('v1'), NOW)
  expect(inV1.next?.number).toBe(43)
  expect(inV1.lastClosed?.number).toBe(41)
  const none = await known.whatsNext(NONE, NOW)
  expect(none.next?.number).toBe(50)
  expect(none.lastClosed).toBe(null)
  // All's answer is v1's too; No milestone is asked for itself.
  expect(calls.filter(c => c.startsWith('last closed'))).toEqual(['last closed all', 'last closed none'])
})

test('where you work: with nothing in progress and nothing closed, the order is the keys over the whole filter', async () => {
  const t = fake({ ...WORK, lastClosed: {} })
  const known = await load(t, { me: 'alice', deps: false, epics: false })
  const next = await known.whatsNext(ALL, NOW)
  expect([next.next?.number, ...next.queue.map(i => i.number)]).toEqual([50, 29, 37, 43, 44])
  expect(next.scopes).toEqual({})
  expect(next.lastClosed).toBe(null)
})

test('where you work: unblocks counts what the walk found waiting, and orders the next look', async () => {
  const t = fake({ ...WORK, lastClosed: {}, blockers: { 50: [37] } })
  const known = await load(t, { me: 'alice', epics: false })
  const first = await known.whatsNext(ALL, NOW)
  expect(first.next?.number).toBe(29)
  expect(first.unblocks).toEqual({ 37: 1 })
  // Now known: #37 unblocks #50, so it goes before the older #29.
  const again = await known.whatsNext(ALL, NOW)
  expect(again.next?.number).toBe(37)
})

test('the milestone filter starts where you work: your issue in progress updated last, else the one you closed last, else the first milestone', async () => {
  const options = [
    { filter: ofMilestone('v1'), label: 'v1' },
    { filter: ofMilestone('v2'), label: 'v2' },
    { filter: NONE, label: 'None' },
    { filter: ALL, label: 'All' },
  ]
  const t = fake({ ...WORK, mine: [{ ...row(61, '2026-09-02T00:00:00Z', 'v2'), updated: '2026-10-08T00:00:00Z' }] })
  expect(await (await load(t, { me: 'alice', epics: false })).startingFilter(options)).toEqual(ofMilestone('v2'))

  const closedOnly = await load(fake(WORK), { me: 'alice', epics: false })
  expect(await closedOnly.startingFilter(options)).toEqual(ofMilestone('v1'))
  // Its milestone not offered: the first milestone offered, else All.
  expect(await closedOnly.startingFilter(options.slice(1))).toEqual(ofMilestone('v2'))
  expect(await closedOnly.startingFilter([{ filter: ALL, label: 'All' }])).toEqual(ALL)
  // Nothing to start from: the first milestone offered.
  const empty = await load(fake({ ...WORK, lastClosed: {} }), { me: 'alice', epics: false })
  expect(await empty.startingFilter(options.slice(1))).toEqual(ofMilestone('v2'))
})

// A request that fails says nothing: what it would have said is unknown,
// in Epics, in a milestone and under a row alike, and the rest is as it is.
const SPLIT: Fake = {
  open: [free(row(29, '2026-10-01T00:00:00Z', 'v1')), free(row(31, '2026-10-02T00:00:00Z', 'v1'))],
  epics: [
    { number: 29, title: 'Issue 29', state: 'open', milestone: 'v1', due: null },
    { number: 31, title: 'Issue 31', state: 'open', milestone: 'v1', due: null },
  ],
  children: { 31: [child(40), child(41, { state: 'closed' })] },
  failingChildren: [29],
}

test("Epics: an epic whose children request fails has them unknown, the other epics as they are", async () => {
  const known = await load(fake(SPLIT))
  const { groups } = await known.epics(ALL)
  expect(groups[0]?.epics.map(e => [e.number, e.children?.map(c => c.number) ?? null])).toEqual([
    [29, null],
    [31, [40, 41]],
  ])
})

test("a milestone: an epic whose children request fails has them unknown, the milestone's issues as they are", async () => {
  const known = await load(fake(SPLIT))
  const issues = await known.milestone('v1')
  expect(issues?.map(c => [c.number, c.children?.map(x => x.number) ?? null])).toEqual([
    [29, null],
    [31, [40, 41]],
  ])
})

test('under a row: children whose request fails are unknown, asked once, as in the issue detail', async () => {
  const calls: string[] = []
  const known = await load(fake(SPLIT, calls))
  // Epic #31 holds epic #29, both unfolded: #29's children are asked.
  const top = { number: 31, title: 'Issue 31', state: 'open' as const, due: null, children: [child(29), child(40)].map(c => childOf(c, 'alice')) }
  const kids = await known.grow([[top]], new Set([29, 31]))
  expect(kids[29]).toBe(null)
  expect(await known.children(29)).toBe(null)
  expect(calls.filter(c => c.startsWith('children 29'))).toHaveLength(1)
})
