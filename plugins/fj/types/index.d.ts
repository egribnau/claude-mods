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

declare module 'claude-code' {
  interface PluginState {
    fj: {
      repo: Repo | null
      version: string | null
      token: TokenSource
      setup: Setup
    }
  }
}
