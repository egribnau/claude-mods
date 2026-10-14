import type { Child, Epic, EpicGroup, Features, IssueDetail, IssueRow, LastClosed, MilestoneFilter, MilestoneIssue, Ref, Scope } from '../types'
import { blockersCount, childOf, groupsFor, isMine, roots, stands, tree, type MilestoneRow } from './epics'
import { ALL, filterKey, filterOptions, holds, ofMilestone, sameFilter, type FilterOption } from './filter'
import { order, pickNext, type Scoped } from './next'
import { message, type Closed, type EpicRow, type OpenIssue, type Tracker } from './tracker'

// What is remembered of a repo until the next Refresh or /next, so the
// milestone filter can switch without asking the tracker again: its open
// milestones, your open issues, the available ones and those with others
// (`listed`: whether the lists answered), the blockers checked so far, the
// epics, and the children of each epic loaded so far. For where you work:
// the issue you closed last within each milestone filter setting, the open
// epic each issue is a child of, and the children's numbers of each epic,
// as asked.
type Memory = {
  milestones: MilestoneRow[]
  closedMilestones: MilestoneRow[]
  mine: IssueRow[]
  free: IssueRow[]
  taken: OpenIssue[]
  listed: boolean
  blockers: Map<number, number[] | null>
  epics: EpicRow[]
  children: Map<number, Child[] | null>
  lastClosed: Map<string, Closed | null>
  parents: Map<number, number | null>
  members: Map<number, number[] | null>
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
  due: i.due,
  url: i.url,
  body: i.body,
  updated: i.updated,
})

// Your issues, the one updated last first.
const latestFirst = (l: readonly IssueRow[]) => [...l].sort((a, b) => b.updated.localeCompare(a.updated))

// What is known of a repo: built once per load, it asks the tracker the
// rest once and remembers it until the next Refresh or /next.
export type Known = Awaited<ReturnType<typeof loadRepo>>

// Asks tracker `t` for what the panes show: the open milestones, your open
// issues, the repo's open issues, and the epics unless `features` turns
// them off. A list that fails is named, for the pane that shows it. A
// lookup that fails, now or later, answers unknown, as the Tracker contract
// says. `me`: who you are, from the setup check. `changes`: issues changed
// lately, which count as they are there, over what the lists say: open and
// assigned to `me` is yours, open and assigned to nobody is free.
export async function loadRepo(t: Tracker, o: { me: string | null; features: Features; changes?: IssueDetail[] }) {
  const { me, features } = o
  // A setup check from older code may not say, which counts as on.
  const deps = features.deps !== false
  const milestones = await t.milestones()
  const closedMilestones = await t.closedMilestones(3)
  let mine: IssueRow[] = []
  let free: IssueRow[] = []
  let taken: OpenIssue[] = []
  let issuesError: string | null = null
  try {
    const changes = o.changes ?? []
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
  if (features.epics !== false) {
    try {
      found = await t.epics()
    } catch (err) {
      epicsError = message(err)
    }
  }
  const known: Memory = {
    milestones,
    closedMilestones,
    mine,
    free,
    taken,
    listed: issuesError === null,
    blockers: new Map(),
    epics: found,
    children: new Map(),
    lastClosed: new Map(),
    parents: new Map(),
    members: new Map(),
  }
  const openEpics = new Set(known.epics.filter(e => e.state === 'open').map(e => e.number))

  // The open issues issue `n` waits on, asked once and remembered; null
  // without dependencies, or once the tracker would not say.
  async function blockersOf(n: number): Promise<number[] | null> {
    if (!deps) return null
    if (known.blockers.has(n)) return known.blockers.get(n) ?? null
    if ([...known.blockers.values()].includes(null)) return null
    const open = await t.blockers(n).catch(() => null)
    known.blockers.set(n, open)
    return open
  }

  // The children of issue `n`, asked once and remembered, shared by every
  // pane and the issue detail; null when the forge would not say.
  async function kidsOf(n: number): Promise<Child[] | null> {
    if (!known.children.has(n)) known.children.set(n, await t.children(n).then(l => l && l.map(c => childOf(c, me)), () => null))
    return known.children.get(n) ?? null
  }

  // The issue assigned to you that closed last within `filter`, asked once
  // per setting and remembered. The one within All is also the last within
  // its own milestone.
  async function lastClosedIn(filter: MilestoneFilter): Promise<Closed | null> {
    const key = filterKey(filter)
    if (known.lastClosed.has(key)) return known.lastClosed.get(key) ?? null
    const within = filter.kind === 'milestone' ? known.milestones.find(m => m.title === filter.title) : filter.kind
    const found = within && me !== null ? await t.lastClosed(within, me).catch(() => null) : null
    known.lastClosed.set(key, found)
    if (filter.kind === 'all' && found) {
      const own = filterKey(ofMilestone(found.milestone))
      if (!known.lastClosed.has(own)) known.lastClosed.set(own, found)
    }
    return found
  }

  // The open epic issue `n` is a child of, asked once and remembered. Where
  // children do not nest, an epic is no child: an epic that depends on it
  // waits for it (README, Epics), and nothing is asked.
  async function parentOf(n: number): Promise<number | null> {
    if (!t.nested && known.epics.some(e => e.number === n)) return null
    if (!known.parents.has(n)) known.parents.set(n, await t.parentOf(n).catch(() => null))
    return known.parents.get(n) ?? null
  }

  // The epics above issue `n`, nearest first: its epic, and on a forge where
  // children nest, each parent up the tree, a loop stopped where it repeats.
  async function epicsAbove(n: number): Promise<number[]> {
    const chain: number[] = []
    for (let e = await parentOf(n); e !== null && !chain.includes(e) && e !== n; ) {
      chain.push(e)
      if (!t.nested) break
      e = await parentOf(e)
    }
    return chain
  }

  // The numbers of epic `n`'s children: from the children loaded, else
  // asked once and remembered.
  async function membersOf(n: number): Promise<number[] | null> {
    const loaded = known.children.get(n)
    if (loaded) return loaded.map(c => c.number)
    if (!known.members.has(n)) known.members.set(n, await t.members(n).catch(() => null))
    return known.members.get(n) ?? null
  }

  // Whether issue `i` waits on an open issue among `open`, its own children
  // left out: an epic on Forgejo depends on each of its children
  // (DRAWING-issue.md, Detail lines that name an issue). Its children are
  // asked for only when it is blocked without them left out.
  async function blockedOutside(i: { number: number; state: string; assignees: readonly string[] }, open: number[] | null): Promise<boolean> {
    const mine = isMine(i.assignees, me)
    const waits = (own: readonly number[]) => stands({ state: i.state, blockedBy: open ?? [] }, mine, own).blocked
    if (!waits([])) return false
    const children = known.epics.some(e => e.number === i.number) || t.nested ? ((await membersOf(i.number)) ?? []) : []
    return waits(children)
  }

  // The epics within `filter`, by milestone, each open one with its
  // children. An open epic not yours is asked what it waits on, as
  // Milestones asks, its own children left out (DRAWING-issue.md, The facts
  // line); dependencies off, nothing.
  async function epicGroups(filter: MilestoneFilter): Promise<EpicGroup[]> {
    const loadOne = async (i: EpicRow): Promise<Epic> => {
      const { number, title, state, due } = i
      const facts = { labels: i.labels ?? [], milestone: i.milestone, created: i.created ?? '' }
      if (state === 'closed') return { number, title, state, due, children: null, ...facts }
      const children = await kidsOf(number)
      const mine = isMine(i.assignees ?? [], me)
      const open = blockersCount(state, mine) ? await blockersOf(number) : null
      const { blockedBy } = stands({ state, blockedBy: open ?? [] }, mine, (children ?? []).map(c => c.number))
      return { number, title, state, due, children, ...facts, blockedBy }
    }
    return Promise.all(
      groupsFor(filter, known.milestones, known.epics).map(async g => {
        const shown = await Promise.all(g.epics.map(loadOne))
        shown.sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0) || a.number - b.number)
        const m = g.milestone
        return { title: m?.title ?? null, due: m?.due ?? null, closed: m?.closed ?? 0, total: m?.total ?? 0, epics: shown }
      }),
    )
  }

  return {
    // The tracker it asks: what the panes change goes to it too.
    tracker: t,
    // Who you are, from the setup check.
    me,
    // Why a list failed, for the pane that shows it; null when it answered.
    issuesError,
    epicsError,
    // Whether the open issues could be listed.
    listed: known.listed,
    // The open milestones, and the last three closed.
    milestones,
    closedMilestones,
    // The open epics, by number.
    openEpics: openEpics as ReadonlySet<number>,

    // Whether issue `n` is open and yours or available, as the lists hold it.
    listedOpen: (n: number) => [...known.mine, ...known.free].some(i => i.number === n),

    // What the milestone filter offers: the milestones of the open issues
    // and epics.
    options: (): FilterOption[] => filterOptions(known.milestones, [...known.mine, ...known.free, ...known.epics.filter(e => e.state === 'open')]),

    // Where the milestone filter starts on /next (docs/whats-next/ORDERING.md):
    // the milestone of your issue in progress updated last, else of the
    // issue you closed last in the repo, when `options` offer it; else the
    // first milestone offered, else All.
    async startingFilter(options: readonly FilterOption[]): Promise<MilestoneFilter> {
      const from = latestFirst(known.mine)[0] ?? (await lastClosedIn(ALL))
      const start = from ? options.find(x => sameFilter(x.filter, ofMilestone(from.milestone))) : undefined
      return (start ?? options.find(x => x.filter.kind === 'milestone'))?.filter ?? ALL
    },

    // What's next within `filter`: yours in it are In progress; the
    // available ones in it are taken in the order docs/whats-next/ORDERING.md
    // sets out, from where you work outward, and the first with no open
    // blockers is Next; the Queue after it is checked too, up to its limit.
    // A tracker without dependencies is not asked for blockers, so its Queue
    // is only limited; nor is one that would not say for an issue
    // (dependencies off without the setup check knowing, an error), until
    // the next Refresh.
    async whatsNext(filter: MilestoneFilter, now = 0) {
      const inProgress = known.mine.filter(i => holds(filter, i.milestone))
      const free = known.free.filter(i => holds(filter, i.milestone))
      const last = await lastClosedIn(filter)
      const from = latestFirst(inProgress)[0] ?? last
      const chain = from ? await epicsAbove(from.number) : []
      const scopes: Scoped[] = []
      for (const e of chain) {
        const kids = await membersOf(e)
        if (kids) scopes.push({ scope: { kind: 'epic', number: e }, holds: i => kids.includes(i.number) })
      }
      const ms = from?.milestone ?? null
      if (filter.kind === 'all' && ms !== null) scopes.push({ scope: { kind: 'milestone', title: ms }, holds: i => i.milestone === ms })
      // An epic that waits on its children is no issue they unblock: it is
      // their epic (DRAWING-issue.md, The facts line).
      const epicNumbers = new Set(known.epics.map(e => e.number))
      const waitingOn = (n: number) => [...known.blockers].filter(([w, by]) => !epicNumbers.has(w) && by?.includes(n)).length
      const unblocksOf = (i: IssueRow) => i.unblocks ?? waitingOn(i.number)
      const due = new Map(known.milestones.map(m => [m.title, m.due]))
      const ordered = order(free, { scopes, milestoneDue: title => due.get(title) ?? null, unblocks: unblocksOf, now })
      const { next, queue, blocked, more } = await pickNext(
        ordered.map(x => x.issue),
        blockersOf,
      )
      const scopeOf: Record<number, Scope> = {}
      for (const x of ordered) if (x.scope) scopeOf[x.issue.number] = x.scope
      // Counted after the walk, which may have found more that wait; for every
      // open issue known, as every pane's facts line says it.
      const unblocks: Record<number, number> = {}
      for (const i of [...known.mine, ...known.free, ...known.taken]) {
        const n = unblocksOf(i)
        if (n > 0) unblocks[i.number] = n
      }
      const lastClosed: LastClosed | null = last
        ? { ...last, epic: from === last ? (chain[0] ?? null) : await parentOf(last.number) }
        : null
      return { inProgress, next, queue, blocked, more, scopes: scopeOf, unblocks, lastClosed }
    },

    // The Epics pane as a tree: the groups of `filter` with only the epics
    // at the top of the tree in them, and the open epics shown under a
    // parent epic instead (`held`). An epic whose children the forge would
    // not say has them unknown; the rest draw as they are.
    async epics(filter: MilestoneFilter): Promise<{ groups: EpicGroup[]; held: Epic[] }> {
      const all = await epicGroups(filter)
      const open = all.flatMap(g => g.epics).filter(e => e.state === 'open')
      const top = roots(open)
      const groups = all
        .map(g => ({ ...g, epics: g.epics.filter(e => e.state === 'closed' || top.has(e.number)) }))
        .filter(g => g.epics.length > 0)
      return { groups, held: open.filter(e => !top.has(e.number)) }
    },

    // The open issues of milestone `title`, as epic children are: yours,
    // free and with others, each not yours checked for blockers as What's
    // next checks its own, by number. An open epic among them carries its
    // children, shared with Epics, which never count as its blockers. Its
    // closed epics come last, for a closed milestone to show. null when the
    // issues could not be listed.
    async milestone(title: string): Promise<MilestoneIssue[] | null> {
      if (!known.listed) return null
      const all = [
        ...known.mine.map(i => ({ i, assignees: me !== null ? [me] : [], mine: true })),
        ...known.free.map(i => ({ i, assignees: [] as string[], mine: false })),
        ...known.taken.map(i => ({ i, assignees: i.assignees, mine: false })),
      ]
        .filter(x => x.i.milestone === title)
        .sort((a, b) => a.i.number - b.i.number)
      const out: MilestoneIssue[] = []
      for (const { i, assignees, mine } of all) {
        const epic = openEpics.has(i.number)
        const children = epic ? await kidsOf(i.number) : undefined
        const open = blockersCount('open', mine) ? await blockersOf(i.number) : null
        const { blocked, blockedBy } = stands({ state: 'open', blockedBy: open ?? [] }, mine, (children ?? []).map(c => c.number))
        out.push({
          ...(epic ? { children } : {}),
          number: i.number,
          title: i.title,
          state: 'open',
          assignees,
          mine,
          blocked,
          labels: i.labels,
          milestone: i.milestone,
          created: i.created,
          due: i.due,
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
          due: e.due,
          blockedBy: [],
          children: null,
        })
      }
      return out
    },

    // What there is for you in milestone `title`, from what is known without
    // asking the tracker: yours from the lists; available, with others and
    // blocked count only once `checked`, when every issue in it that is not
    // yours was checked for blockers (or none can be: dependencies off, or
    // the tracker would not say). Epics are left out. null when the issues
    // could not be listed.
    forYou(title: string): { checked: boolean; yours: number; available: number; withOthers: number; blocked: number } | null {
      if (!known.listed) return null
      const inIt = <T extends { number: number; milestone: string | null }>(l: T[]) => l.filter(i => i.milestone === title && !openEpics.has(i.number))
      const others = [...inIt(known.free).map(i => ({ i, taken: false })), ...inIt(known.taken).map(i => ({ i, taken: true }))]
      const noneAsked = !deps || [...known.blockers.values()].includes(null)
      const blockedNow = (n: number) => !noneAsked && (known.blockers.get(n) ?? []).length > 0
      return {
        checked: noneAsked || others.every(x => known.blockers.has(x.i.number)),
        yours: inIt(known.mine).length,
        available: others.filter(x => !x.taken && !blockedNow(x.i.number)).length,
        withOthers: others.filter(x => x.taken && !blockedNow(x.i.number)).length,
        blocked: others.filter(x => blockedNow(x.i.number)).length,
      }
    },

    // Asks for the children each tree needs, as far as `unfolded` reaches,
    // each issue once. `trees`: the epics at the top of each tree a pane
    // draws (the Epics pane, a milestone). Returns every child list loaded
    // so far, by issue.
    async grow(trees: readonly (readonly Epic[])[], unfolded: ReadonlySet<number>): Promise<Record<number, Child[] | null>> {
      const kids = (n: number) => (known.children.has(n) ? (known.children.get(n) ?? null) : undefined)
      // Each round loads what the last one found missing.
      for (;;) {
        const missing = [...new Set(trees.flatMap(top => tree(top, kids, unfolded, openEpics).missing))]
        if (missing.length === 0) break
        await Promise.all(missing.map(kidsOf))
      }
      return Object.fromEntries(known.children)
    },

    // Everything the issue detail shows of issue `n`, as `features` allow.
    issue: (n: number): Promise<IssueDetail> => t.issue(n, features),

    // The issue `n` is a child of, as the issue detail names it: its
    // number, title and state, whether it is an epic, and what its mark
    // needs: whom it is assigned to and whether it is blocked. null for
    // none, or one that is not among the open issues and epics known.
    async parent(n: number): Promise<(Ref & { epic: boolean }) | null> {
      const p = await parentOf(n)
      if (p === null) return null
      const epic = known.epics.find(e => e.number === p)
      const issue = [...known.mine, ...known.free, ...known.taken].find(i => i.number === p)
      if (!epic && !issue) return null
      // Yours, with others, or nobody's: as the lists hold it.
      const taken = known.taken.find(i => i.number === p)
      const assignees = epic ? (epic.assignees ?? []) : taken ? taken.assignees : me && known.mine.some(i => i.number === p) ? [me] : []
      const state = epic ? epic.state : 'open'
      const open = blockersCount(state, isMine(assignees, me)) ? await blockersOf(p) : null
      const blocked = await blockedOutside({ number: p, state, assignees }, open)
      return { number: p, title: epic?.title ?? issue?.title ?? '', state, epic: epic !== undefined, assignees, blocked }
    },

    // The children of issue `n`, as the issue detail lists them: an epic's,
    // or on a forge where children nest any issue's. null for an issue that
    // holds none, or when the forge would not say.
    async children(n: number): Promise<Child[] | null> {
      if (!known.epics.some(e => e.number === n) && !t.nested) return null
      return kidsOf(n)
    },

    // Whether issue `i`, as the issue detail shows it, waits on an open issue
    // among `open`, its own children left out.
    blocked: blockedOutside,
  }
}
