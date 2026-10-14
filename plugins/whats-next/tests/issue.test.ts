import { expect, test } from 'claude-code/testing'

import { dueSoon, dueText } from '../hooks/issue'

// A due date counts in calendar days in UTC, the due date's day minus
// today's, so it reads the same at any hour of the day.

test('dueText: a date-only due date reads today all through that day', () => {
  expect(dueText('2026-10-14', Date.parse('2026-10-14T13:00:00Z'))).toEqual({ text: '14 Oct, today', passed: false })
  expect(dueSoon('2026-10-14', Date.parse('2026-10-14T13:00:00Z'))).toBe('soon')
})

test('dueText: a due date with a time reads today after that time too', () => {
  expect(dueText('2026-10-14T07:00:00Z', Date.parse('2026-10-14T19:00:00Z')).text).toBe('14 Oct, today')
  expect(dueSoon('2026-10-14T07:00:00Z', Date.parse('2026-10-14T19:00:00Z'))).toBe('soon')
})

test('dueText: the day before reads yesterday and passed, from its first hour', () => {
  expect(dueText('2026-10-13', Date.parse('2026-10-14T01:00:00Z'))).toEqual({ text: '13 Oct, yesterday', passed: true })
  expect(dueSoon('2026-10-13', Date.parse('2026-10-14T01:00:00Z'))).toBe('passed')
})

test('dueText: the day after reads tomorrow, even late in the day', () => {
  expect(dueText('2026-10-15', Date.parse('2026-10-14T23:30:00Z')).text).toBe('15 Oct, tomorrow')
})

test('dueSoon: seven days off is soon, eight is later', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  expect(dueText('2026-10-21', now).text).toBe('21 Oct, in 7 days')
  expect(dueSoon('2026-10-21', now)).toBe('soon')
  expect(dueSoon('2026-10-22', now)).toBe('later')
})
