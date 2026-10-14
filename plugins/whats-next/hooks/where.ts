import type { DetailFolds, Page, Where } from '../types'

// Where a pane is: one value per pane, and the steps from one to the next
// (docs/whats-next/DRAWING.md, A detail scrolls, The menu, The help page).
// Each step is a plain function of the value; nothing here reads the engine.
// The detail loaded from the forge is data, kept apart.

// How an issue's detail opens: Description folded, Comments open on the
// newest comment alone.
export const FOLDED: DetailFolds = { description: false, commentsShut: false, comments: null, whole: [] }

// A pane showing its list, at its top, its menu shut.
export const HERE: Where = { page: { kind: 'list' }, scroll: 0, menu: false, help: null }

// The issue the pane shows, null for a list or a milestone's detail.
export const issueOf = (w: Where): number | null => (w.page.kind === 'issue' ? w.page.number : null)

// The milestone the pane has open, in its detail or with an issue over it.
export const milestoneOf = (w: Where): string | null =>
  w.page.kind === 'milestone' ? w.page.title : w.page.kind === 'issue' ? w.page.milestone : null

// What is folded in the issue detail shown.
export const foldsOf = (w: Where): DetailFolds => (w.page.kind === 'issue' ? w.page.folds : FOLDED)

// A page shown as its rules say: at its top, its menu shut. Help is left as it is.
const fresh = (w: Where, page: Page): Where => ({ ...w, page, scroll: 0, menu: false })

// Issue `n` from the list, or from the milestone detail the pane has open.
export const open = (w: Where, n: number): Where =>
  fresh(w, { kind: 'issue', number: n, trail: [], folds: FOLDED, milestone: milestoneOf(w) })

// Issue `n`, reached from the issue shown through its Blocked by or Blocks:
// Back returns to that one.
export const follow = (w: Where, n: number): Where =>
  w.page.kind === 'issue'
    ? fresh(w, { ...w.page, number: n, trail: [...w.page.trail, w.page.number], folds: FOLDED })
    : open(w, n)

// What an issue's Back leaves for: the milestone detail it was opened from, else the list.
const under = (w: Where): Page => {
  const title = milestoneOf(w)
  return title === null ? { kind: 'list' } : { kind: 'milestone', title }
}

// The list again (or the milestone detail the issue was opened from).
export const list = (w: Where): Where => fresh(w, under(w))

// Back: the issue the one shown was reached from, else the list.
export function back(w: Where): Where {
  if (w.page.kind !== 'issue') return list(w)
  const from = w.page.trail.at(-1)
  if (from === undefined) return list(w)
  return fresh(w, { ...w.page, number: from, trail: w.page.trail.slice(0, -1), folds: FOLDED })
}

// The issue shown is no longer open: what the pane shows falls back as Back
// does, where it stands.
export const closed = (w: Where): Where => (w.page.kind === 'issue' ? { ...w, page: under(w) } : w)

// Milestone `title` in its detail, or the list again for null.
export const openMilestone = (w: Where, title: string | null): Where =>
  fresh(w, title === null ? { kind: 'list' } : { kind: 'milestone', title })

// Changes what is folded in the issue detail shown.
export const fold = (w: Where, change: (f: DetailFolds) => DetailFolds): Where =>
  w.page.kind === 'issue' ? { ...w, page: { ...w.page, folds: change(w.page.folds) } } : w

// The page scrolled to row `to`.
export const scrollTo = (w: Where, to: number): Where => ({ ...w, scroll: to })

// The menu opened if shut, shut if open; and shut.
export const toggleMenu = (w: Where): Where => ({ ...w, menu: !w.menu })
export const shutMenu = (w: Where): Where => ({ ...w, menu: false })

// The help page over what is shown, at its top; the scroll that page had is
// kept for Back. Opened already, nothing changes.
export const help = (w: Where): Where => (w.help ? w : { ...w, help: { scroll: w.scroll }, menu: false, scroll: 0 })

// Back from the help page: what it was opened over, as it was.
export const leaveHelp = (w: Where): Where => ({ ...w, help: null, menu: false, scroll: w.help?.scroll ?? 0 })

// The pane closed: its help page goes with it.
export const dropHelp = (w: Where): Where => ({ ...w, help: null })
