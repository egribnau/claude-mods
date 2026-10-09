import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Repo, Setup, TokenSource } from '../types'

const PANE = 'fj'
const CONFIGURE = '/plugin configure fj@egribnau-mods'
const SCOPES = 'read:issue and read:repository'

const repo = atom({ plugin: 'fj', key: 'repo' } as const, null)
const version = atom({ plugin: 'fj', key: 'version' } as const, null)
const token = atom({ plugin: 'fj', key: 'token' } as const, 'none')
const setup = atom({ plugin: 'fj', key: 'setup' } as const, { kind: 'checking' })

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
const base = (r: Repo) => `https://${r.host}/api/v1`

// The token for a request, and where it came from. The desktop app does not
// pass a shell's variables on, so the Token setting comes first.
async function readToken($: EngineInterface): Promise<{ value: string | null; from: TokenSource }> {
  if (configToken) return { value: configToken, from: 'setting' }
  const env = await $.env.get('FORGEJO_TOKEN')
  return env ? { value: env, from: 'FORGEJO_TOKEN' } : { value: null, from: 'none' }
}

// An error's message, without the host's `fj: $.http.fetch: ` in front.
const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^[\w-]+: \$\.[\w.]+: /, '')

// Each step in turn, stopping at the first that fails: the repo behind
// origin, a Forgejo (or Gitea) at its host, a token, and the token reading
// the repo. Every step is written to the session's state as it ends.
async function check($: EngineInterface): Promise<Repo | null> {
  await update($, setup, (): Setup => ({ kind: 'checking' }))
  const tok = await readToken($)
  await update($, token, () => tok.from)

  const run = await $.process.run(['git', 'remote', 'get-url', 'origin']).catch(() => null)
  const url = run?.exitCode === 0 ? run.stdout.trim() : null
  const r = url ? parseRemote(url) : null
  await update($, repo, () => r)
  await update($, version, () => null)
  if (!r) {
    const detail = url ? `cannot read a repo from ${url}` : 'no git remote "origin" here'
    await update($, setup, (): Setup => ({ kind: 'no-repo', detail }))
    return null
  }

  try {
    const res = await $.http.fetch(`${base(r)}/version`, { method: 'GET', headers: { Accept: 'application/json' } })
    const v = res.ok ? (JSON.parse(res.text) as { version?: unknown }).version : undefined
    if (typeof v !== 'string') throw new Error(`HTTP ${res.status} for /api/v1/version`)
    await update($, version, () => v.replace(/\+.*$/, ''))
  } catch (err) {
    await update($, setup, (): Setup => ({ kind: 'not-forgejo', detail: message(err) }))
    return r
  }

  if (!tok.value) {
    await update($, setup, (): Setup => ({ kind: 'no-token' }))
    return r
  }

  try {
    const res = await $.http.fetch(`${base(r)}/repos/${slug(r)}`, {
      method: 'GET',
      headers: { Authorization: `token ${tok.value}`, Accept: 'application/json' },
    })
    const next: Setup = res.ok
      ? { kind: 'ready', openIssues: (JSON.parse(res.text) as { open_issues_count: number }).open_issues_count }
      : res.status === 401
        ? { kind: 'token-refused' }
        : res.status === 403
          ? { kind: 'no-scope' }
          : res.status === 404
            ? { kind: 'not-found' }
            : { kind: 'error', message: `${slug(r)}: HTTP ${res.status}` }
    await update($, setup, () => next)
  } catch (err) {
    await update($, setup, (): Setup => ({ kind: 'error', message: message(err) }))
  }
  return r
}

type Step = 'repo' | 'forgejo' | 'token' | 'access'
const STEPS: readonly Step[] = ['repo', 'forgejo', 'token', 'access']
const LABEL: Record<Step, string> = { repo: 'Repo', forgejo: 'Forgejo', token: 'Token', access: 'Access' }

// The step each outcome stopped at; `ready` is past them all.
const STOPPED_AT: Record<Setup['kind'], number> = {
  checking: -1,
  'no-repo': 0,
  'not-forgejo': 1,
  'no-token': 2,
  'token-refused': 3,
  'no-scope': 3,
  'not-found': 3,
  error: 3,
  ready: 4,
}

// What to do about the step that failed, one line per action.
function todo(s: Setup, r: Repo | null, tokenText: string): string[] {
  const page = r ? `https://${r.host}/user/settings/applications` : 'Settings › Applications in Forgejo'
  const create = `Create a token at ${page} with ${SCOPES}.`
  const set = [
    `Run ${CONFIGURE} and paste it as Token.`,
    'Or export FORGEJO_TOKEN before starting claude in a terminal (the desktop app does not read ~/.zshenv).',
  ]
  switch (s.kind) {
    case 'no-repo':
      return [
        s.detail.startsWith('no git')
          ? 'fj found no git remote "origin" in this directory.'
          : `fj could not read a repo from origin: ${s.detail.replace(/^cannot read a repo from /, '')}.`,
        'Start claude in a clone of a repo hosted on Forgejo or Gitea.',
      ]
    case 'not-forgejo':
      return [
        `${r?.host ?? 'This host'} does not answer as Forgejo or Gitea (${s.detail}).`,
        'fj works with Forgejo and Gitea only. If this is one, check that it is reachable over https.',
      ]
    case 'no-token':
      return [create, ...set]
    case 'token-refused':
      return [`Forgejo did not accept the token ${tokenText}: it may be mistyped, expired or revoked.`, create, ...set]
    case 'no-scope':
      return [`The token ${tokenText} is valid but may not read this repo.`, create, ...set]
    case 'not-found':
      return [
        `${r ? slug(r) : 'The repo'} was not found, or the token's owner cannot see it.`,
        'For a private repo, use a token of a user who has access to it.',
      ]
    case 'error':
      return [`Forgejo could not be asked: ${s.message}.`]
    default:
      return []
  }
}

export const register: Register = (on, options) => {
  configToken = String(options.token ?? '').trim() || null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fj', description: 'Open the Forgejo pane for this repo' })
    return next(e)
  })

  on('command.run', { command: 'fj' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'fj' })
    const r = await check($)
    if (r) await $.ui.open({ id: PANE, title: `fj · ${slug(r)}` })
    const s = await read($, setup)
    return { text: s.kind === 'ready' && r ? `fj is ready for ${slug(r)}.` : 'fj needs setting up: see its pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, repo)
    const v = await read($, version)
    const from = await read($, token)
    const s = await read($, setup)

    const line = (key: string, text: string, props: Record<string, unknown> = {}) => (
      <Text key={key} wrap="truncate-end" {...props}>
        {text}
      </Text>
    )
    const para = (key: string, text: string, props: Record<string, unknown> = {}) => (
      <Text key={key} wrap="wrap" {...props}>
        {text}
      </Text>
    )

    const tokenText =
      from === 'setting' ? 'from the Token setting' : from === 'FORGEJO_TOKEN' ? 'from FORGEJO_TOKEN' : 'none found'
    const doneText: Record<Step, string> = {
      repo: r ? `${slug(r)} on ${r.host}` : '',
      forgejo: v ? `version ${v}` : '',
      token: tokenText,
      access: s.kind === 'ready' ? `${s.openIssues} open issues` : '',
    }
    const failText: Record<Step, string> = {
      repo: 'not found',
      forgejo: `not at ${r?.host ?? 'this host'}`,
      token: 'none found',
      access: 'refused',
    }
    const at = STOPPED_AT[s.kind]
    const steps = STEPS.map((step, i) => {
      const mark = s.kind === 'checking' ? '…' : i < at ? '✓' : i === at ? '✗' : '·'
      const color = mark === '✓' ? 'success' : mark === '✗' ? 'error' : 'inactive'
      const text = mark === '✓' ? doneText[step] : mark === '✗' ? failText[step] : ''
      return line(`step-${step}`, `${mark} ${LABEL[step].padEnd(8)}${text}`, { color })
    })

    const body: RenderChildren[] = []
    if (s.kind === 'ready') {
      body.push(line('ready', 'Ready.', { color: 'success', bold: true }))
    } else if (s.kind !== 'checking') {
      const actions = todo(s, r, tokenText)
      body.push(line('todo', 'What to do', { bold: true }))
      actions.forEach((t, i) => body.push(para(`todo-${i}`, `${i + 1}. ${t}`)))
      body.push(para('again', `${actions.length + 1}. Press r to check again.`, { dimColor: true }))
    }

    return (
      <Box flexDirection="column">
        {line('title', s.kind === 'ready' ? 'fj' : 'Set up fj', { bold: true })}
        {steps}
        <Box key="gap" height={1} />
        {body}
        <Box key="buttons" height={1} marginTop={1}>
          <Button key="refresh" label="Check again" hotkey="r" onPress={() => check($)} />
        </Box>
      </Box>
    )
  })
}
