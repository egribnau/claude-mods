import type { FilterShown, MilestoneFilter } from '../types'
import { dueFirst, type MilestoneRow } from './epics'

// The milestone filter (docs/whats-next/TERMINOLOGY.md): what What's next
// and Epics show, set to a milestone, None (the issues without one) or All.
// No other place knows how it is written down.

export const ALL: MilestoneFilter = { kind: 'all' }
export const NONE: MilestoneFilter = { kind: 'none' }

// The filter set to milestone `title`, or to None for no milestone.
export const ofMilestone = (title: string | null): MilestoneFilter => (title === null ? NONE : { kind: 'milestone', title })

// Whether an issue with milestone `milestone` is in what `f` is set to.
export const holds = (f: MilestoneFilter, milestone: string | null) =>
  f.kind === 'all' || (f.kind === 'none' ? milestone === null : f.title === milestone)

// Whether `a` is set to what `b` is. Anything that is no filter, as a
// session's state from older code holds, is set to nothing.
export function sameFilter(a: unknown, b: MilestoneFilter): boolean {
  if (typeof a !== 'object' || a === null) return false
  const f = a as Partial<{ kind: string; title: string }>
  return f.kind === b.kind && (b.kind !== 'milestone' || f.title === b.title)
}

// Its words on the filter's button: the milestone's title, None or All.
export const filterLabel = (f: MilestoneFilter) => (f.kind === 'milestone' ? f.title : f.kind === 'none' ? 'None' : 'All')

// Its word in a sentence, where None reads as nothing: no milestone.
export const filterWord = (f: MilestoneFilter) => (f.kind === 'none' ? 'no milestone' : filterLabel(f))

// What it is set to after a sentence's words: " in v1.2", " without a
// milestone", or nothing for All.
export const within = (f: MilestoneFilter) => (f.kind === 'all' ? '' : f.kind === 'none' ? ' without a milestone' : ` in ${f.title}`)

// One text per setting, for a button's key and for what is remembered per setting.
export const filterKey = (f: MilestoneFilter) => (f.kind === 'milestone' ? `m:${f.title}` : f.kind)

export type FilterOption = FilterShown['options'][number]

// What the milestone filter offers: each open milestone that has an open
// issue or an epic, due first, then None when some has none, then All.
export function filterOptions(milestones: readonly MilestoneRow[], items: readonly { milestone: string | null }[]): FilterOption[] {
  const options: FilterOption[] = dueFirst(milestones)
    .filter(m => items.some(e => e.milestone === m.title))
    .map(m => ({ filter: ofMilestone(m.title), label: m.title, due: m.due }))
  if (items.some(e => e.milestone === null)) options.push({ filter: NONE, label: filterLabel(NONE) })
  options.push({ filter: ALL, label: filterLabel(ALL) })
  return options
}
