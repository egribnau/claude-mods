import type { Epic, EpicChild, EpicGroup, IssueRow } from '../types'
import { groupsFor, type MilestoneRow } from './epics'
import { pickNext } from './next'
import { message, type EpicRow, type Tracker } from './tracker'

// What is remembered of a repo until the next Refresh or /next, so the picker
// can switch without asking the tracker again: its open milestones, your
// open issues and the free ones, the blockers checked so far, the epics,
// and the children of each epic loaded so far.
export type Memory = {
  milestones: MilestoneRow[]
  mine: IssueRow[]
  free: IssueRow[]
  blockers: Map<number, number[] | null>
  epics: EpicRow[]
  children: Map<number, EpicChild[] | null>
}

const oldestFirst = (a: IssueRow, b: IssueRow) => a.created.localeCompare(b.created)

// Asks the tracker for what the panes show: the open milestones, your open
// issues, the repo's open issues, and the epics unless `epics` is off. What
// failed is named, for the pane that shows it.
export async function loadRepo(
  t: Tracker,
  epics: boolean,
): Promise<{ memory: Memory; issuesError: string | null; epicsError: string | null }> {
  const milestones = await t.milestones()
  let mine: IssueRow[] = []
  let free: IssueRow[] = []
  let issuesError: string | null = null
  try {
    mine = (await t.mine()).sort(oldestFirst)
    const yours = new Set(mine.map(i => i.number))
    free = (await t.open())
      .filter(i => !yours.has(i.number) && i.assignees.length === 0)
      .map(({ assignees: _, ...row }) => row)
      .sort(oldestFirst)
  } catch (err) {
    issuesError = message(err)
  }
  let found: EpicRow[] = []
  let epicsError: string | null = null
  if (epics) {
    try {
      found = await t.epics()
    } catch (err) {
      epicsError = message(err)
    }
  }
  return {
    memory: { milestones, mine, free, blockers: new Map(), epics: found, children: new Map() },
    issuesError,
    epicsError,
  }
}

// Whether an issue's milestone is in what the picker picked.
export const inPick = (pick: string, milestone: string | null) =>
  pick === 'all' || (pick === 'none' ? milestone === null : pick === `m:${milestone}`)

// What's next within the pick: yours in it are In progress; of the free ones
// in it, walked oldest first, the first with no open blockers is Next. A
// tracker without dependencies is not asked for blockers.
export async function whatsNext(t: Tracker, known: Memory, pick: string, deps: boolean) {
  const inProgress = known.mine.filter(i => inPick(pick, i.milestone))
  const free = known.free.filter(i => inPick(pick, i.milestone))
  const { next, queue, blocked } = await pickNext(free, async n => {
    if (!deps) return null
    if (known.blockers.has(n)) return known.blockers.get(n) ?? null
    const open = await t.blockers(n)
    known.blockers.set(n, open)
    return open
  })
  return { inProgress, next, queue, blocked }
}

// The epics within the pick, by milestone, each open one with its children,
// asked of the tracker once and remembered. `me` makes a child yours.
export async function epicGroups(t: Tracker, known: Memory, pick: string, me: string | null): Promise<EpicGroup[]> {
  const loadOne = async (i: EpicRow): Promise<Epic> => {
    const { number, title, state } = i
    if (state === 'closed') return { number, title, state, children: null }
    if (!known.children.has(number)) known.children.set(number, await t.children(number, me))
    return { number, title, state, children: known.children.get(number) ?? null }
  }
  return Promise.all(
    groupsFor(pick, known.milestones, known.epics).map(async g => {
      const shown = await Promise.all(g.epics.map(loadOne))
      shown.sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0) || a.number - b.number)
      const m = g.milestone
      return { title: m?.title ?? null, due: m?.due ?? null, closed: m?.closed ?? 0, total: m?.total ?? 0, epics: shown }
    }),
  )
}
