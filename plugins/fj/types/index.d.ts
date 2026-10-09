// The repo the pane is about: read from `git remote get-url origin`.
export type Repo = { host: string; owner: string; name: string }

// Where a request's token comes from; never the token itself.
export type TokenSource = 'setting' | 'none'

// How far setting up got: each kind but `ready` names the first step that
// failed, which the pane explains. Steps: repo, Forgejo, token, access.
export type Setup =
  | { kind: 'checking' }
  // `dir`: where the session runs, `~` for the home folder. `origin`: the
  // remote's URL when it names no host fj can read.
  | { kind: 'no-repo'; reason: 'not-git' | 'no-origin' | 'bad-origin'; dir: string; origin?: string }
  // `reason`: the host answered, but not as Forgejo or Gitea; it did not
  // answer at all; or it runs a version older than fj needs.
  | { kind: 'not-forgejo'; reason: 'other' | 'no-answer' | 'too-old'; detail: string }
  | { kind: 'no-token' }
  | { kind: 'token-refused' }
  | { kind: 'no-scope' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; openIssues: number }

// One open issue in this repo, as the overview lists it.
export type IssueRow = {
  number: number
  title: string
  milestone: string | null
  labels: string[]
  created: string
  // The issue's page on Forgejo.
  url: string
  // Its description, as written.
  body: string
}

// An unassigned issue found blocked on the way to Next: `by` names its open
// dependencies.
export type BlockedRow = { issue: IssueRow; by: number[] }

// What's next, once setup passes. In progress: open issues assigned to you.
// Next: the oldest open, unassigned issue with no open dependencies. Queue:
// the unassigned issues after Next, oldest first, not checked for
// dependencies. Blocked: the ones skipped on the way to Next. Issues
// assigned only to others are left out.
export type Overview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; inProgress: IssueRow[]; next: IssueRow | null; queue: IssueRow[]; blocked: BlockedRow[] }
  | { kind: 'error'; message: string }

// An issue or pull request another one points at, with its state: open,
// closed, or for a pull request also merged.
export type Ref = { number: number; title: string; state: string }

export type CommitRef = { sha: string; message: string; when: string }

// One issue as the detail view shows it. A list is null when Forgejo would
// not say (dependencies or time tracking off, an older Forgejo): the view
// then leaves its line out, as it does for an empty one.
export type IssueDetail = {
  number: number
  title: string
  state: string
  url: string
  body: string
  author: string
  created: string
  updated: string
  comments: number
  milestone: { title: string; due: string | null } | null
  due: string | null
  branch: string | null
  // Seconds logged on the issue.
  logged: number | null
  labels: { name: string; color: string }[]
  blockedBy: Ref[] | null
  blocks: Ref[] | null
  pulls: Ref[] | null
  commits: CommitRef[] | null
  lastComment: { author: string; when: string; body: string } | null
}

export type Detail =
  | { kind: 'idle' }
  | { kind: 'loading'; number: number }
  | { kind: 'ok'; issue: IssueDetail }
  | { kind: 'error'; number: number; message: string }

// An open issue an epic depends on, as the Epics pane lists it. `mine`: it
// is assigned to you; `assignees`: the logins it is assigned to; `blocked`:
// it has open dependencies of its own.
export type EpicChild = {
  number: number
  title: string
  state: 'open' | 'closed'
  assignees: string[]
  mine: boolean
  blocked: boolean
}

// An issue with the Epic label. Its children are the issues it depends on;
// null when Forgejo would not say, or for a closed epic, which shows none.
export type Epic = { number: number; title: string; state: 'open' | 'closed'; children: EpicChild[] | null }

// The epics of one milestone, or of none (`title` null), with the
// milestone's due date and how many of its issues are closed.
export type EpicGroup = { title: string | null; due: string | null; closed: number; total: number; epics: Epic[] }

// The Epics pane: what the picker offers and which is picked (`m:<title>`,
// `none` or `all`), the groups that pick shows, and how many open epics the
// repo has in all, which decides whether the pane opens.
export type Epics =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ok'
      // A milestone's option carries its due date.
      options: { value: string; label: string; due?: string | null }[]
      pick: string
      groups: EpicGroup[]
      openEpics: number
    }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    fj: {
      repo: Repo | null
      version: string | null
      token: TokenSource
      setup: Setup
      overview: Overview
      // Per pane: the issue open in its detail view, by number (null shows
      // the pane's list), and what was loaded for it.
      picked: StateFamily<number | null>
      detail: StateFamily<Detail>
      epics: Epics
      // Whether /fj opened the Epics pane, so it closes once no epic is open.
      epicsShown: boolean
      // The picker's choice in the Epics pane; null starts on its first option.
      epicsPick: string | null
      // Whether the picker's list is open.
      pickerOpen: boolean
      // The epics folded open in the Epics pane, by number.
      unfolded: number[]
      // Icons chosen in this session, before a reload brings the setting.
      icons: 'icons' | 'text' | null
    }
  }
}
