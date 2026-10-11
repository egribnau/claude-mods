import type { EngineInterface } from 'claude-code'

import type { EpicChild, Features, IssueDetail, IssueRow, Setup } from '../types'
import type { MilestoneRow } from './epics'
import type { TokenSetting } from './forge'

// One HTTP request, as the pane sends it: counted, so Debug can say what
// each action cost.
export type Send = (url: string, init: Parameters<EngineInterface['http']['fetch']>[1]) => ReturnType<EngineInterface['http']['fetch']>

// An open issue in the repo, with who it is assigned to: none makes it free.
export type OpenIssue = IssueRow & { assignees: string[] }

// A closed issue, as Last closed needs it: when it closed, and its milestone.
export type Closed = { number: number; title: string; closed: string; milestone: string | null }

// An issue with the Epic label, open or closed, with its milestone's title
// and its own due date.
export type EpicRow = { number: number; title: string; state: 'open' | 'closed'; milestone: string | null; due: string | null }

// What setup's check found past the repo: the tracker's version as shown,
// once it answered, and how far setup got.
export type Checked = { version: string | null; setup: Setup }

// What the pane asks a tracker. The pane renders what these return and
// never builds a URL. A list that fails throws, naming what failed; a
// lookup that fails answers null, which the pane shows as unknown.
export type Tracker = {
  // The tracker at the repo's host, the token, and what it may read and do.
  check(): Promise<Checked>
  // The forge's name, for the pane's texts.
  name: 'Forgejo' | 'GitLab' | 'GitHub'
  // Where to create a token, with which scopes, and the setting it goes in,
  // for setup's guide.
  tokensUrl: string
  scopes: string
  setting: TokenSetting
  // The scope a token needs to assign and close.
  writeScope: string
  // The open milestones; none when the list is refused.
  milestones(): Promise<MilestoneRow[]>
  // The last `n` milestones closed, newest first; none when the list is refused.
  closedMilestones(n: number): Promise<MilestoneRow[]>
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
  // The numbers of epic `n`'s children, open and closed, without checking
  // them for blockers: one request. null when the forge would not say.
  members(n: number): Promise<number[] | null>
  // The open epic issue `n` is a child of; on GitHub its parent issue, of
  // any kind. null for none, or when the forge would not say.
  parentOf(n: number): Promise<number | null>
  // Whether a child can have children of its own (GitHub): then where you
  // work widens through each parent up the tree.
  nested: boolean
  // The issue assigned to `me` that closed last, within a milestone, those
  // without one ('none'), or all: one request. null for none, or when the
  // forge would not say.
  lastClosed(within: MilestoneRow | 'none' | 'all', me: string): Promise<Closed | null>
  // Everything the detail view shows of issue `n`; what `features` turns
  // off is not asked for.
  issue(n: number, features: Features): Promise<IssueDetail>
  // Issue `n` given these assignees, or closed or open again: null when
  // done, else why not.
  assign(n: number, assignees: string[]): Promise<string | null>
  close(n: number, closed: boolean): Promise<string | null>
  // Milestone `m` closed or open again: null when done, else why not.
  closeMilestone(m: MilestoneRow, closed: boolean): Promise<string | null>
}

// An error's message, without the host's `whats-next: $.http.fetch: ` in front.
export const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^[\w-]+: \$\.[\w.]+: /, '')

// Tracker `t` with `token` cut out of everything it answers and every error
// it throws: a forge's refusal, or a page that is not JSON, may echo the
// request back, and what a tracker says reaches the panes, toasts and the
// prompt.
export function withoutToken(t: Tracker, token: string | null): Tracker {
  if (!token) return t
  const cut = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.split(token).join('<token>')
      : Array.isArray(v)
        ? v.map(cut)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]))
          : v
  const sealed = Object.entries(t).map(([k, v]) => [
    k,
    typeof v === 'function'
      ? async (...args: unknown[]) => {
          try {
            return cut(await (v as (...a: unknown[]) => Promise<unknown>)(...args))
          } catch (err) {
            throw new Error(cut(message(err)) as string)
          }
        }
      : v,
  ])
  return Object.fromEntries(sealed) as Tracker
}
