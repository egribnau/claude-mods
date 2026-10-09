// The repo the pane is about: read from `git remote get-url origin`.
export type Repo = { host: string; owner: string; name: string }

// Where a request's token comes from; never the token itself.
export type TokenSource = 'setting' | 'FORGEJO_TOKEN' | 'none'

// The last check that Forgejo answers for the repo with the token.
export type Check =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; openIssues: number }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    fj: {
      repo: Repo | null
      repoError: string | null
      token: TokenSource
      check: Check
    }
  }
}
