// The repo the pane is about: read from `git remote get-url origin`.
export type Repo = { host: string; owner: string; name: string }

// Where a request's token comes from, never the token itself: the setting,
// and the host when a `host=token` pair gave it. null: none found.
export type TokenSource = { setting: 'Forgejo tokens' | 'GitLab.com token' | 'Private GitLab token'; host: string | null } | null

// How far setting up got: each kind but `ready` names the first step that
// failed, which the pane explains. Steps: repo, forge, token, access.
export type Setup =
  | { kind: 'checking' }
  // `dir`: where the session runs, `~` for the home folder. `origin`: the
  // remote's URL when it names no host fj can read.
  | { kind: 'no-repo'; reason: 'not-git' | 'no-origin' | 'bad-origin'; dir: string; origin?: string }
  // `reason`: the host answered, but not as Forgejo or Gitea; it did not
  // answer at all; or it runs a version older than fj needs.
  | { kind: 'not-forgejo'; reason: 'other' | 'no-answer' | 'too-old'; detail: string }
  // A forge fj knows but does not show issues of yet.
  | { kind: 'unsupported'; forge: 'github' }
  | { kind: 'no-token' }
  | { kind: 'token-refused' }
  // `missing`: the scope the token lacks: Forgejo's read:user when the repo
  // answered but /user refused, GitLab's read_api when its token or /user
  // said so; absent when the repo itself refused.
  | { kind: 'no-scope'; missing?: 'read:user' | 'read_api' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  // `login`: who the token belongs to, from /user. `actions`: whether fj may
  // assign and close.
  // `features`: whether the repo tracks time, has dependencies and has
  // epics; what it turned off is not asked for, and the pane leaves it out.
  | { kind: 'ready'; openIssues: number; login: string; actions: Actions; features: Features }

export type Features = { time: boolean; deps: boolean; epics: boolean }

// Whether fj may assign and close issues: the token needs write:issue (on
// GitLab api) and you push rights on the repo (on GitLab Reporter or
// higher, `role`). `unknown`: the forge would not list the token's scopes,
// so the buttons show and the forge has the last word. `later`: fj cannot
// assign or close on this forge yet.
export type Actions = { kind: 'ok' } | { kind: 'read-only'; reason: 'scope' | 'push' | 'role' | 'later' } | { kind: 'unknown' }

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
  // Seconds logged on the issue, and estimated for it (GitLab only).
  logged: number | null
  estimate: number | null
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
  // For its second line, as in What's next: labels, milestone, when it was
  // opened, and the open issues it waits on.
  labels: { name: string; color: string }[]
  milestone: string | null
  created: string
  blockedBy: number[]
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
      // The forge at the repo's host, with its version, as the pane shows it.
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
      // With Debug on: the last action, the requests it sent the forge, and
      // the requests of the session so far.
      requests: { label: string; count: number; total: number } | null
      // The epics folded open in the Epics pane, by number.
      unfolded: number[]
      // Compact chosen in this session, before a reload brings the setting.
      compact: 'on' | 'off' | null
      // Icons chosen in this session, before a reload brings the setting.
      icons: 'icons' | 'text' | null
    }
  }
}
