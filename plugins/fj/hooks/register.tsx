import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Repo, TokenSource } from '../types'

const PANE = 'fj'

const repo = atom({ plugin: 'fj', key: 'repo' } as const, null)
const repoError = atom({ plugin: 'fj', key: 'repoError' } as const, null)
const token = atom({ plugin: 'fj', key: 'token' } as const, 'none')
const check = atom({ plugin: 'fj', key: 'check' } as const, { kind: 'idle' })

// The Token setting, read in `register`; a reload reads it again.
let configToken: string | null = null

// The host, owner and repo a git remote URL names, in any of the forms git
// takes: ssh://git@host:2222/o/r.git, git@host:o/r.git, https://host/o/r.
function parseRemote(url: string): Repo | null {
  const m =
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m?.[1] || !m[2] || !m[3]) return null
  return { host: m[1], owner: m[2], name: m[3] }
}

const slug = (r: Repo) => `${r.owner}/${r.name}`
const api = (r: Repo) => `https://${r.host}/api/v1/repos/${slug(r)}`

// The Forgejo repo behind `origin` of the directory the session runs in.
async function readRepo($: EngineInterface): Promise<Repo> {
  const run = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  if (run.exitCode !== 0) throw new Error('no git remote "origin" here')
  const url = run.stdout.trim()
  const r = parseRemote(url)
  if (!r) throw new Error(`cannot read a repo from ${url}`)
  return r
}

// The token for a request, and where it came from. The desktop app does not
// pass a shell's variables on, so the Token setting comes first.
async function readToken($: EngineInterface): Promise<{ value: string | null; from: TokenSource }> {
  if (configToken) return { value: configToken, from: 'setting' }
  const env = await $.env.get('FORGEJO_TOKEN')
  return env ? { value: env, from: 'FORGEJO_TOKEN' } : { value: null, from: 'none' }
}

async function fetchJson($: EngineInterface, url: string, name: string): Promise<unknown> {
  const { value } = await readToken($)
  if (!value) throw new Error('no token: set it with /plugin configure fj@egribnau-mods, or set FORGEJO_TOKEN')
  const res = await $.http.fetch(url, {
    method: 'GET',
    headers: { Authorization: `token ${value}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return JSON.parse(res.text)
}

// Reads the token's source and the repo again; local, so fast.
async function locate($: EngineInterface): Promise<Repo | null> {
  const from = (await readToken($)).from
  await update($, token, () => from)
  try {
    const r = await readRepo($)
    await update($, repo, () => r)
    await update($, repoError, () => null)
    return r
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, repo, () => null)
    await update($, repoError, () => message)
    await update($, check, (): Check => ({ kind: 'idle' }))
    return null
  }
}

// Asks Forgejo for the repo, which proves the host, the repo and the token.
async function checkRepo($: EngineInterface, r: Repo) {
  await update($, check, (): Check => ({ kind: 'loading' }))
  try {
    const info = (await fetchJson($, api(r), slug(r))) as { open_issues_count: number }
    await update($, check, (): Check => ({ kind: 'ok', openIssues: info.open_issues_count }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, check, (): Check => ({ kind: 'error', message }))
  }
}

async function refresh($: EngineInterface) {
  const r = await locate($)
  if (r) await checkRepo($, r)
}

export const register: Register = (on, options) => {
  configToken = String(options.token ?? '').trim() || null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fj', description: 'Open the Forgejo pane for this repo' })
    return next(e)
  })

  on('command.run', { command: 'fj' }, async ($, e) => {
    const r = await locate($)
    await $.ui.open({ id: PANE, title: r ? `fj · ${slug(r)}` : 'fj' })
    if (r) await checkRepo($, r)
    const from = await read($, token)
    return { text: r ? `fj opened for ${slug(r)} (token: ${from}).` : 'fj opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, repo)
    const rErr = await read($, repoError)
    const from = await read($, token)
    const c = await read($, check)

    const line = (text: string, props: Record<string, unknown> = {}) => (
      <Text wrap="truncate-end" {...props}>
        {text}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {r && line(`Repo: ${slug(r)} on ${r.host}`)}
        {!r && line(rErr ?? 'Run /fj in a repo to read its origin.', { color: rErr ? 'error' : undefined, dimColor: !rErr })}
        {line(`Token: ${from === 'none' ? 'none found' : `from ${from === 'setting' ? 'the Token setting' : 'FORGEJO_TOKEN'}`}`, {
          color: from === 'none' ? 'error' : undefined,
        })}
        {c.kind === 'loading' && line('Connecting…', { dimColor: true })}
        {c.kind === 'ok' && line(`Connected · ${c.openIssues} open issues`, { color: 'success' })}
        {c.kind === 'error' && line(c.message, { color: 'error' })}
        <Box height={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}
