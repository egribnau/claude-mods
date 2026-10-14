import { expect, test } from 'claude-code/testing'

import { FOLDED, HERE, back, closed, fold, follow, foldsOf, help, issueOf, leaveHelp, list, milestoneOf, open, openMilestone, scrollTo, shutMenu, toggleMenu } from '../hooks/where'

// Where a pane is, as plain steps with no pane: Back, the help page, the
// menu, and an issue opened over a milestone (docs/whats-next/DRAWING.md,
// A detail scrolls, The menu, The help page).

test('an issue opens at its top, folded, its menu shut', () => {
  const was = toggleMenu(scrollTo(HERE, 7))
  const w = open(was, 14)
  expect(issueOf(w)).toBe(14)
  expect(w.scroll).toBe(0)
  expect(w.menu).toBe(false)
  expect(foldsOf(w)).toEqual(FOLDED)
})

test('following an issue opens it folded and at its top; Back returns to the one it came from, folded', () => {
  let w = open(HERE, 14)
  w = fold(w, f => ({ ...f, description: true }))
  w = scrollTo(w, 5)
  w = follow(w, 20)
  expect(issueOf(w)).toBe(20)
  expect(w.scroll).toBe(0)
  expect(foldsOf(w)).toEqual(FOLDED)
  w = follow(w, 31)
  expect(w.page).toMatchObject({ number: 31, trail: [14, 20] })
  w = back(toggleMenu(scrollTo(w, 3)))
  expect(w.page).toMatchObject({ number: 20, trail: [14] })
  expect(w.scroll).toBe(0)
  expect(w.menu).toBe(false)
  w = back(w)
  expect(issueOf(w)).toBe(14)
  expect(foldsOf(w)).toEqual(FOLDED)
})

test('Back from an issue reached from the list returns to the list', () => {
  const w = back(scrollTo(open(HERE, 14), 4))
  expect(w.page).toEqual({ kind: 'list' })
  expect(w.scroll).toBe(0)
  expect(back(w)).toEqual(w)
})

test('folding changes only the issue detail shown', () => {
  expect(foldsOf(fold(open(HERE, 14), f => ({ ...f, commentsShut: true }))).commentsShut).toBe(true)
  expect(fold(HERE, f => ({ ...f, description: true }))).toBe(HERE)
})

test('an issue opened from a milestone detail returns to that milestone, folded', () => {
  let w = openMilestone(scrollTo(HERE, 2), 'v1.2')
  expect(w.page).toEqual({ kind: 'milestone', title: 'v1.2' })
  expect(w.scroll).toBe(0)
  w = open(w, 14)
  expect(milestoneOf(w)).toBe('v1.2')
  w = back(follow(w, 20))
  expect(issueOf(w)).toBe(14)
  w = back(w)
  expect(w.page).toEqual({ kind: 'milestone', title: 'v1.2' })
  expect(openMilestone(w, null).page).toEqual({ kind: 'list' })
})

test('the list again leaves the milestone detail an issue was opened over, as Back does', () => {
  const w = list(open(openMilestone(HERE, 'v1.2'), 14))
  expect(w.page).toEqual({ kind: 'milestone', title: 'v1.2' })
  expect(list(open(HERE, 14)).page).toEqual({ kind: 'list' })
})

test('an issue no longer open falls back as Back does, where the pane stands', () => {
  const w = scrollTo(open(HERE, 14), 6)
  expect(closed(w)).toEqual({ ...w, page: { kind: 'list' } })
  expect(closed(HERE)).toBe(HERE)
  expect(closed(open(openMilestone(HERE, 'v1.2'), 14)).page).toEqual({ kind: 'milestone', title: 'v1.2' })
})

test('the help page opens at its top over the page, and Back returns to the scroll the page had', () => {
  const over = scrollTo(open(HERE, 14), 9)
  let w = help(toggleMenu(over))
  expect(w.help).toEqual({ scroll: 9 })
  expect(w.scroll).toBe(0)
  expect(w.menu).toBe(false)
  expect(w.page).toEqual(over.page)
  w = scrollTo(w, 3)
  expect(help(w)).toBe(w)
  w = leaveHelp(toggleMenu(w))
  expect(w).toEqual({ ...over, help: null })
})

test('the menu opens, closes and shuts', () => {
  const w = toggleMenu(HERE)
  expect(w.menu).toBe(true)
  expect(toggleMenu(w).menu).toBe(false)
  expect(shutMenu(w).menu).toBe(false)
  expect(shutMenu(HERE)).toEqual(HERE)
})
