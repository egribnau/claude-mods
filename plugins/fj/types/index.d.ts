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
  | { kind: 'not-forgejo'; detail: string }
  | { kind: 'no-token' }
  | { kind: 'token-refused' }
  | { kind: 'no-scope' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; openIssues: number }

// One open issue in this repo assigned to the token's owner.
export type MyIssue = {
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

// The list of your issues, once setup passes.
export type Mine =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; issues: MyIssue[] }
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

declare module 'claude-code' {
  interface PluginState {
    fj: {
      repo: Repo | null
      version: string | null
      token: TokenSource
      setup: Setup
      mine: Mine
      // The issue open in the detail view, by number; null shows the list.
      picked: number | null
      detail: Detail
    }
  }
}
