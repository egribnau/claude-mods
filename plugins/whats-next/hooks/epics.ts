import type { Epic, EpicChild } from '../types'

// How an open child stands for you: yours, available, with others, or
// blocked. Yours wins over blocked: you know what holds it up.
export type Standing = 'yours' | 'available' | 'withOthers' | 'blocked'

export function standing(c: Pick<EpicChild, 'mine' | 'blocked' | 'assignees'>): Standing {
  if (c.mine) return 'yours'
  if (c.blocked) return 'blocked'
  return c.assignees.length > 0 ? 'withOthers' : 'available'
}

// The mark of a row (docs/whats-next/DRAWING-issue.md, Marks): its shape
// says whether it folds, its colour how it stands for you. `st` null: a row
// with no standing, an epic or milestone at the top of a tree; `closed`
// draws it grey.
export type Mark = { glyph: string; color?: string; dim?: boolean }
export function markOf(st: Standing | null, fold: Folding | null, closed = false): Mark {
  if (fold === 'shown above') return { glyph: '↑', dim: true }
  const look = closed ? { color: 'inactive' } : st === 'yours' ? { color: 'success' } : st === 'blocked' ? { dim: true } : {}
  if (fold) return { glyph: fold === 'unfolded' ? '⊖' : '⊕', ...look }
  const glyph = st === 'yours' ? '●' : st === 'blocked' ? '⊘' : st === 'withOthers' ? '◌' : st === 'available' ? '○' : ' '
  return { glyph, ...look }
}

const ORDER: Record<Standing, number> = { yours: 0, available: 1, withOthers: 2, blocked: 3 }

// The open children in the order the pane lists them: yours, available,
// with others, blocked; each by number.
export function openChildren(children: readonly EpicChild[]): EpicChild[] {
  return children
    .filter(c => c.state === 'open')
    .sort((a, b) => ORDER[standing(a)] - ORDER[standing(b)] || a.number - b.number)
}

export type Tally = { closed: number; total: number } & Record<Standing, number>

export function tally(children: readonly EpicChild[]): Tally {
  const t: Tally = { closed: 0, total: children.length, yours: 0, available: 0, withOthers: 0, blocked: 0 }
  for (const c of children) {
    if (c.state === 'closed') t.closed++
    else t[standing(c)]++
  }
  return t
}

// How far an epic is, as `width` cells: filled for its closed children.
export function bar(closed: number, total: number, width = 8): { filled: string; empty: string } {
  const n = total === 0 ? 0 : Math.round((closed / total) * width)
  return { filled: '▰'.repeat(n), empty: '▱'.repeat(width - n) }
}

// The line under a folded epic: what there is for you in it, or that it is
// done but still open (all closed, amber). Each part has its colour.
export function summary(e: Epic): { text: string; color?: string }[] {
  if (e.children === null) return [{ text: 'children unknown' }]
  const t = tally(e.children)
  if (t.total === 0) return [{ text: 'no children' }]
  if (t.closed === t.total) return [{ text: 'all closed', color: 'warning' }]
  return forYou(t)
}

// What there is for you among open issues (DRAWING-issue.md, The for-you
// line): each standing's mark and its count, in the order the rows are
// listed, `● 2 · ○ 2 · ◌ 3 · ⊘ 1`; yours green, the rest dim. A standing
// with none is left out.
export function forYou(t: Tally): { text: string; color?: string }[] {
  return (Object.keys(ORDER) as Standing[])
    .filter(st => t[st] > 0)
    .map(st => ({ text: `${markOf(st, null).glyph} ${t[st]}`, ...(st === 'yours' && { color: 'success' }) }))
}

// The open epics in view that show at the top of their group: each one no
// open epic in view holds as a child. An epic in a loop of epics, held only
// from within the loop, would show nowhere: the lowest such number shows at
// the top, and what it reaches under it.
export function roots(open: readonly { number: number; children: readonly EpicChild[] | null }[]): Set<number> {
  const inView = new Map(open.map(e => [e.number, e]))
  const under = (n: number) =>
    (inView.get(n)?.children ?? []).filter(c => c.state === 'open' && inView.has(c.number)).map(c => c.number)
  const held = new Set(open.flatMap(e => under(e.number)))
  const top = new Set(open.filter(e => !held.has(e.number)).map(e => e.number))
  const reached = new Set<number>()
  const walk = (n: number) => {
    if (reached.has(n)) return
    reached.add(n)
    under(n).forEach(walk)
  }
  top.forEach(walk)
  for (const n of [...inView.keys()].sort((a, b) => a - b)) {
    if (reached.has(n)) continue
    top.add(n)
    walk(n)
  }
  return top
}

// A milestone's issues as its tree starts: its open epics that no other open
// epic in it holds, the issues no open epic in it holds, and its closed epics.
export function inMilestone<T extends EpicChild & { children?: EpicChild[] | null }>(
  issues: readonly T[],
): { epics: T[]; plain: T[]; closedEpics: T[] } {
  const open = issues.filter(i => i.children !== undefined && i.state === 'open')
  const top = roots(open.map(e => ({ number: e.number, children: e.children ?? null })))
  const held = new Set(open.flatMap(e => (e.children ?? []).map(c => c.number)))
  return {
    epics: open.filter(e => top.has(e.number)),
    plain: issues.filter(i => i.children === undefined && !held.has(i.number)),
    closedEpics: issues.filter(i => i.children !== undefined && i.state === 'closed'),
  }
}

// How a row with children is folded: its mark, or shown above, where an
// issue already in the tree shows again and does not unfold.
export type Folding = 'folded' | 'unfolded' | 'shown above'

// One line under an unfolded issue, `depth` levels below the epic at the
// top: an open child, with its fold and its count when it has children;
// how many children are closed; or that its children are unknown, none, or
// still loading.
export type TreeLine =
  | { kind: 'child'; child: EpicChild; depth: number; fold: Folding | null; count: { closed: number; total: number } | null }
  | { kind: 'closed'; depth: number; closed: number }
  | { kind: 'unknown' | 'none' | 'loading'; depth: number }

// The tree under each open epic at the top, in the order the pane draws
// them: the lines under it, none while it is folded. `kids(n)` is what is
// loaded of issue n's children: undefined when not yet. An issue has
// children when the forge counts sub-issues for it, else when it is an
// epic (`epics`) not known to have none. `missing`: the issues whose
// children are needed and not loaded: those unfolded, and those drawn
// folded whose count is not known, one level ahead.
export function tree(
  top: readonly Epic[],
  kids: (n: number) => readonly EpicChild[] | null | undefined,
  unfolded: ReadonlySet<number>,
  epics: ReadonlySet<number>,
): { lines: Map<number, TreeLine[]>; missing: number[] } {
  const seen = new Set<number>()
  const missing = new Set<number>()
  const under = (children: readonly EpicChild[] | null | undefined, depth: number, n: number): TreeLine[] => {
    if (children === undefined) {
      missing.add(n)
      return [{ kind: 'loading', depth }]
    }
    if (children === null) return [{ kind: 'unknown', depth }]
    if (children.length === 0) return [{ kind: 'none', depth }]
    const lines: TreeLine[] = []
    // A child's own children never count as what blocks it.
    const unblocked = children.map(c => {
      const own = new Set((kids(c.number) ?? []).map(k => k.number))
      if (own.size === 0 || !c.blockedBy.some(n => own.has(n))) return c
      const blockedBy = c.blockedBy.filter(n => !own.has(n))
      return { ...c, blockedBy, blocked: blockedBy.length > 0 }
    })
    for (const c of openChildren(unblocked)) {
      const own = kids(c.number)
      const has = c.subIssues ? c.subIssues.total > 0 : epics.has(c.number) && own?.length !== 0
      if (!has) {
        seen.add(c.number)
        lines.push({ kind: 'child', child: c, depth, fold: null, count: null })
        continue
      }
      if (!c.subIssues && own === undefined) missing.add(c.number)
      const t = own ? tally(own) : null
      const count = c.subIssues ?? (t ? { closed: t.closed, total: t.total } : null)
      if (seen.has(c.number)) {
        lines.push({ kind: 'child', child: c, depth, fold: 'shown above', count })
        continue
      }
      seen.add(c.number)
      const open = unfolded.has(c.number)
      lines.push({ kind: 'child', child: c, depth, fold: open ? 'unfolded' : 'folded', count })
      if (open) lines.push(...under(own, depth + 1, c.number))
    }
    const closed = children.filter(c => c.state === 'closed').length
    if (closed > 0) lines.push({ kind: 'closed', depth, closed })
    return lines
  }
  const lines = new Map<number, TreeLine[]>()
  for (const e of top) {
    seen.add(e.number)
    if (e.state === 'open') lines.set(e.number, unfolded.has(e.number) ? under(e.children, 0, e.number) : [])
  }
  return { lines, missing: [...missing] }
}

// A milestone, open or closed: its due date, how many of its issues are
// closed of all, and for Milestone detail its text, its page on the forge
// and when it closed (null when the forge does not say).
export type MilestoneRow = {
  title: string
  due: string | null
  closed: number
  total: number
  description?: string
  url?: string
  closedAt?: string | null
  // The forge's id for it, to close or reopen it; on GitLab, the group it
  // belongs to when it comes from a parent group.
  id?: number
  group?: string
}

// Open milestones, due first; one without a due date after those with one.
export const dueFirst = (milestones: readonly MilestoneRow[]) =>
  [...milestones].sort(
    (a, b) => (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0) || (a.due ?? '').localeCompare(b.due ?? '') || a.title.localeCompare(b.title),
  )

// What the milestone filter offers: each open milestone that has an open issue or an
// epic, due first, then None when some has none, then All. The panes
// start on the first milestone, or on All when there is none.
export function pickerOptions(
  milestones: readonly MilestoneRow[],
  epics: readonly { milestone: string | null }[],
): { value: string; label: string; due?: string | null }[] {
  const options: { value: string; label: string; due?: string | null }[] = dueFirst(milestones)
    .filter(m => epics.some(e => e.milestone === m.title))
    .map(m => ({ value: `m:${m.title}`, label: m.title, due: m.due }))
  if (epics.some(e => e.milestone === null)) options.push({ value: 'none', label: 'None' })
  options.push({ value: 'all', label: 'All' })
  return options
}

// The groups the milestone filter shows: one milestone's epics, those without a milestone,
// or for All each open milestone's in the milestone filter's order and No milestone last.
// Epics in a closed milestone show under none of them.
export function groupsFor<T extends { milestone: string | null }>(
  pick: string,
  milestones: readonly MilestoneRow[],
  epics: readonly T[],
): { milestone: MilestoneRow | null; epics: T[] }[] {
  const groups: { milestone: MilestoneRow | null; epics: T[] }[] = []
  for (const m of dueFirst(milestones)) {
    if (pick !== 'all' && pick !== `m:${m.title}`) continue
    const mine = epics.filter(e => e.milestone === m.title)
    if (mine.length > 0) groups.push({ milestone: m, epics: mine })
  }
  if (pick === 'all' || pick === 'none') {
    const none = epics.filter(e => e.milestone === null)
    if (none.length > 0) groups.push({ milestone: null, epics: none })
  }
  return groups
}
