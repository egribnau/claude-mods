import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Detail, IssueRow, Overview, Repo, Setup, TokenSource } from '../types'
import { day, dueText, duration, inkOn, loadIssue, wrap } from './issue'
import { pickNext, waitingText } from './next'

const PANE = 'fj'
const CONFIGURE = '/plugin configure fj@egribnau-mods'
const SCOPES = 'read:issue and read:repository'

const repo = atom({ plugin: 'fj', key: 'repo' } as const, null)
const version = atom({ plugin: 'fj', key: 'version' } as const, null)
const token = atom({ plugin: 'fj', key: 'token' } as const, 'none')
const setup = atom({ plugin: 'fj', key: 'setup' } as const, { kind: 'checking' })
const overview = atom({ plugin: 'fj', key: 'overview' } as const, { kind: 'idle' })
const picked = atom({ plugin: 'fj', key: 'picked' } as const, null)
const detail = atom({ plugin: 'fj', key: 'detail' } as const, { kind: 'idle' })
const iconsChosen = atom({ plugin: 'fj', key: 'icons' } as const, null)

// The Token setting, read in `register`; a reload reads it again.
let configToken: string | null = null
// The Icons setting: ask, icons or text.
let configIcons = 'ask'

// Nerd Font icons for the buttons (Material Design set).
const ICON = { refresh: '\u{F0450}', work: '\u{F0674}', open: '\u{F03CC}', back: '\u{F004D}' } as const

// Saves the Icons choice: in /config where the session offers it, and in the
// session's state so it shows at once.
async function chooseIcons($: EngineInterface, value: 'icons' | 'text') {
  await update($, iconsChosen, () => value)
  const rows = await $.config.list()
  const row = rows.find(r => /^fj(@[^.]*)?\.icons$/.test(r.key))
  if (!row) return
  const done = await $.config.set({ key: row.key, value })
  if (done.deny !== undefined) $.ui.toast(`Icons not saved: ${done.deny}`)
}

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

  // Forgejo or Gitea answers /api/v1/version without a token. Forgejo's
  // version carries `+gitea-…`, which is how the two are told apart.
  const res = await $.http
    .fetch(`${base(r)}/version`, { method: 'GET', headers: { Accept: 'application/json' } })
    .catch((err: unknown) => message(err))
  if (typeof res === 'string') {
    await update($, setup, (): Setup => ({ kind: 'not-forgejo', reason: 'no-answer', detail: res }))
    return r
  }
  let raw: unknown
  try {
    raw = res.ok ? (JSON.parse(res.text) as { version?: unknown }).version : undefined
  } catch {
    raw = undefined
  }
  if (typeof raw !== 'string') {
    const detail = `HTTP ${res.status} for /api/v1/version`
    await update($, setup, (): Setup => ({ kind: 'not-forgejo', reason: 'other', detail }))
    return r
  }
  const shown = `${raw.includes('+gitea-') ? '' : 'Gitea '}${raw.replace(/\+.*$/, '')}`
  await update($, version, () => shown)
  if (!supported(raw)) {
    await update($, setup, (): Setup => ({ kind: 'not-forgejo', reason: 'too-old', detail: shown }))
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

// Whether a Forgejo or Gitea version is 1.19 or newer, the first with
// scoped tokens. Forgejo numbers from 7.0 on are all newer.
function supported(version: string): boolean {
  const [major, minor] = version.split(/[.+-]/).map(Number)
  if (major === undefined || Number.isNaN(major)) return false
  return major > 1 || (major === 1 && (minor ?? 0) >= 19)
}

type RawListed = {
  number: number
  title: string
  created_at: string
  html_url: string
  body: string | null
  milestone: { title: string } | null
  labels: { name: string }[] | null
}
type RawFound = RawListed & { repository: { full_name: string } }
type RawOpen = RawListed & { assignee?: { login: string } | null; assignees?: { login: string }[] | null }

const toRow = (i: RawListed): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: (i.labels ?? []).map(l => l.name),
  created: i.created_at,
  url: i.html_url,
  body: i.body ?? '',
})

const oldestFirst = (a: IssueRow, b: IssueRow) => a.created.localeCompare(b.created)

// What's next in this repo. Two lists: your open issues, from Forgejo's
// search (it covers every repo the token sees, so it is narrowed to this
// one), and all open issues in the repo. Yours are In progress; of the rest,
// the unassigned ones are walked oldest first for Next.
async function loadOverview($: EngineInterface, r: Repo) {
  await update($, overview, (): Overview => ({ kind: 'loading' }))
  const tok = await readToken($)
  const headers = { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json' }
  // Every page of a list, 50 at a time.
  const all = async <T,>(url: string, what: string): Promise<T[]> => {
    const found: T[] = []
    for (let page = 1; ; page++) {
      const res = await $.http.fetch(`${url}&limit=50&page=${page}`, { method: 'GET', headers })
      if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
      const batch = JSON.parse(res.text) as T[]
      found.push(...batch)
      if (batch.length < 50) break
    }
    return found
  }
  try {
    const found = await all<RawFound>(`${base(r)}/repos/issues/search?assigned=true&state=open&type=issues`, 'your issues')
    const inProgress = found.filter(i => i.repository.full_name === slug(r)).map(toRow).sort(oldestFirst)
    const open = await all<RawOpen>(`${base(r)}/repos/${slug(r)}/issues?state=open&type=issues`, 'open issues')
    const yours = new Set(inProgress.map(i => i.number))
    const free = open
      .filter(i => !yours.has(i.number) && !i.assignee && (i.assignees ?? []).length === 0)
      .map(toRow)
      .sort(oldestFirst)
    const { next, queue, blocked } = await pickNext(free, async n => {
      const res = await $.http
        .fetch(`${base(r)}/repos/${slug(r)}/issues/${n}/dependencies`, { method: 'GET', headers })
        .catch(() => null)
      if (!res?.ok) return null
      try {
        const deps = JSON.parse(res.text) as { number: number; state: string }[]
        return deps.filter(d => d.state === 'open').map(d => d.number)
      } catch {
        return null
      }
    })
    await update($, overview, (): Overview => ({ kind: 'ok', inProgress, next, queue, blocked }))
    // An issue that is closed, or now someone else's, closes: What's next shows.
    const shown = new Set([...inProgress, ...free].map(i => i.number))
    await update($, picked, n => (n !== null && shown.has(n) ? n : null))
  } catch (err) {
    await update($, overview, (): Overview => ({ kind: 'error', message: message(err) }))
  }
}

// Reads issue `n` for the detail view.
async function loadDetail($: EngineInterface, r: Repo, n: number) {
  await update($, detail, (): Detail => ({ kind: 'loading', number: n }))
  const tok = await readToken($)
  const get = async (path: string) => {
    const res = await $.http
      .fetch(`${base(r)}/repos/${slug(r)}${path}`, {
        method: 'GET',
        headers: { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json' },
      })
      .catch(() => null)
    if (!res) return null
    let json: unknown = null
    try {
      json = res.ok ? JSON.parse(res.text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json }
  }
  try {
    const issue = await loadIssue(get, n)
    // Another issue opened while this one loaded wins.
    if ((await read($, picked)) !== n) return
    await update($, detail, (): Detail => ({ kind: 'ok', issue }))
  } catch (err) {
    if ((await read($, picked)) !== n) return
    await update($, detail, (): Detail => ({ kind: 'error', number: n, message: message(err) }))
  }
}

// Shows issue `n` in the detail view, or the list again for null.
async function openIssue($: EngineInterface, n: number | null) {
  await update($, picked, () => n)
  const r = await read($, repo)
  if (n === null || !r) {
    await update($, detail, (): Detail => ({ kind: 'idle' }))
    return
  }
  await loadDetail($, r, n)
}

// Checks setup and, once it passes, loads What's next and, when an issue is
// open, that issue again.
async function refresh($: EngineInterface): Promise<Repo | null> {
  const r = await check($)
  if (r && (await read($, setup)).kind === 'ready') {
    await loadOverview($, r)
    const n = await read($, picked)
    if (n !== null) await loadDetail($, r, n)
    else await update($, detail, (): Detail => ({ kind: 'idle' }))
  } else {
    await update($, overview, (): Overview => ({ kind: 'idle' }))
  }
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

// `text` cut to `width` characters, ending in … when it was longer. A Text
// inside a Button wraps rather than truncates, so titles are cut here.
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// What a draft is made from: the issue, and its last comment when known.
type DraftSource = Pick<IssueRow, 'number' | 'title' | 'url' | 'body'> & {
  lastComment?: { author: string; body: string } | null
}

// The prompt fj drafts for an issue: what to do, where the issue is, what it
// says, and the last word on it.
function draftFor(i: DraftSource): string {
  const parts = [`Work on #${i.number}: ${i.title}\n${i.url}`]
  const body = i.body.trim()
  if (body) parts.push(body)
  const last = i.lastComment?.body.trim()
  if (last) parts.push(`Last comment, by ${i.lastComment?.author}:\n${last}`)
  return parts.join('\n\n')
}

// Puts the draft for `i` in the prompt box, never sending it: over an empty
// box, under what is typed there otherwise.
async function workOn($: EngineInterface, i: DraftSource) {
  try {
    const draft = draftFor(i)
    const box = await $.prompt.read()
    const typed = box.text.trim() !== ''
    const done = await $.prompt.fill(typed ? { text: `\n\n${draft}`, mode: 'append' } : { text: draft, mode: 'replace' })
    $.ui.toast(
      done.isFilled
        ? `#${i.number} is in the prompt: Esc to edit it there`
        : `Could not put #${i.number} in the prompt${done.refusal ? ` (${done.refusal})` : ''}`,
    )
  } catch (err) {
    $.ui.toast(`Could not put #${i.number} in the prompt: ${message(err)}`)
  }
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
    case 'not-forgejo': {
      const host = r?.host ?? 'This host'
      return s.reason === 'no-answer'
        ? `${host} did not answer (${s.detail}). Check that https://${host} opens from this computer.`
        : s.reason === 'too-old'
          ? `fj needs Forgejo or Gitea 1.19 or newer, the first with scoped tokens (read:issue, read:repository). ${host} runs ${s.detail}.`
          : `${host} does not answer as Forgejo or Gitea (${s.detail}). fj works with Forgejo and Gitea only, so it has nothing to show for this repo.`
    }
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
      return []
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
  configIcons = String(options.icons ?? 'ask')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fj', description: 'Open the Forgejo pane for this repo' })
    return next(e)
  })

  on('command.run', { command: 'fj' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'fj' })
    const r = await refresh($)
    if (r) await $.ui.open({ id: PANE, title: `fj · ${slug(r)}` })
    const s = await read($, setup)
    const o = await read($, overview)
    if (s.kind !== 'ready' || !r) return { text: 'fj needs setting up: see its pane.' }
    if (o.kind !== 'ok') return { text: `fj is ready for ${slug(r)}, but could not load its issues.` }
    if (o.inProgress.length + o.queue.length + o.blocked.length === 0 && !o.next) {
      return { text: `fj is ready for ${slug(r)}: no open issues.` }
    }
    const then = o.next ? `next is #${o.next.number}` : o.blocked.length > 0 ? 'nothing ready' : 'nothing else open'
    return { text: `fj is ready for ${slug(r)}: ${o.inProgress.length} in progress, ${then}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, repo)
    const v = await read($, version)
    const from = await read($, token)
    const s = await read($, setup)
    const m = await read($, overview)
    // The pane's full height, so the last rows sit at its bottom.
    const height = e.props.scroll.bodyRows
    const icons = (await read($, iconsChosen)) ?? configIcons
    // A button's label: its icon when icons are on, else its words.
    const say = (icon: string, words: string) => (icons === 'icons' ? icon : words)
    const columns = e.props.bodyColumns

    const line = (key: string, text: string, props: Record<string, unknown> = {}) => (
      <Text key={key} wrap="truncate-end" {...props}>
        {text}
      </Text>
    )
    // A dim line that keeps its row when the list or detail under it is too
    // long for the pane: that is cut at its bottom, never by squeezing this out.
    const fixedLine = (key: string, text: string) => (
      <Box key={key} flexShrink={0}>
        {line(`${key}-text`, text, { dimColor: true })}
      </Box>
    )
    const rule = (key: string, name: string) => fixedLine(key, `── ${name} `.padEnd(columns, '─'))
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
      forgejo:
        s.kind === 'not-forgejo' && s.reason === 'no-answer'
          ? `no answer from ${r?.host ?? 'this host'}`
          : s.kind === 'not-forgejo' && s.reason === 'too-old'
            ? `${s.detail}, too old`
            : `not found at ${r?.host ?? 'this host'}`,
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
    const noForge = s.kind === 'not-forgejo'
    const steps = STEPS.map((step, i) => {
      const mark =
        s.kind === 'checking'
          ? '…'
          : (noRepo || noForge) && step === 'token'
            ? from === 'none' ? '✗' : '✓'
            : i < at ? '✓' : i === at ? '✗' : '·'
      const color = mark === '✓' ? 'success' : mark === '✗' ? 'error' : 'inactive'
      const text =
        mark === '✓'
          ? doneText[step]
          : mark === '✗'
            ? failText[step]
            : noRepo
              ? 'needs a repo'
              : noForge
                ? 'needs Forgejo'
                : ''
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
        {action && <Button key="refresh" label={say(ICON.refresh, action.label)} hotkey="r" onPress={() => refresh($)} />}
      </Box>
    )

    // Setup passed and Icons is still ask: the one-time choice, before the list.
    if (s.kind === 'ready' && r && icons === 'ask') {
      const glyphs = [
        { icon: ICON.refresh, name: 'refresh' },
        { icon: ICON.work, name: 'work on' },
        { icon: ICON.open, name: 'browser' },
        { icon: ICON.back, name: 'back' },
      ]
      return (
        <Box flexDirection="column" height={height}>
          <Box key="choice" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
            {heading('Forgejo for Claude is ready!')}
            {steps}
            <Box key="gap" height={1} />
            {line('ask', 'One choice: icons on buttons', { bold: true })}
            {para(
              'why',
              'fj can show its buttons as Nerd Font icons, which keeps them narrow. Look at the four below: do they show as icons, or as boxes or question marks?',
            )}
            <Box key="gap-glyphs" height={1} />
            <Box key="glyphs" height={1}>
              {glyphs.map(g => (
                <Box key={`g-${g.name}`} width={Math.max(10, Math.floor(columns / 4))}>
                  <Text>{`  ${g.icon}`}</Text>
                </Box>
              ))}
            </Box>
            <Box key="names" height={1}>
              {glyphs.map(g => (
                <Box key={`n-${g.name}`} width={Math.max(10, Math.floor(columns / 4))}>
                  <Text dimColor>{g.name}</Text>
                </Box>
              ))}
            </Box>
            <Box key="gap-look" height={1} />
            {line('look', 'Buttons would look like this:', { dimColor: true })}
            <Text key="sample">{glyphs.map(g => `[ ${g.icon} ]`).join('  ')}</Text>
            <Box key="choose" height={1} marginTop={1}>
              <Button key="use-icons" label="Use icons" onPress={() => chooseIcons($, 'icons')} />
              <Text>{'  '}</Text>
              <Button key="keep-text" label="Keep text" onPress={() => chooseIcons($, 'text')} />
            </Box>
            <Box key="gap-later" height={1} />
            {para('later', 'Asked once. Change it later in /config, under fj: Icons.', { dimColor: true })}
          </Box>
        </Box>
      )
    }

    // An issue open: its detail in place of the list.
    const open = await read($, picked)
    if (s.kind === 'ready' && r && open !== null) {
      const d = await read($, detail)
      const now = await $.clock.now()
      const top = (
        <Box key="title" height={1} flexShrink={0}>
          <Button key="back" label={say(ICON.back, "← What's next")} hotkey="b" onPress={() => openIssue($, null)} />
          <Box flexGrow={1} />
          <Button key="refresh" label={say(ICON.refresh, 'Refresh')} hotkey="r" onPress={() => refresh($)} />
        </Box>
      )
      const body: RenderChildren[] = []
      if (d.kind === 'loading' || d.kind === 'idle') body.push(line('loading', `Loading #${open}…`, { dimColor: true }))
      if (d.kind === 'error') body.push(para('error', `Could not load #${d.number}: ${d.message}.`, { color: 'error' }))
      if (d.kind === 'ok') {
        const i = d.issue
        const KEY = 15
        const keyed = (key: string, label: string, content: RenderChildren) => (
          <Box key={key} height={1} flexShrink={0}>
            <Text dimColor>{label.padEnd(KEY)}</Text>
            {content}
          </Box>
        )
        // One issue or pull request on a line: number, title, state.
        const refLine = (key: string, label: string, x: { number: number; title: string; state: string }, numColor: string) => {
          const state = x.state
          const done = state === 'closed'
          return keyed(
            key,
            label,
            <>
              <Text color={done ? 'inactive' : numColor}>{`#${x.number} `}</Text>
              <Text wrap="truncate-end" color={done ? 'inactive' : undefined} strikethrough={done && label !== 'Pull requests'}>
                {fit(x.title, columns - KEY - `#${x.number} `.length - state.length - 1)}
              </Text>
              <Box flexGrow={1} />
              <Text color={state === 'open' ? (numColor === 'error' ? 'error' : 'success') : state === 'merged' ? 'merged' : 'inactive'}>
                {` ${state}`}
              </Text>
            </>,
          )
        }
        const facts: RenderChildren[] = []
        if (i.due) {
          const due = dueText(i.due, now)
          facts.push(keyed('due', 'Due', <Text color={due.passed ? 'error' : 'warning'}>{due.text}</Text>))
        }
        if (i.branch) facts.push(keyed('branch', 'Branch', <Text color="success">{i.branch}</Text>))
        if (i.logged) facts.push(keyed('time', 'Time', <Text>{`${duration(i.logged)} logged`}</Text>))
        if (i.labels.length > 0) {
          facts.push(
            keyed(
              'labels',
              'Labels',
              <Text wrap="truncate-end">
                {i.labels.map((l, k) => (
                  <Text key={`label-${k}`}>
                    {k > 0 ? ' ' : ''}
                    <Text backgroundColor={`#${l.color}`} color={inkOn(l.color)}>{` ${l.name} `}</Text>
                  </Text>
                ))}
              </Text>,
            ),
          )
        }
        ;(i.blockedBy ?? []).forEach((x, k) => facts.push(refLine(`blocked-${k}`, k === 0 ? 'Blocked by' : '', x, 'error')))
        ;(i.blocks ?? []).forEach((x, k) => facts.push(refLine(`blocks-${k}`, k === 0 ? 'Blocks' : '', x, 'suggestion')))
        ;(i.pulls ?? []).forEach((x, k) => facts.push(refLine(`pull-${k}`, k === 0 ? 'Pull requests' : '', x, 'suggestion')))
        ;(i.commits ?? []).slice(0, 3).forEach((c, k) =>
          facts.push(
            keyed(
              `commit-${k}`,
              k === 0 ? 'Commits' : '',
              <>
                <Text color="warning">{`${c.sha} `}</Text>
                <Text wrap="truncate-end">{fit(c.message, columns - KEY - c.sha.length - 1 - age(c.when, now).length - 1)}</Text>
                <Box flexGrow={1} />
                <Text dimColor>{` ${age(c.when, now)}`}</Text>
              </>,
            ),
          ),
        )

        const titleLines = wrap(`#${i.number} ${i.title}`, columns).slice(0, 2)
        const milestone = i.milestone
          ? `${i.milestone.title}${i.milestone.due ? ` (due ${day(i.milestone.due, now)})` : ''}`
          : 'no milestone'
        const comments = `${i.comments} ${i.comments === 1 ? 'comment' : 'comments'}`

        // What is left for the description and the last comment.
        const fixed = 1 + titleLines.length + 2 + 1 + (facts.length > 0 ? facts.length + 1 : 0) + 1 + 1 + 1 + 1
        const last = i.lastComment
        const lastLines = last ? wrap(last.body.trim(), columns) : []
        const lastShown = Math.min(3, lastLines.length)
        const lastRows = last ? 1 + 1 + lastShown + 1 : 0
        const descLines = wrap(i.body.trim(), columns)
        const descRoom = Math.max(2, height - fixed - lastRows - 2)
        const descShown = descLines.length > descRoom ? descRoom - 1 : descLines.length

        body.push(
          <Box key="head" flexDirection="column" flexShrink={0}>
            {titleLines.map((t, k) => (
              <Text key={`t-${k}`} bold wrap="truncate-end">
                {k === 0 ? <Text color="suggestion">{`#${i.number}`}</Text> : null}
                {k === 0 ? t.slice(`#${i.number}`.length) : t}
              </Text>
            ))}
            <Text dimColor wrap="truncate-end">{`${i.state} · ${milestone} · ${comments}`}</Text>
            <Text dimColor wrap="truncate-end">{`opened ${age(i.created, now)} ago by ${i.author} · updated ${age(i.updated, now)} ago`}</Text>
          </Box>,
        )
        if (facts.length > 0) {
          body.push(
            <Box key="facts" flexDirection="column" flexShrink={0} marginTop={1}>
              {facts}
            </Box>,
          )
        }
        body.push(
          <Box key="actions" height={1} flexShrink={0} marginTop={1}>
            <Button key="work" label={say(ICON.work, 'Work on this')} hotkey="w" onPress={() => workOn($, i)} />
            <Text>{'  '}</Text>
            <Button key="open" label={say(ICON.open, 'Open in browser')} hotkey="o" onPress={() => openUrl($, i.url)} />
          </Box>,
        )
        body.push(<Box key="gap-desc" height={1} flexShrink={0} />, rule('desc', 'Description'))
        if (descLines.length === 0) body.push(line('no-desc', 'No description.', { dimColor: true }))
        descLines.slice(0, descShown).forEach((t, k) => body.push(line(`d-${k}`, t || ' ')))
        if (descShown < descLines.length) {
          body.push(line('d-more', `… ${descLines.length - descShown} more lines`, { dimColor: true }))
        }
        if (last) {
          body.push(
            <Box key="gap-last" height={1} flexShrink={0} />,
            rule('last', `Last comment ── ${last.author} · ${age(last.when, now)} ago`),
          )
          lastLines.slice(0, lastShown).forEach((t, k) => body.push(line(`c-${k}`, t || ' ')))
          if (lastShown < lastLines.length) {
            body.push(line('c-more', `… ${lastLines.length - lastShown} more lines`, { dimColor: true }))
          }
          if (i.comments > 1) {
            const earlier = i.comments - 1
            body.push(line('earlier', `${earlier} earlier ${earlier === 1 ? 'comment' : 'comments'}`, { dimColor: true }))
          }
        }
      }
      return (
        <Box flexDirection="column" height={height}>
          {top}
          <Box key="gap" height={1} flexShrink={0} />
          <Box key="detail" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
            {body}
          </Box>
          {fixedLine('where', `${r.host}/${slug(r)}`)}
        </Box>
      )
    }

    // Once setup passes and What's next has loaded or is loading, What's next.
    if (s.kind === 'ready' && r && m.kind !== 'idle' && m.kind !== 'error') {
      const now = await $.clock.now()
      const rows: RenderChildren[] = []
      if (m.kind === 'loading') rows.push(line('loading', 'Loading the issues…', { dimColor: true }))
      if (m.kind === 'ok') {
        const later = [...m.queue, ...m.blocked.map(b => b.issue)]
        const listed = [...m.inProgress, ...(m.next ? [m.next] : []), ...later]
        // The number column: the longest number and a space, so titles and
        // the lines under them line up whatever the numbers.
        const numWidth = Math.max(...listed.map(i => `#${i.number}`.length), 0) + 1
        // Each row starts with its section's mark, so it says where it
        // belongs with its heading scrolled away; the Queue's is blank.
        const MARK = { progress: ['● ', 'success'], next: ['▸ ', 'warning'], queue: ['  ', undefined], blocked: ['⊘ ', 'inactive'] } as const
        const indent = ' '.repeat(2 + numWidth)
        // One issue: its mark, number and title, a button that opens its
        // detail, and under it what is known about it. Next is bold and has
        // the focus first, so Enter opens it at once.
        const row = (i: IssueRow, section: keyof typeof MARK, blockedBy?: number[]) => {
          const facts = blockedBy
            ? [`blocked by ${blockedBy.map(n => `#${n}`).join(', ')}`, `opened ${age(i.created, now)} ago`].join(' · ')
            : [i.milestone, i.labels.join(', '), `opened ${age(i.created, now)} ago`].filter(Boolean).join(' · ')
          const dim = section === 'blocked'
          const next = section === 'next'
          const [mark, markColor] = MARK[section]
          return (
            <Box key={`issue-${i.number}`} flexDirection="column" marginBottom={1} flexShrink={0}>
              <Button key={`pick-${i.number}`} plain autoFocus={next || undefined} onPress={() => openIssue($, i.number)}>
                <Text wrap="truncate-end" bold={next} dimColor={dim}>
                  <Text color={markColor}>{mark}</Text>
                  <Text color={dim ? 'inactive' : 'suggestion'}>{`#${i.number}`.padEnd(numWidth)}</Text>
                  {fit(i.title, columns - 2 - numWidth)}
                </Text>
              </Button>
              <Box>
                <Text>{indent}</Text>
                <Text wrap="truncate-end" dimColor>
                  {facts}
                </Text>
              </Box>
            </Box>
          )
        }
        if (listed.length === 0) {
          rows.push(para('none', `No open issues in ${slug(r)}.`, { dimColor: true }))
        } else {
          rows.push(rule('in-progress', `In progress (${m.inProgress.length})`))
          if (m.inProgress.length === 0) {
            rows.push(
              <Box key="no-progress" flexDirection="column" marginBottom={1} flexShrink={0}>
                {para('no-progress-text', 'Nothing in progress. Assign yourself an issue to start.', { dimColor: true })}
              </Box>,
            )
          }
          for (const i of m.inProgress) rows.push(row(i, 'progress'))
          rows.push(rule('next', 'Next'))
          if (m.next) rows.push(row(m.next, 'next'))
          else if (m.blocked.length > 0) {
            rows.push(
              <Box key="nothing-ready" flexDirection="column" marginBottom={1} flexShrink={0}>
                {line('nothing-ready-title', 'Nothing ready', { bold: true })}
                {para('nothing-ready-why', waitingText(m.blocked), { dimColor: true })}
              </Box>,
            )
          } else {
            rows.push(
              <Box key="nothing-else" flexDirection="column" marginBottom={1} flexShrink={0}>
                {para('nothing-else-text', 'No other open issues.', { dimColor: true })}
              </Box>,
            )
          }
          if (later.length > 0) {
            rows.push(rule('queue', `Queue (${later.length})`))
            for (const i of m.queue) rows.push(row(i, 'queue'))
            for (const b of m.blocked) rows.push(row(b.issue, 'blocked', b.by))
          }
        }
      }
      return (
        <Box flexDirection="column" height={height}>
          {heading("What's next", { label: 'Refresh' })}
          <Box key="gap" height={1} flexShrink={0} />
          <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
            {rows}
          </Box>
          {fixedLine('where', `${r.host}/${slug(r)}`)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height={height}>
        <Box key="setup" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {m.kind === 'error' && para('overview-error', `Could not load the issues: ${m.message}.`, { color: 'error' })}
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
