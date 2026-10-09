import type { EngineInterface } from 'claude-code'

import type { EpicChild, Features, IssueDetail, IssueRow, Setup } from '../types'
import type { MilestoneRow } from './epics'

// One HTTP request, as the pane sends it: counted, so Debug can say what
// each action cost.
export type Send = (url: string, init: Parameters<EngineInterface['http']['fetch']>[1]) => ReturnType<EngineInterface['http']['fetch']>

// An open issue in the repo, with who it is assigned to: none makes it free.
export type OpenIssue = IssueRow & { assignees: string[] }

// An issue with the Epic label, open or closed, with its milestone's title.
export type EpicRow = { number: number; title: string; state: 'open' | 'closed'; milestone: string | null }

// What setup's check found past the repo: the tracker's version as shown,
// once it answered, and how far setup got.
export type Checked = { version: string | null; setup: Setup }

// What the pane asks a tracker. The pane renders what these return and
// never builds a URL. A list that fails throws, naming what failed; a
// lookup that fails answers null, which the pane shows as unknown.
export type Tracker = {
  // The tracker at the repo's host, the token, and what it may read and do.
  check(): Promise<Checked>
  // Where to create a token, for setup's guide.
  tokensUrl: string
  // The open milestones; none when the list is refused.
  milestones(): Promise<MilestoneRow[]>
  // Your open issues in this repo, and all its open issues.
  mine(): Promise<IssueRow[]>
  open(): Promise<OpenIssue[]>
  // The issues with the Epic label, open and closed.
  epics(): Promise<EpicRow[]>
  // The open issues issue `n` waits on, by number.
  blockers(n: number): Promise<number[] | null>
  // The children of epic `n`. Each open one not assigned to `me` is
  // checked for what blocks it.
  children(n: number, me: string | null): Promise<EpicChild[] | null>
  // Everything the detail view shows of issue `n`; what `features` turns
  // off is not asked for.
  issue(n: number, features: Features): Promise<IssueDetail>
  // Issue `n` given these assignees, or closed or open again: null when
  // done, else why not.
  assign(n: number, assignees: string[]): Promise<string | null>
  close(n: number, closed: boolean): Promise<string | null>
}

// An error's message, without the host's `fj: $.http.fetch: ` in front.
export const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^[\w-]+: \$\.[\w.]+: /, '')
