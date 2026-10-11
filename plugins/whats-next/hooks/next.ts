import type { BlockedRow, IssueRow, Scope } from '../types'
import { dueSoon } from './issue'

// One scope where you work, and the issues it holds: an epic's children by
// number, or a milestone's issues by title.
export type Scoped = { scope: Scope; holds: (i: IssueRow) => boolean }

// What the order needs beyond the issues: the scopes where you work,
// widest last; each milestone's due date; how many open issues wait on an
// issue, as far as known; and now.
export type OrderBy = {
  scopes: readonly Scoped[]
  milestoneDue: (title: string) => string | null
  unblocks: (i: IssueRow) => number
  now: number
}

// The available issues in the order docs/whats-next/ORDERING.md sets out:
// by the first scope that holds each (the rest of the milestone filter
// last), then within a scope due soon (within 7 days or passed, earliest
// first; an issue without a due date takes its milestone's), then the most
// unblocked, then the oldest, then the lowest number. Each with the scope it
// was taken from, null for the rest.
export function order(free: readonly IssueRow[], by: OrderBy): { issue: IssueRow; scope: Scope | null }[] {
  const keyed = free.map(issue => {
    const at = by.scopes.findIndex(s => s.holds(issue))
    const due = issue.due ?? (issue.milestone !== null ? by.milestoneDue(issue.milestone) : null)
    const soon = due !== null && dueSoon(due, by.now) !== 'later' ? Date.parse(due) : Infinity
    return { issue, scope: at < 0 ? null : (by.scopes[at] as Scoped).scope, at: at < 0 ? by.scopes.length : at, soon, unblocks: by.unblocks(issue) }
  })
  keyed.sort(
    (a, b) =>
      a.at - b.at ||
      a.soon - b.soon ||
      b.unblocks - a.unblocks ||
      a.issue.created.localeCompare(b.issue.created) ||
      a.issue.number - b.issue.number,
  )
  return keyed.map(({ issue, scope }) => ({ issue, scope }))
}

// The open dependencies of issue `n`, by number; null when Forgejo would not
// say (dependencies off, an error), which counts as not blocked.
export type Blockers = (n: number) => Promise<number[] | null>

// How many issues the Queue shows after Next, and how many past Next are
// checked for blockers at most, so a load asks a bounded number of times.
export const QUEUE_LIMIT = 10
export const CHECK_LIMIT = 2 * QUEUE_LIMIT

// Next among the unassigned issues, in the order given (`order`): the first
// with no open dependencies; the ones skipped on the way are blocked. Past Next the walk
// goes on: each issue is checked, an available one joins the Queue and a blocked
// one the blocked rows, until the Queue holds QUEUE_LIMIT or CHECK_LIMIT
// issues past Next were checked. `more` counts the issues not reached.
export async function pickNext(
  free: readonly IssueRow[],
  blockers: Blockers,
): Promise<{ next: IssueRow | null; queue: IssueRow[]; blocked: BlockedRow[]; more: number }> {
  const blocked: BlockedRow[] = []
  const isFree = (by: number[] | null) => by === null || by.length === 0
  let k = 0
  let next: IssueRow | null = null
  for (; k < free.length && !next; k++) {
    const issue = free[k] as IssueRow
    const by = await blockers(issue.number)
    if (isFree(by)) next = issue
    else blocked.push({ issue, by: by as number[] })
  }
  const queue: IssueRow[] = []
  for (let checked = 0; next && k < free.length && queue.length < QUEUE_LIMIT && checked < CHECK_LIMIT; k++, checked++) {
    const issue = free[k] as IssueRow
    const by = await blockers(issue.number)
    if (isFree(by)) queue.push(issue)
    else blocked.push({ issue, by: by as number[] })
  }
  return { next, queue, blocked, more: free.length - k }
}

// Issues as a list for a sentence: #33, #34.
const refs = (ns: readonly number[]) => ns.map(n => `#${n}`).join(', ')

// What Nothing available waits on: "#33, #34 wait on #37".
export function waitingText(blocked: readonly BlockedRow[]): string {
  const on = [...new Set(blocked.flatMap(b => b.by))].sort((a, b) => a - b)
  const verb = blocked.length === 1 ? 'waits' : 'wait'
  return `${refs(blocked.map(b => b.issue.number))} ${verb} on ${refs(on)}`
}
