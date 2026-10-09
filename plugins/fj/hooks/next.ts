import type { BlockedRow, IssueRow } from '../types'

// The open dependencies of issue `n`, by number; null when Forgejo would not
// say (dependencies off, an error), which counts as not blocked.
export type Blockers = (n: number) => Promise<number[] | null>

// Next among the unassigned issues, oldest first: the first with no open
// dependencies. Each issue is checked in turn and the walk stops there, so
// the issues after Next are not checked and only the skipped ones are known
// to be blocked.
export async function pickNext(
  free: readonly IssueRow[],
  blockers: Blockers,
): Promise<{ next: IssueRow | null; queue: IssueRow[]; blocked: BlockedRow[] }> {
  const blocked: BlockedRow[] = []
  for (let k = 0; k < free.length; k++) {
    const issue = free[k] as IssueRow
    const by = await blockers(issue.number)
    if (by === null || by.length === 0) return { next: issue, queue: free.slice(k + 1), blocked }
    blocked.push({ issue, by })
  }
  return { next: null, queue: [], blocked }
}

// Issues as a list for a sentence: #33, #34.
const refs = (ns: readonly number[]) => ns.map(n => `#${n}`).join(', ')

// What Nothing ready waits on: "#33, #34 wait on #37".
export function waitingText(blocked: readonly BlockedRow[]): string {
  const on = [...new Set(blocked.flatMap(b => b.by))].sort((a, b) => a - b)
  const verb = blocked.length === 1 ? 'waits' : 'wait'
  return `${refs(blocked.map(b => b.issue.number))} ${verb} on ${refs(on)}`
}
