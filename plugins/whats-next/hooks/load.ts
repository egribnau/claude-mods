import type { Epic, EpicChild, EpicGroup, IssueDetail, IssueRow, MilestoneIssue } from '../types'
import { groupsFor, type MilestoneRow } from './epics'
import { pickNext } from './next'
import { message, type EpicRow, type OpenIssue, type Tracker } from './tracker'

// What is remembered of a repo until the next Refresh or /next, so the picker
// can switch without asking the tracker again: its open milestones, your
// open issues, the free ones and those assigned to others (`listed`: whether
// the lists answered), the blockers checked so far, the epics, and the
// children of each epic loaded so far.
export type Memory = {
  milestones: MilestoneRow[]
  closedMilestones: MilestoneRow[]
  mine: IssueRow[]
  free: IssueRow[]
  taken: OpenIssue[]
  listed: boolean
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
  const closedMilestones = await t.closedMilestones(3)
  let mine: IssueRow[] = []
  let free: IssueRow[] = []
  let taken: OpenIssue[] = []
  let issuesError: string | null = null
  try {
    const changed = new Set(changes.map(i => i.number))
    const open = changes.filter(i => i.state === 'open')
    mine = [
      ...(await t.mine()).filter(i => !changed.has(i.number)),
      ...open.filter(i => me !== null && i.assignees.includes(me)).map(toRow),
    ].sort(oldestFirst)
    const yours = new Set(mine.map(i => i.number))
    const listed = (await t.open()).filter(i => !changed.has(i.number) && !yours.has(i.number))
    free = [
      ...listed.filter(i => i.assignees.length === 0).map(({ assignees: _, ...row }) => row),
      ...open.filter(i => i.assignees.length === 0).map(toRow),
    ].sort(oldestFirst)
    taken = [
      ...listed.filter(i => i.assignees.length > 0),
      ...open
        .filter(i => i.assignees.length > 0 && !(me !== null && i.assignees.includes(me)))
        .map(i => ({ ...toRow(i), assignees: i.assignees })),
    ]
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
    memory: {
      milestones,
      closedMilestones,
      mine,
      free,
      taken,
      listed: issuesError === null,
      blockers: new Map(),
      epics: found,
      children: new Map(),
    },
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
  const { next, queue, blocked, more } = await pickNext(free, blockersOf(t, known, deps))
  return { inProgress, next, queue, blocked, more }
}

// The open issues issue `n` waits on, asked of the tracker once and
// remembered; null without dependencies, or once the tracker would not say.
const blockersOf = (t: Tracker, known: Memory, deps: boolean) => async (n: number) => {
  if (!deps) return null
  if (known.blockers.has(n)) return known.blockers.get(n) ?? null
  if ([...known.blockers.values()].includes(null)) return null
  const open = await t.blockers(n)
  known.blockers.set(n, open)
  return open
}

// The open issues of milestone `title`, as epic children are: yours, free
// and someone else's, each not yours checked for blockers as What's next
// checks its own, by number. An open epic among them carries its children,
// asked once and shared with Epics, which never count as its blockers.
// Its closed epics come last, for a closed milestone to show. null when the
// issues could not be listed.
export async function milestoneIssues(
  t: Tracker,
  known: Memory,
  title: string,
  me: string | null,
  deps: boolean,
): Promise<MilestoneIssue[] | null> {
  if (!known.listed) return null
  const epics = new Set(known.epics.filter(e => e.state === 'open').map(e => e.number))
  const ask = blockersOf(t, known, deps)
  const all = [
    ...known.mine.map(i => ({ i, assignees: me !== null ? [me] : [], mine: true })),
    ...known.free.map(i => ({ i, assignees: [] as string[], mine: false })),
    ...known.taken.map(i => ({ i, assignees: i.assignees, mine: false })),
  ]
    .filter(x => x.i.milestone === title)
    .sort((a, b) => a.i.number - b.i.number)
  const out: MilestoneIssue[] = []
  for (const { i, assignees, mine } of all) {
    const epic = epics.has(i.number)
    if (epic && !known.children.has(i.number)) known.children.set(i.number, await t.children(i.number, me))
    const children = epic ? (known.children.get(i.number) ?? null) : undefined
    const own = new Set((children ?? []).map(c => c.number))
    const blockedBy = mine ? [] : ((await ask(i.number)) ?? []).filter(n => !own.has(n))
    out.push({
      ...(epic ? { children } : {}),
      number: i.number,
      title: i.title,
      state: 'open',
      assignees,
      mine,
      blocked: blockedBy.length > 0,
      labels: i.labels,
      milestone: i.milestone,
      created: i.created,
      blockedBy,
    })
  }
  for (const e of known.epics.filter(e => e.state === 'closed' && e.milestone === title).sort((a, b) => a.number - b.number)) {
    out.push({
      number: e.number,
      title: e.title,
      state: 'closed',
      assignees: [],
      mine: false,
      blocked: false,
      labels: [],
      milestone: title,
      created: '',
      blockedBy: [],
      children: null,
    })
  }
  return out
}

// What there is for you in milestone `title`, from what is known without
// asking the tracker: yours from the lists; free, someone else's and blocked
// count only once `checked`, when every issue in it that is not yours was
// checked for blockers (or none can be: dependencies off, or the tracker
// would not say). Epics are left out. null when the issues could not be listed.
export function milestoneKnown(
  known: Memory,
  title: string,
  deps: boolean,
): { checked: boolean; mine: number; free: number; taken: number; blocked: number } | null {
  if (!known.listed) return null
  const epics = new Set(known.epics.filter(e => e.state === 'open').map(e => e.number))
  const inIt = <T extends { number: number; milestone: string | null }>(l: T[]) => l.filter(i => i.milestone === title && !epics.has(i.number))
  const others = [...inIt(known.free).map(i => ({ i, taken: false })), ...inIt(known.taken).map(i => ({ i, taken: true }))]
  const noneAsked = !deps || [...known.blockers.values()].includes(null)
  const blockedNow = (n: number) => !noneAsked && (known.blockers.get(n) ?? []).length > 0
  const blocked = others.filter(o => blockedNow(o.i.number)).length
  return {
    checked: noneAsked || others.every(o => known.blockers.has(o.i.number)),
    mine: inIt(known.mine).length,
    free: others.filter(o => !o.taken && !blockedNow(o.i.number)).length,
    taken: others.filter(o => o.taken && !blockedNow(o.i.number)).length,
    blocked,
  }
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
