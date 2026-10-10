import type { BlockedRow, IssueRow } from '../types'

// The open dependencies of issue `n`, by number; null when Forgejo would not
// say (dependencies off, an error), which counts as not blocked.
export type Blockers = (n: number) => Promise<number[] | null>

// How many issues the Queue shows after Next, and how many past Next are
// checked for blockers at most, so a load asks a bounded number of times.
export const QUEUE_LIMIT = 10
export const CHECK_LIMIT = 2 * QUEUE_LIMIT

// Next among the unassigned issues, oldest first: the first with no open
// dependencies; the ones skipped on the way are blocked. Past Next the walk
// goes on: each issue is checked, a free one joins the Queue and a blocked
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

// What Nothing ready waits on: "#33, #34 wait on #37".
export function waitingText(blocked: readonly BlockedRow[]): string {
  const on = [...new Set(blocked.flatMap(b => b.by))].sort((a, b) => a - b)
  const verb = blocked.length === 1 ? 'waits' : 'wait'
  return `${refs(blocked.map(b => b.issue.number))} ${verb} on ${refs(on)}`
}
