// The repo the pane is about: read from `git remote get-url origin`.
export type Repo = { host: string; owner: string; name: string }

// Where a request's token comes from, never the token itself: the setting,
// and the host when a `host=token` pair gave it. null: none found.
export type TokenSource = { setting: 'Forgejo tokens' | 'GitLab.com token' | 'Private GitLab token' | 'GitHub token'; host: string | null } | null

// How far setting up got: each kind but `ready` names the first step that
// failed, which the pane explains. Steps: repo, forge, token, access.
export type Setup =
  | { kind: 'checking' }
  // `dir`: where the session runs, `~` for the home folder. `origin`: the
  // remote's URL when it names no host What's Next can read.
  | { kind: 'no-repo'; reason: 'not-git' | 'no-origin' | 'bad-origin'; dir: string; origin?: string }
  // `reason`: the host answered, but not as Forgejo or Gitea; it did not
  // answer at all; or it runs a version older than What's Next needs.
  | { kind: 'not-forgejo'; reason: 'other' | 'no-answer' | 'too-old'; detail: string }
  | { kind: 'no-token' }
  | { kind: 'token-refused' }
  // `missing`: the scope the token lacks: Forgejo's read:user when the repo
  // answered but /user refused, GitLab's read_api when its token or /user
  // said so, GitHub's Issues permission when the repo answered but its
  // issues did not; absent when the repo itself refused.
  | { kind: 'no-scope'; missing?: 'read:user' | 'read_api' | 'Issues' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  // `login`: who the token belongs to, from /user. `actions`: whether What's Next may
  // assign and close.
  // `features`: whether the repo tracks time, has dependencies and has
  // epics; what it turned off is not asked for, and the pane leaves it out.
  | { kind: 'ready'; openIssues: number; login: string; actions: Actions; features: Features }

export type Features = { time: boolean; deps: boolean; epics: boolean }

// Whether What's Next may assign and close issues: the token needs write:issue (on
// GitLab api) and you push rights on the repo (on GitLab Reporter or
// higher, `role`). `unknown`: the forge would not list the token's scopes,
// so the buttons show and the forge has the last word. `later`: What's Next cannot
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
  // Its own due date; null when it has none (GitHub issues never do).
  due: string | null
  // The issue's page on Forgejo.
  url: string
  // Its description, as written.
  body: string
  // When it last changed: of your issues in progress, the one updated last
  // is the one you work from (docs/whats-next/ORDERING.md).
  updated: string
  // How many open issues wait on it, where the list says so (GitHub);
  // elsewhere the blocker checks count it.
  unblocks?: number
}

// The issue you closed last within the milestone filter, as Last closed
// shows it: when it closed and the epic it was in.
export type LastClosed = { number: number; title: string; closed: string; milestone: string | null; epic: number | null }

// Where an issue of Next or the Queue was taken from: the epic you work in
// (or a parent of it), the milestone of the issue you work from, or null
// for the rest of the milestone filter.
export type Scope = { kind: 'epic'; number: number } | { kind: 'milestone'; title: string }

// An unassigned issue found blocked on the way to Next: `by` names its open
// dependencies.
export type BlockedRow = { issue: IssueRow; by: number[] }

// What's next, once setup passes. In progress: open issues assigned to you.
// Next: the first available issue in the order docs/whats-next/ORDERING.md
// sets out. Queue: the available issues after Next, in that order. Blocked:
// the ones found blocked on the way. Issues assigned only to others are
// left out.
export type Overview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  // `more`: the free issues past the Queue's limit, not checked or shown.
  // `scopes`: the scope each issue of Next and the Queue was taken from, by
  // number, none for the rest of the milestone filter. `unblocks`: how many
  // open issues wait on each, as far as known. `lastClosed`: the issue you
  // closed last within the milestone filter.
  | {
      kind: 'ok'
      inProgress: IssueRow[]
      next: IssueRow | null
      queue: IssueRow[]
      blocked: BlockedRow[]
      more: number
      scopes: Record<number, Scope>
      unblocks: Record<number, number>
      lastClosed: LastClosed | null
    }
  | { kind: 'error'; message: string }

// An issue or pull request another one points at, with its state: open,
// closed, or for a pull request also merged.
// An issue or pull request a line names. `blocked`: an open blocker that is
// itself blocked by an open issue; only asked for under Blocked by.
// An issue or pull request another issue names. `assignees`: the logins an
// issue is assigned to; `blocked`: an open issue waits on an open one of its
// own. Both give its mark in the detail (DRAWING-issue.md, Detail lines).
export type Ref = { number: number; title: string; state: string; blocked?: boolean; assignees?: string[] }

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
  // Every comment, oldest first; null when the forge would not say.
  commentList: Comment[] | null
}

export type Comment = { author: string; when: string; body: string }

// What is folded in an issue's detail (DRAWING.md, A detail scrolls): it
// opens as its rules say every time, and Refresh keeps it. `description`:
// Description unfolded; `commentsShut`: Comments folded shut; `comments`:
// the comments unfolded, by when they were written, null for the newest
// alone; `whole`: those of them shown whole, past their first 3 lines.
export type DetailFolds = { description: boolean; commentsShut: boolean; comments: string[] | null; whole: string[] }

export type Detail =
  | { kind: 'idle' }
  | { kind: 'loading'; number: number }
  // `error`: why the last action on it was refused. `parent`: the issue it
  // is a child of, and whether that is an epic; null for none. `blocked`:
  // it waits on an open issue that is not its own child, for its mark.
  // `children`: the issues it holds, open and closed; null for none, or
  // when the forge would not say.
  | { kind: 'ok'; issue: IssueDetail; error?: string; parent?: (Ref & { epic: boolean }) | null; blocked?: boolean; children?: Ref[] | null }
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
  // Its own due date; null when it has none.
  due: string | null
  blockedBy: number[]
  // How many sub-issues it has, closed and in all, where the forge says so
  // with the issue (GitHub): its count without asking for its children.
  subIssues?: { closed: number; total: number }
}

// An issue with the Epic label. Its children are the issues it depends on;
// null when Forgejo would not say, or for a closed epic, which shows none.
// An open issue of a milestone, as the Milestones pane lists it; an epic
// carries its children (null when the tracker would not say).
export type MilestoneIssue = EpicChild & { children?: EpicChild[] | null }

// `due`: the epic's own due date, from the lists. For its facts line, as
// any issue row's (DRAWING-issue.md, The facts line): its labels, its
// milestone, when it was opened, and the open issues it waits on, its own
// children left out.
export type Epic = {
  number: number
  title: string
  state: 'open' | 'closed'
  due: string | null
  children: EpicChild[] | null
  labels?: { name: string; color: string }[]
  milestone?: string | null
  created?: string
  blockedBy?: number[]
}

// The epics of one milestone, or of none (`title` null), with the
// milestone's due date and how many of its issues are closed.
export type EpicGroup = { title: string | null; due: string | null; closed: number; total: number; epics: Epic[] }

// The Epics pane: the groups the milestone picked shows, and how many open
// epics the repo has in all, which decides whether the pane opens.
export type Epics =
  | { kind: 'idle' }
  | { kind: 'loading' }
  // `held`: the open epics in the pick shown under a parent epic, not at the
  // top of a group.
  | { kind: 'ok'; groups: EpicGroup[]; openEpics: number; held: Epic[] }
  | { kind: 'error'; message: string }

// A milestone as the Milestones pane shows it: its due date and how many of
// its issues are closed, of all; for its detail, its text, its page on the
// forge and when it closed (null when the forge does not say).
export type Milestone = {
  title: string
  due: string | null
  closed: number
  total: number
  description?: string
  url?: string
  closedAt?: string | null
  // The forge's id for it, to close or reopen it; on GitLab, the group it
  // belongs to when it comes from a parent group.
  id?: number
  group?: string
}

// The milestone picker both panes share: what it offers (a milestone's option
// carries its due date) and which is picked: `m:<title>`, `none` or `all`.
export type Picker = { options: { value: string; label: string; due?: string | null }[]; pick: string }

declare module 'claude-code' {
  interface PluginState {
    'whats-next': {
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
      // Per pane: the issues the open one was reached from through its
      // Blocked by and Blocks lines, oldest first; Back returns to the last.
      trail: StateFamily<number[]>
      // Per pane: what is folded in the issue detail open there.
      folds: StateFamily<DetailFolds>
      // Per pane: how far its detail is scrolled, in rows, and whether its
      // menu is open.
      scrolled: StateFamily<number>
      menuOpen: StateFamily<boolean>
      // Per pane: whether the help page is shown, over its list or detail.
      helpShown: StateFamily<boolean>
      epics: Epics
      // What's Next's panes that are open, by id: with more than one the engine draws
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
      // The issues folded open in a tree, Epics and Milestones alike, by number.
      unfolded: number[]
      // The children loaded of any issue in a tree, by number: null when the
      // forge would not say.
      treeKids: Record<number, EpicChild[] | null>
      // In the milestone detail: whether Issues is folded shut, and whether
      // Description is folded open; set again each time a milestone opens.
      issuesFolded: boolean
      descriptionUnfolded: boolean
      // The repo's open milestones, once loaded; null before.
      milestones: Milestone[] | null
      // The milestones folded open in the Milestones pane, by title.
      milestonesUnfolded: string[]
      // The milestone open in its detail on the Milestones pane, by title;
      // null shows the list.
      milestoneOpen: string | null
      // Why the forge refused to close or reopen the milestone in its detail;
      // null when nothing was refused.
      milestoneError: string | null
      // The last milestones closed, newest first, and whether Closed is folded open.
      closedMilestones: Milestone[]
      closedShown: boolean
      // The open issues of each milestone folded open, by title, once asked;
      // null when they could not be listed.
      milestoneIssues: Record<string, MilestoneIssue[] | null>
      // Compact chosen in this session, before a reload brings the setting.
      compact: 'on' | 'off' | null
      // Icons chosen in this session, before a reload brings the setting.
      icons: 'icons' | 'text' | null
    }
  }
}
