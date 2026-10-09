import { expect, test } from 'claude-code/testing'

import { epicGroups, loadRepo, whatsNext } from '../hooks/load'
import type { EpicRow, OpenIssue, Tracker } from '../hooks/tracker'
import type { EpicChild, IssueRow } from '../types'

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
    tokensUrl: 'fake:tokens',
    check: async () => ({ version: 'fake', setup: { kind: 'checking' } }),
    milestones: async () => {
      calls.push('milestones')
      return [{ title: 'v1', due: '2026-11-01T00:00:00Z', closed: 1, total: 4 }]
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
  // Walked until Next, and remembered: a second look asks nothing.
  expect(calls.filter(c => c.startsWith('blockers'))).toEqual(['blockers 33', 'blockers 29'])
  await whatsNext(t, memory, 'all', true)
  expect(calls.filter(c => c.startsWith('blockers'))).toHaveLength(2)
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
