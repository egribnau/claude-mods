import type { Repo, Setup, TokenSource } from '../types'
import { detect, gitlabSetting, tokenFor, type Forge, type TokenSetting } from './forge'
import { forgejo } from './forgejo'
import { github } from './github'
import { gitlab } from './gitlab'
import { withoutToken, type Send, type Tracker } from './tracker'

// Setup's steps, and the tracker they end in. It takes plain inputs: the
// origin remote, the token settings' text and the engine's fetch. The Hard
// rule on tokens is kept here: a token comes only from the settings, goes
// only to the forge setup found at its host, and what the tracker says never
// carries it.

// The token settings' text, as `register` reads it.
export type Tokens = Record<TokenSetting, string>

// A token and where it came from.
type TokenFound = { value: string | null; from: TokenSource }

// The host, owner and repo a git remote URL names, in any of the forms git
// takes: ssh://git@host:2222/o/r.git, git@host:o/r.git, https://host/o/r.
export function parseRemote(url: string): Repo | null {
  const m =
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m?.[1] || !m[2] || !m[3]) return null
  return { host: m[1], owner: m[2], name: m[3] }
}

// The token for `host` (null: no repo yet) from one token setting, kept in
// secure storage. The settings are the only source, so the token is the
// same in the terminal and the app.
export function readToken(tokens: Tokens, setting: TokenSetting, host: string | null): TokenFound {
  const t = tokenFor(tokens[setting], host)
  return t ? { value: t.value, from: { setting, host: t.host ? host : null } } : { value: null, from: null }
}

// Where a token is from while the host is not known yet (no repo): the first
// of the four settings that has one, in the order of the settings.
export function anyToken(tokens: Tokens): TokenSource {
  for (const setting of ['Forgejo tokens', 'GitLab.com token', 'Private GitLab token', 'GitHub token'] as const) {
    const found = readToken(tokens, setting, null)
    if (found.value !== null) return found.from
  }
  return null
}

// The GitLab token for `host`. gitlab.com's comes from GitLab.com token, else
// from a `gitlab.com=` pair in Private GitLab token, as older setups have it,
// never from that setting's bare token. Any other host's comes from Private
// GitLab token.
function gitlabToken(tokens: Tokens, host: string): TokenFound {
  if (gitlabSetting(host) === 'Private GitLab token') return readToken(tokens, 'Private GitLab token', host)
  const com = readToken(tokens, 'GitLab.com token', host)
  if (com.value !== null) return com
  const old = tokenFor(tokens['Private GitLab token'], host)
  return old?.host ? { value: old.value, from: { setting: 'Private GitLab token', host } } : { value: null, from: null }
}

// The token for the forge found at `host`; none for a forge that is unknown.
function tokenOfForge(tokens: Tokens, forge: Forge, host: string): TokenFound {
  return forge.kind === 'gitlab'
    ? gitlabToken(tokens, host)
    : forge.kind === 'github'
      ? readToken(tokens, 'GitHub token', host)
      : forge.kind === 'forgejo'
        ? readToken(tokens, 'Forgejo tokens', host)
        : { value: null, from: null }
}

// The tracker of one forge for repo `r`, with `token` cut out of what it says.
function trackerOf(send: Send, kind: 'forgejo' | 'gitlab' | 'github', r: Repo, token: string | null, label: string, version: string | null): Tracker {
  return withoutToken(
    kind === 'gitlab'
      ? gitlab(send, r, token, version, label)
      : kind === 'github'
        ? github(send, r, token, version, label)
        : forgejo(send, r, token, label, version ?? undefined),
    token,
  )
}

// The tracker behind repo `r`: GitLab or GitHub where setup found it, else
// Forgejo. A token goes only to the forge setup found at the host (`forge`):
// with none found, the Forgejo tracker gets no token.
export function trackerFor(send: Send, r: Repo, forge: Forge | undefined, tokens: Tokens, label: string): Tracker {
  return forge?.kind === 'gitlab' || forge?.kind === 'github'
    ? trackerOf(send, forge.kind, r, tokenOfForge(tokens, forge, r.host).value, label, forge.version)
    : trackerOf(send, 'forgejo', r, forge?.kind === 'forgejo' ? tokenOfForge(tokens, forge, r.host).value : null, label, null)
}

// Step Repo: the repo behind `origin` (null: no such remote). With no repo,
// `setup` says why; `folder` is asked then, for whether the session is in a
// git repo at all and where it runs (`~` for the home folder).
export async function findRepo(
  origin: string | null,
  folder: () => Promise<{ inRepo: boolean; dir: string }>,
): Promise<{ repo: Repo; setup: null } | { repo: null; setup: Setup }> {
  const repo = origin ? parseRemote(origin) : null
  if (repo) return { repo, setup: null }
  const { inRepo, dir } = await folder()
  const setup: Setup = !inRepo
    ? { kind: 'no-repo', reason: 'not-git', dir }
    : origin === null
      ? { kind: 'no-repo', reason: 'no-origin', dir }
      : { kind: 'no-repo', reason: 'bad-origin', dir, origin: origin.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1') }
  return { repo: null, setup }
}

// What setup found past the repo. `token`: where the token came from. With an
// unknown forge there is no tracker, and `setup` says why.
export type Found = { forge: Forge; token: TokenSource; version: string | null; setup: Setup; tracker: Tracker | null }

// Steps Forge, Token, Access and Actions for `r`: the forge at its host, then
// the tracker's own steps: a token, and the token reading the repo. A forge
// already found at the host (`known`) is used as it is, so a check again does
// not ask the host what it is; one that was not recognised is asked again.
export async function checkForge(send: Send, r: Repo, tokens: Tokens, label: string, known?: Forge): Promise<Found> {
  const forge = known && known.kind !== 'unknown' ? known : await detect(send, r.host)
  if (forge.kind === 'unknown') {
    return { forge, token: null, version: null, setup: { kind: 'not-forgejo', reason: forge.reason, detail: forge.detail }, tracker: null }
  }
  const tok = tokenOfForge(tokens, forge, r.host)
  const tracker = trackerOf(send, forge.kind, r, tok.value, label, forge.version)
  const c = await tracker.check()
  return { forge, token: tok.from, version: c.version, setup: c.setup, tracker }
}
