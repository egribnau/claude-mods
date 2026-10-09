import { message, type Send } from './tracker'

// The forge a repo's host runs. `version`: as the forge names it, raw for
// Forgejo (`12.0.1+gitea-1.22.0`); null when it would not say, and for
// github.com. `unknown`: no forge What's Next knows answered; `no-answer`: the host
// did not answer at all.
export type Forge =
  | { kind: 'forgejo'; version: string }
  | { kind: 'gitlab'; version: string | null }
  | { kind: 'github'; version: string | null }
  | { kind: 'unknown'; reason: 'no-answer' | 'other'; detail: string }

// Hosts known without a request.
const KNOWN: Record<string, Forge> = {
  'github.com': { kind: 'github', version: null },
  'gitlab.com': { kind: 'gitlab', version: null },
}

// The forge at `host`: a known host by its name, any other by asking the
// version endpoints of Forgejo, GitLab and GitHub Enterprise in turn, with no
// token. A host that does not answer the first is not asked again.
export async function detect(send: Send, host: string): Promise<Forge> {
  const known = KNOWN[host.toLowerCase()]
  if (known) return known
  const base = `https://${host}`
  const accept = { method: 'GET', headers: { Accept: 'application/json' } }

  const first = await send(`${base}/api/v1/version`, accept).catch((err: unknown) => message(err))
  if (typeof first === 'string') return { kind: 'unknown', reason: 'no-answer', detail: first }
  const forgejo = first.ok ? field(first.text, 'version') : undefined
  if (typeof forgejo === 'string') return { kind: 'forgejo', version: forgejo }

  // GitLab asks for a token even here: its JSON refusal is answer enough.
  const gitlab = await send(`${base}/api/v4/version`, accept).catch(() => null)
  if (gitlab?.ok) {
    const v = field(gitlab.text, 'version')
    if (typeof v === 'string') return { kind: 'gitlab', version: v }
  }
  if (gitlab && (gitlab.status === 401 || gitlab.status === 403) && field(gitlab.text, 'message') !== undefined) {
    return { kind: 'gitlab', version: null }
  }

  // GitHub Enterprise Server answers /api/v3/meta without a token.
  const github = await send(`${base}/api/v3/meta`, accept).catch(() => null)
  if (github?.ok) {
    const v = field(github.text, 'installed_version') ?? github.headers['x-github-enterprise-version']
    if (v !== undefined || field(github.text, 'verifiable_password_authentication') !== undefined) {
      return { kind: 'github', version: typeof v === 'string' ? v : null }
    }
  }

  return { kind: 'unknown', reason: 'other', detail: `HTTP ${first.status} for /api/v1/version` }
}

// A forge's name with its version, as the pane shows it. Forgejo's carries
// `+gitea-…`, which is how it is told from Gitea.
export function forgeName(f: Forge): string {
  switch (f.kind) {
    case 'forgejo':
      return `${f.version.includes('+gitea-') ? 'Forgejo' : 'Gitea'} ${f.version.replace(/\+.*$/, '')}`
    case 'gitlab':
      return f.version ? `GitLab ${f.version}` : 'GitLab'
    case 'github':
      return f.version ? `GitHub Enterprise ${f.version}` : 'GitHub'
    case 'unknown':
      return 'unknown'
  }
}

// One field of a JSON object, or undefined when the text is not one.
function field(text: string, name: string): unknown {
  try {
    const json = JSON.parse(text) as unknown
    return json && typeof json === 'object' ? (json as Record<string, unknown>)[name] : undefined
  } catch {
    return undefined
  }
}

// The token settings, each kept in secure storage: one for Forgejo, and
// for GitLab one for gitlab.com and one for a private GitLab.
export type TokenSetting = 'Forgejo tokens' | 'GitLab.com token' | 'Private GitLab token'

// The GitLab token setting for `host`: gitlab.com has its own.
export function gitlabSetting(host: string): TokenSetting {
  return host.toLowerCase() === 'gitlab.com' ? 'GitLab.com token' : 'Private GitLab token'
}

// A token from one setting's text: a bare token is for every host, more
// hosts take `host=token` pairs, separated by spaces, and a pair wins over a
// bare token. `host`: whether a pair gave it. With no host to ask for (no
// repo yet), any token there counts.
export function tokenFor(text: string, host: string | null): { value: string; host: boolean } | null {
  const entries = text.split(/\s+/).filter(Boolean)
  const pairs = entries.filter(t => t.includes('='))
  const bare = entries.find(t => !t.includes('='))
  if (host !== null) {
    const pair = pairs.find(t => t.slice(0, t.indexOf('=')).toLowerCase() === host.toLowerCase())
    const value = pair?.slice(pair.indexOf('=') + 1)
    if (value) return { value, host: true }
  }
  if (bare) return { value: bare, host: false }
  if (host === null && pairs[0]) return { value: pairs[0].slice(pairs[0].indexOf('=') + 1), host: true }
  return null
}
