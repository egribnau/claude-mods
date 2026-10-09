import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Mine, MyIssue, Repo, Setup, TokenSource } from '../types'

const PANE = 'fj'
const CONFIGURE = '/plugin configure fj@egribnau-mods'
const SCOPES = 'read:issue and read:repository'

const repo = atom({ plugin: 'fj', key: 'repo' } as const, null)
const version = atom({ plugin: 'fj', key: 'version' } as const, null)
const token = atom({ plugin: 'fj', key: 'token' } as const, 'none')
const setup = atom({ plugin: 'fj', key: 'setup' } as const, { kind: 'checking' })
const mine = atom({ plugin: 'fj', key: 'mine' } as const, { kind: 'idle' })
const picked = atom({ plugin: 'fj', key: 'picked' } as const, null)

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

// The token for a request: the Token setting, kept in secure storage. It is
// the only source, so the token is the same in the terminal and the app.
async function readToken(_$: EngineInterface): Promise<{ value: string | null; from: TokenSource }> {
  return configToken ? { value: configToken, from: 'setting' } : { value: null, from: 'none' }
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

  const git = async (...args: string[]) => {
    const run = await $.process.run(['git', ...args]).catch(() => null)
    return run?.exitCode === 0 ? run.stdout.trim() : null
  }
  const url = await git('remote', 'get-url', 'origin')
  const r = url ? parseRemote(url) : null
  await update($, repo, () => r)
  await update($, version, () => null)
  if (!r) {
    const inRepo = url !== null || (await git('rev-parse', '--is-inside-work-tree')) === 'true'
    const pwd = await $.process.run(['pwd']).catch(() => null)
    const dir = (pwd?.exitCode === 0 ? pwd.stdout.trim() : 'this folder').replace(/^\/(?:Users|home)\/[^/]+/, '~')
    const next: Setup = !inRepo
      ? { kind: 'no-repo', reason: 'not-git', dir }
      : url === null
        ? { kind: 'no-repo', reason: 'no-origin', dir }
        : { kind: 'no-repo', reason: 'bad-origin', dir, origin: url }
    await update($, setup, () => next)
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

type RawFound = {
  number: number
  title: string
  created_at: string
  html_url: string
  milestone: { title: string } | null
  labels: { name: string }[] | null
  repository: { full_name: string }
}

// Your open issues in this repo, oldest first. Forgejo's search covers every
// repo the token sees, so it is narrowed to this one here.
async function loadMine($: EngineInterface, r: Repo) {
  await update($, mine, (): Mine => ({ kind: 'loading' }))
  const tok = await readToken($)
  try {
    const found: RawFound[] = []
    for (let page = 1; ; page++) {
      const res = await $.http.fetch(
        `${base(r)}/repos/issues/search?assigned=true&state=open&type=issues&limit=50&page=${page}`,
        { method: 'GET', headers: { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json' } },
      )
      if (!res.ok) throw new Error(`your issues: HTTP ${res.status}`)
      const batch = JSON.parse(res.text) as RawFound[]
      found.push(...batch)
      if (batch.length < 50) break
    }
    const issues: MyIssue[] = found
      .filter(i => i.repository.full_name === slug(r))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(i => ({
        number: i.number,
        title: i.title,
        milestone: i.milestone?.title ?? null,
        labels: (i.labels ?? []).map(l => l.name),
        created: i.created_at,
        url: i.html_url,
      }))
    await update($, mine, (): Mine => ({ kind: 'ok', issues }))
    // A selected issue that is no longer yours, or closed, is unselected.
    await update($, picked, n => (n !== null && issues.some(i => i.number === n) ? n : null))
  } catch (err) {
    await update($, mine, (): Mine => ({ kind: 'error', message: message(err) }))
  }
}

// Checks setup and, once it passes, loads your issues.
async function refresh($: EngineInterface): Promise<Repo | null> {
  const r = await check($)
  if (r && (await read($, setup)).kind === 'ready') await loadMine($, r)
  else await update($, mine, (): Mine => ({ kind: 'idle' }))
  return r
}

// Opens `url` in the browser of the computer the session runs on: `open`
// on macOS, `xdg-open` elsewhere.
async function openUrl($: EngineInterface, url: string) {
  for (const cmd of ['open', 'xdg-open']) {
    const run = await $.process.run([cmd, url]).catch(() => null)
    if (run?.exitCode === 0) return
  }
  $.ui.toast(`Could not open a browser for ${url}`)
}

// How long ago `iso` was, as a short age: 5m, 3h, 6d, 3w, 4mo, 2y.
function age(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)
  if (d < 14) return `${d}d`
  if (d < 60) return `${Math.floor(d / 7)}w`
  if (d < 730) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
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

// What the pane says about the step that failed, before what to do.
function intro(s: Setup, r: Repo | null, tokenText: string): string | null {
  const what = 'fj shows the issues of the repo this session runs in.'
  switch (s.kind) {
    case 'no-repo':
      return s.reason === 'not-git'
        ? `${what} ${s.dir} is not a git repo, so there is nothing to show here.`
        : s.reason === 'no-origin'
          ? `${what} This repo has no remote origin.`
          : `${what} origin is ${s.origin}, which names no host.`
    case 'token-refused':
      return `Forgejo did not accept the token ${tokenText}: it may be mistyped, expired or revoked.`
    case 'no-scope':
      return `The token ${tokenText} is valid but may not read this repo.`
    case 'not-found':
      return `${r ? slug(r) : 'The repo'}, from origin, was not found, or the token's owner cannot see it.`
    case 'error':
      return `Forgejo could not be asked: ${s.message}.`
    default:
      return null
  }
}

// What to do about the step that failed, one line per action.
function todo(s: Setup, r: Repo | null, tokenText: string): string[] {
  const page = r ? `https://${r.host}/user/settings/applications` : 'Settings › Applications in Forgejo'
  const create = `Create a token at ${page} with ${SCOPES}.`
  const set = [`Run \`${CONFIGURE}\` and paste it as Token.`]
  switch (s.kind) {
    case 'no-repo': {
      const remote = 'https://your-forgejo/owner/repo.git'
      return [
        s.reason === 'not-git'
          ? `If this folder belongs on Forgejo: \`git init\` and \`git remote add origin ${remote}\`, then press r.`
          : s.reason === 'no-origin'
            ? `If this repo is on Forgejo: \`git remote add origin ${remote}\`, then press r.`
            : `If this repo is on Forgejo: \`git remote set-url origin ${remote}\`, then press r.`,
      ]
    }
    case 'not-forgejo':
      return [
        `${r?.host ?? 'This host'} does not answer as Forgejo or Gitea (${s.detail}).`,
        'fj works with Forgejo and Gitea only. If this is one, check that it is reachable over https.',
      ]
    case 'no-token':
      return [create, ...set]
    case 'token-refused':
    case 'no-scope':
      return [create, ...set]
    case 'not-found':
      return [
        `If origin points to the wrong repo: \`git remote set-url origin https://${r?.host ?? 'your-forgejo'}/owner/repo.git\`.`,
        'If the repo is private, create the token as a user who can see it.',
        ...set,
      ]
    case 'error':
      return []
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
    const r = await refresh($)
    if (r) await $.ui.open({ id: PANE, title: `fj · ${slug(r)}` })
    const s = await read($, setup)
    const m = await read($, mine)
    if (s.kind !== 'ready' || !r) return { text: 'fj needs setting up: see its pane.' }
    if (m.kind !== 'ok') return { text: `fj is ready for ${slug(r)}, but could not load your issues.` }
    const n = m.issues.length
    return { text: `fj is ready for ${slug(r)}: ${n} ${n === 1 ? 'issue' : 'issues'} assigned to you.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, repo)
    const v = await read($, version)
    const from = await read($, token)
    const s = await read($, setup)
    const m = await read($, mine)
    // The pane's full height, so the last rows sit at its bottom.
    const height = e.props.scroll.bodyRows

    const line = (key: string, text: string, props: Record<string, unknown> = {}) => (
      <Text key={key} wrap="truncate-end" {...props}>
        {text}
      </Text>
    )
    // A wrapped paragraph in which `a command` shows as a command and an
    // https:// address as a link; the backticks themselves are not drawn.
    const para = (key: string, text: string, props: Record<string, unknown> = {}) => {
      const parts: RenderChildren[] = []
      text.split(/`([^`]+)`/).forEach((piece, i) => {
        if (i % 2 === 1) {
          parts.push(<Text key={`${key}-c${i}`} color="warning">{piece}</Text>)
          return
        }
        piece.split(/(https:\/\/\S+?)(?=[.,;:)]?(?:\s|$))/).forEach((bit, j) => {
          if (bit === '') return
          parts.push(
            j % 2 === 1 ? (
              <Text key={`${key}-u${i}-${j}`} color="suggestion" underline>
                {bit}
              </Text>
            ) : (
              bit
            ),
          )
        })
      })
      return (
        <Text key={key} wrap="wrap" {...props}>
          {parts}
        </Text>
      )
    }

    const tokenText =
      from === 'setting' ? 'from the Token setting' : 'none found'
    const doneText: Record<Step, string> = {
      repo: r ? slug(r) : '',
      forgejo: v && r ? `${v} at ${r.host}` : '',
      token: tokenText,
      access: s.kind === 'ready' ? `${s.openIssues} open issues` : '',
    }
    const failText: Record<Step, string> = {
      repo: 'no Forgejo repo here',
      forgejo: `not at ${r?.host ?? 'this host'}`,
      token: 'none found',
      access:
        s.kind === 'token-refused'
          ? 'token refused'
          : s.kind === 'no-scope'
            ? 'no permission'
            : s.kind === 'not-found'
              ? 'not found'
              : 'no answer',
    }
    const at = STOPPED_AT[s.kind]
    // Without a repo the token is still checked: it needs none. The steps
    // that do say so.
    const noRepo = s.kind === 'no-repo'
    const steps = STEPS.map((step, i) => {
      const mark =
        s.kind === 'checking'
          ? '…'
          : noRepo && step === 'token'
            ? from === 'none' ? '✗' : '✓'
            : i < at ? '✓' : i === at ? '✗' : '·'
      const color = mark === '✓' ? 'success' : mark === '✗' ? 'error' : 'inactive'
      const text =
        mark === '✓' ? doneText[step] : mark === '✗' ? failText[step] : noRepo ? 'needs a repo' : ''
      return line(`step-${step}`, `${mark} ${LABEL[step].padEnd(8)}${text}`, { color })
    })

    const body: RenderChildren[] = []
    if (s.kind !== 'ready' && s.kind !== 'checking') {
      const about = intro(s, r, tokenText)
      if (about) body.push(para('intro', about), <Box key="gap-intro" height={1} />)
      const actions = todo(s, r, tokenText)
      if (actions.length > 0) body.push(line('todo', 'What to do', { bold: true }))
      actions.forEach((t, i) => body.push(para(`todo-${i}`, `${i + 1}. ${t}`)))
      // Checking again is the guide's last step, so its button ends it.
      body.push(
        <Box key="again" height={1} marginTop={1} paddingLeft={3}>
          <Button key="refresh" label="Check again" hotkey="r" onPress={() => refresh($)} />
        </Box>,
      )
    }

    // A heading with, on its right, the pane's own action when it has one.
    const heading = (text: string, action?: { label: string }) => (
      <Box key="title" height={1} flexShrink={0}>
        <Text bold wrap="truncate-end">
          {text}
        </Text>
        <Box flexGrow={1} />
        {action && <Button key="refresh" label={action.label} hotkey="r" onPress={() => refresh($)} />}
      </Box>
    )

    // Once setup passes and the list has loaded or is loading, the list.
    if (s.kind === 'ready' && r && m.kind !== 'idle' && m.kind !== 'error') {
      const now = await $.clock.now()
      const rows: RenderChildren[] = []
      if (m.kind === 'loading') rows.push(line('loading', 'Loading your issues…', { dimColor: true }))
      if (m.kind === 'ok' && m.issues.length === 0) {
        rows.push(para('none', `No open issues assigned to you in ${slug(r)}.`, { dimColor: true }))
      }
      if (m.kind === 'ok') {
        const sel = await read($, picked)
        for (const i of m.issues) {
          const isPicked = sel === i.number
          const facts = [i.milestone ?? 'no milestone', i.labels.join(', '), `opened ${age(i.created, now)} ago`]
            .filter(Boolean)
            .join(' · ')
          rows.push(
            <Box key={`issue-${i.number}`} flexDirection="column" marginBottom={1}>
              <Button
                key={`pick-${i.number}`}
                plain
                onPress={() => update($, picked, n => (n === i.number ? null : i.number))}
              >
                <Text wrap="truncate-end" bold={isPicked} inverse={isPicked}>
                  <Text color="suggestion">{`#${i.number}`.padEnd(5)}</Text>
                  {i.title}
                </Text>
              </Button>
              <Box>
                <Text>{'     '}</Text>
                <Text wrap="truncate-end" dimColor>
                  {facts}
                </Text>
              </Box>
              {isPicked && (
                <Box key="actions" height={1} marginTop={1} paddingLeft={5}>
                  <Button key="open" label="Open in browser" hotkey="o" onPress={() => openUrl($, i.url)} />
                </Box>
              )}
            </Box>,
          )
        }
      }
      const count = m.kind === 'ok' ? ` (${m.issues.length})` : ''
      return (
        <Box flexDirection="column" height={height}>
          {heading(`My issues${count}`, { label: 'Refresh' })}
          <Box key="gap" height={1} flexShrink={0} />
          <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
            {rows}
          </Box>
          {line('where', `${r.host}/${slug(r)}`, { dimColor: true })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height={height}>
        <Box key="setup" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {m.kind === 'error' && para('mine-error', `Could not load your issues: ${m.message}.`, { color: 'error' })}
          {s.kind === 'ready'
            ? heading('Forgejo for Claude is ready!', { label: 'Refresh' })
            : heading('Set up Forgejo for Claude')}
          {steps}
          <Box key="gap" height={1} />
          {body}
        </Box>
      </Box>
    )
  })
}
