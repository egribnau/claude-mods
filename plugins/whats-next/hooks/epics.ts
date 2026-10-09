import type { Epic, EpicChild } from '../types'

// Where an open child stands for you: yours, up for grabs, someone else's,
// or blocked. Yours wins over blocked: you know what holds it up.
export type Standing = 'mine' | 'free' | 'taken' | 'blocked'

export function standing(c: EpicChild): Standing {
  if (c.mine) return 'mine'
  if (c.blocked) return 'blocked'
  return c.assignees.length > 0 ? 'taken' : 'free'
}

const ORDER: Record<Standing, number> = { mine: 0, free: 1, taken: 2, blocked: 3 }

// The open children in the order the pane lists them: yours, up for grabs,
// someone else's, blocked; each by number.
export function openChildren(children: readonly EpicChild[]): EpicChild[] {
  return children
    .filter(c => c.state === 'open')
    .sort((a, b) => ORDER[standing(a)] - ORDER[standing(b)] || a.number - b.number)
}

export type Tally = { closed: number; total: number } & Record<Standing, number>

export function tally(children: readonly EpicChild[]): Tally {
  const t: Tally = { closed: 0, total: children.length, mine: 0, free: 0, taken: 0, blocked: 0 }
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
// done but still open. Each part has its colour.
export function summary(e: Epic): { text: string; color?: string }[] {
  if (e.children === null) return [{ text: 'children unknown' }]
  const t = tally(e.children)
  if (t.total === 0) return [{ text: 'no children' }]
  if (t.closed === t.total) return [{ text: 'all children closed', color: 'warning' }]
  const parts: { text: string; color?: string }[] = []
  if (t.mine > 0) parts.push({ text: `${t.mine} yours`, color: 'success' })
  if (t.blocked > 0) parts.push({ text: `${t.blocked} blocked` })
  if (t.free > 0) parts.push({ text: `${t.free} up for grabs` })
  if (parts.length === 0) parts.push({ text: `${t.taken} with others` })
  return parts
}

export type MilestoneRow = { title: string; due: string | null; closed: number; total: number }

// Open milestones, due first; one without a due date after those with one.
const dueFirst = (milestones: readonly MilestoneRow[]) =>
  [...milestones].sort(
    (a, b) => (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0) || (a.due ?? '').localeCompare(b.due ?? '') || a.title.localeCompare(b.title),
  )

// What the picker offers: each open milestone that has an open issue or an
// epic, due first, then No milestone when some has none, then All. The panes
// start on the first milestone, or on All when there is none.
export function pickerOptions(
  milestones: readonly MilestoneRow[],
  epics: readonly { milestone: string | null }[],
): { value: string; label: string; due?: string | null }[] {
  const options: { value: string; label: string; due?: string | null }[] = dueFirst(milestones)
    .filter(m => epics.some(e => e.milestone === m.title))
    .map(m => ({ value: `m:${m.title}`, label: m.title, due: m.due }))
  if (epics.some(e => e.milestone === null)) options.push({ value: 'none', label: 'No milestone' })
  options.push({ value: 'all', label: 'All' })
  return options
}

// The groups a pick shows: one milestone's epics, those without a milestone,
// or for All each open milestone's in picker order and No milestone last.
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
