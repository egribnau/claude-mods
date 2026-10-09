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
  // `missing`: the scope the token lacks, when the repo answered but /user
  // refused; absent when the repo itself refused.
  | { kind: 'no-scope'; missing?: 'read:user' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  // `login`: who the token belongs to, from /user. `actions`: whether fj may
  // assign and close.
  // `features`: whether the repo tracks time and has dependencies; what it
  // turned off is not asked for.
  | { kind: 'ready'; openIssues: number; login: string; actions: Actions; features: Features }

export type Features = { time: boolean; deps: boolean }

// Whether fj may assign and close issues: the token needs write:issue and
// you push rights on the repo. `unknown`: Forgejo would not list the token's
// scopes, so the buttons show and Forgejo has the last word.
export type Actions = { kind: 'ok' } | { kind: 'read-only'; reason: 'scope' | 'push' } | { kind: 'unknown' }

// One open issue in this repo, as the overview lists it.
export type IssueRow = {
  number: number
  title: string
  milestone: string | null
  // Each with its Forgejo colour, `rrggbb`, or '' for none.
  labels: { name: string; color: string }[]
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
  // The logins it is assigned to.
  assignees: string[]
  blockedBy: Ref[] | null
  blocks: Ref[] | null
  pulls: Ref[] | null
  commits: CommitRef[] | null
  lastComment: { author: string; when: string; body: string } | null
}

export type Detail =
  | { kind: 'idle' }
  | { kind: 'loading'; number: number }
  // `error`: why the last action on it was refused.
  | { kind: 'ok'; issue: IssueDetail; error?: string }
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

// The Epics pane: the groups the milestone picked shows, and how many open
// epics the repo has in all, which decides whether the pane opens.
export type Epics =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; groups: EpicGroup[]; openEpics: number }
  | { kind: 'error'; message: string }

// The milestone picker both panes share: what it offers (a milestone's option
// carries its due date) and which is picked: `m:<title>`, `none` or `all`.
export type Picker = { options: { value: string; label: string; due?: string | null }[]; pick: string }

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
      // fj's panes that are open, by id: with more than one the engine draws
      // tabs naming them, so the title rows leave the names out.
      panesOpen: string[]
      // The milestone the person picked; null starts on the picker's first.
      milestonePick: string | null
      // What the picker offers and shows picked, once loaded.
      picker: Picker | null
      // Whether the picker's list is open.
      pickerOpen: boolean
      // With Debug on: the last action, the requests it sent Forgejo, and
      // the requests of the session so far.
      requests: { label: string; count: number; total: number } | null
      // The epics folded open in the Epics pane, by number.
      unfolded: number[]
      // Icons chosen in this session, before a reload brings the setting.
      icons: 'icons' | 'text' | null
    }
  }
}
