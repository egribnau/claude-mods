import type { Epic, EpicChild, EpicGroup, IssueDetail, IssueRow } from '../types'
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

// The issues What's Next changed lately, by repo, each as it was read again
// right after the change, with when. A forge's lists may lag a change (GitHub's
// do, by a few seconds), while the issue itself is up to date at once: for
// CHANGE_MS the lists show these as the change left them.
const CHANGE_MS = 30_000
const changedByRepo = new Map<string, Map<number, { issue: IssueDetail; at: number }>>()

// Issue `issue` of repo `repo` (host/owner/name), just changed at `now`.
export function noteChange(repo: string, issue: IssueDetail, now: number) {
  let changed = changedByRepo.get(repo)
  if (!changed) changedByRepo.set(repo, (changed = new Map()))
  changed.set(issue.number, { issue, at: now })
}

// The issues of `repo` changed within CHANGE_MS of `now`; older ones are forgotten.
export function changesSince(repo: string, now: number): IssueDetail[] {
  const changed = changedByRepo.get(repo)
  if (!changed) return []
  for (const [n, c] of changed) if (now - c.at > CHANGE_MS) changed.delete(n)
  return [...changed.values()].map(c => c.issue)
}

const toRow = (i: IssueDetail): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: i.labels,
  created: i.created,
  url: i.url,
  body: i.body,
})

// Asks the tracker for what the panes show: the open milestones, your open
// issues, the repo's open issues, and the epics unless `epics` is off. What
// failed is named, for the pane that shows it. `changes`: issues changed
// lately, which count as they are there, over what the lists say: open and
// assigned to `me` is yours, open and assigned to nobody is free.
export async function loadRepo(
  t: Tracker,
  epics: boolean,
  changes: IssueDetail[] = [],
  me: string | null = null,
): Promise<{ memory: Memory; issuesError: string | null; epicsError: string | null }> {
  const milestones = await t.milestones()
  let mine: IssueRow[] = []
  let free: IssueRow[] = []
  let issuesError: string | null = null
  try {
    const changed = new Set(changes.map(i => i.number))
    const open = changes.filter(i => i.state === 'open')
    mine = [
      ...(await t.mine()).filter(i => !changed.has(i.number)),
      ...open.filter(i => me !== null && i.assignees.includes(me)).map(toRow),
    ].sort(oldestFirst)
    const yours = new Set(mine.map(i => i.number))
    free = [
      ...(await t.open())
        .filter(i => !changed.has(i.number) && !yours.has(i.number) && i.assignees.length === 0)
        .map(({ assignees: _, ...row }) => row),
      ...open.filter(i => i.assignees.length === 0).map(toRow),
    ].sort(oldestFirst)
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
// in it, walked oldest first, the first with no open blockers is Next, and
// the Queue after it is checked too, up to its limit. A tracker without
// dependencies is not asked for blockers, so its Queue is only limited; nor
// is one that would not say for an issue (dependencies off without the
// setup check knowing, an error), until the next Refresh.
export async function whatsNext(t: Tracker, known: Memory, pick: string, deps: boolean) {
  const inProgress = known.mine.filter(i => inPick(pick, i.milestone))
  const free = known.free.filter(i => inPick(pick, i.milestone))
  const { next, queue, blocked, more } = await pickNext(free, async n => {
    if (!deps) return null
    if (known.blockers.has(n)) return known.blockers.get(n) ?? null
    if ([...known.blockers.values()].includes(null)) return null
    const open = await t.blockers(n)
    known.blockers.set(n, open)
    return open
  })
  return { inProgress, next, queue, blocked, more }
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
