import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, RenderChildren, RenderInput } from 'claude-code'

import type { Actions, Detail, Epic, EpicChild, EpicGroup, Epics, IssueDetail, IssueRow, Overview, Repo, Setup, TokenSource } from '../types'
import { bar, groupsFor, openChildren, pickerOptions, standing, summary, tally } from './epics'
import { day, dueText, duration, loadIssue, readable, wrap } from './issue'
import { pickNext, waitingText } from './next'

const PANE = 'fj'
const EPICS_PANE = 'fj-epics'
const CONFIGURE = '/plugin configure fj@egribnau-mods'
const SCOPES = 'read:issue, read:repository and read:user'

const repo = atom({ plugin: 'fj', key: 'repo' } as const, null)
const version = atom({ plugin: 'fj', key: 'version' } as const, null)
const token = atom({ plugin: 'fj', key: 'token' } as const, 'none')
const setup = atom({ plugin: 'fj', key: 'setup' } as const, { kind: 'checking' })
const overview = atom({ plugin: 'fj', key: 'overview' } as const, { kind: 'idle' })
// Per pane, keyed by its id: each opens issues in a detail view of its own.
const picked = atom({ plugin: 'fj', key: 'picked' } as const, null)
const detail = atom({ plugin: 'fj', key: 'detail' } as const, { kind: 'idle' })
const iconsChosen = atom({ plugin: 'fj', key: 'icons' } as const, null)
const compactChosen = atom({ plugin: 'fj', key: 'compact' } as const, null)
const epics = atom({ plugin: 'fj', key: 'epics' } as const, { kind: 'idle' })
const unfolded = atom({ plugin: 'fj', key: 'unfolded' } as const, [])
const panesOpen = atom({ plugin: 'fj', key: 'panesOpen' } as const, [])
const milestonePick = atom({ plugin: 'fj', key: 'milestonePick' } as const, null)
const picker = atom({ plugin: 'fj', key: 'picker' } as const, null)
const pickerOpen = atom({ plugin: 'fj', key: 'pickerOpen' } as const, false)
const requests = atom({ plugin: 'fj', key: 'requests' } as const, null)

// Every request fj sends Forgejo, counted, so Debug can say what each action cost.
let requestsMade = 0
function forgejo($: EngineInterface, url: string, init: Parameters<EngineInterface['http']['fetch']>[1]) {
  requestsMade++
  return $.http.fetch(url, init)
}

// Runs an action and records how many requests it sent, under `label`.
async function counted<T>($: EngineInterface, label: string, action: () => Promise<T>): Promise<T> {
  const before = requestsMade
  const result = await action()
  const count = requestsMade - before
  await update($, requests, last => ({ label, count, total: (last?.total ?? 0) + count }))
  return result
}

// The Token setting, read in `register`; a reload reads it again.
let configToken: string | null = null
// The Icons setting: ask, icons or text.
let configIcons = 'ask'
// The Compact setting: ask, on or off.
let configCompact = 'ask'
// The Epic label setting: the label that makes an issue an epic.
let configLabel = 'epic'
// The Debug setting: count fj's requests on a line under the repo line.
let configDebug = false

// Nerd Font icons for the buttons (Material Design set).
const ICON = {
  refresh: '\u{F0450}',
  work: '\u{F0674}',
  open: '\u{F03CC}',
  back: '\u{F004D}',
  assign: '\u{F0014}',
  unassign: '\u{F0015}',
  close: '\u{F012C}',
  reopen: '\u{F099B}',
} as const

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

// Saves the Compact choice the same way.
async function chooseCompact($: EngineInterface, value: 'on' | 'off') {
  await update($, compactChosen, () => value)
  const rows = await $.config.list()
  const row = rows.find(r => /^fj(@[^.]*)?\.compact$/.test(r.key))
  if (!row) return
  const done = await $.config.set({ key: row.key, value })
  if (done.deny !== undefined) $.ui.toast(`Compact not saved: ${done.deny}`)
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
  const res = await forgejo($, `${base(r)}/version`, { method: 'GET', headers: { Accept: 'application/json' } })
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
    const res = await forgejo($, `${base(r)}/repos/${slug(r)}`, {
      method: 'GET',
      headers: { Authorization: `token ${tok.value}`, Accept: 'application/json' },
    })
    const headers = { Authorization: `token ${tok.value}`, Accept: 'application/json' }
    // Who the token belongs to, once the repo answers: what makes an issue yours.
    const user = res.ok ? await forgejo($, `${base(r)}/user`, { method: 'GET', headers }) : null
    const login = user?.ok ? (JSON.parse(user.text) as { login: string }).login : null
    const next: Setup = user?.ok && login !== null
      ? {
          kind: 'ready',
          openIssues: (JSON.parse(res.text) as { open_issues_count: number }).open_issues_count,
          login,
          actions: await mayAct($, r, tok.value, login, (JSON.parse(res.text) as RawRepo).permissions?.push === true),
          features: {
            time: (JSON.parse(res.text) as RawRepo).internal_tracker?.enable_time_tracker !== false,
            deps: (JSON.parse(res.text) as RawRepo).internal_tracker?.enable_issue_dependencies !== false,
          },
        }
      : user && (user.status === 401 || user.status === 403)
        ? { kind: 'no-scope', missing: 'read:user' }
        : user
          ? { kind: 'error', message: `/user: HTTP ${user.status}` }
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

type RawRepo = {
  open_issues_count: number
  permissions?: { push?: boolean }
  internal_tracker?: { enable_time_tracker?: boolean; enable_issue_dependencies?: boolean }
}

// Whether fj may assign and close: the token's scopes, from the list of the
// account's tokens (the one ending in the same eight characters), and push
// rights on the repo. A list Forgejo refuses leaves it unknown.
async function mayAct($: EngineInterface, r: Repo, token: string, login: string, push: boolean): Promise<Actions> {
  const res = await forgejo($, `${base(r)}/users/${encodeURIComponent(login)}/tokens?limit=50`, {
    method: 'GET',
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  }).catch(() => null)
  let scopes: string[] | null = null
  try {
    const list = res?.ok ? (JSON.parse(res.text) as { token_last_eight?: string; scopes?: string[] | null }[]) : null
    scopes = list?.find(t => t.token_last_eight === token.slice(-8))?.scopes ?? null
  } catch {
    scopes = null
  }
  if (scopes === null) return push ? { kind: 'unknown' } : { kind: 'read-only', reason: 'push' }
  if (!scopes.some(sc => sc === 'all' || sc === 'write:issue' || sc === 'write:all')) return { kind: 'read-only', reason: 'scope' }
  return push ? { kind: 'ok' } : { kind: 'read-only', reason: 'push' }
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
  labels: { name: string; color?: string }[] | null
}
type RawFound = RawListed & { repository: { full_name: string } }
type RawOpen = RawListed & { assignee?: { login: string } | null; assignees?: { login: string }[] | null }

const toRow = (i: RawListed): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: (i.labels ?? []).map(l => ({ name: l.name, color: l.color ?? '' })),
  created: i.created_at,
  url: i.html_url,
  body: i.body ?? '',
})

const oldestFirst = (a: IssueRow, b: IssueRow) => a.created.localeCompare(b.created)

// Every page of a list, 50 at a time; a page that fails names `what`.
async function fetchAll<T>($: EngineInterface, url: string, what: string): Promise<T[]> {
  const tok = await readToken($)
  const headers = { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json' }
  const found: T[] = []
  for (let page = 1; ; page++) {
    const res = await forgejo($, `${url}&limit=50&page=${page}`, { method: 'GET', headers })
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
    const batch = JSON.parse(res.text) as T[]
    found.push(...batch)
    if (batch.length < 50) break
  }
  return found
}

// One request's JSON, or null when it failed.
async function fetchJson<T>($: EngineInterface, url: string): Promise<T | null> {
  const tok = await readToken($)
  const res = await forgejo($, url, {
    method: 'GET',
    headers: { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json' },
  })
    .catch(() => null)
  if (!res?.ok) return null
  try {
    return JSON.parse(res.text) as T
  } catch {
    return null
  }
}

type RawDep = {
  number: number
  title: string
  state: string
  assignees?: { login: string }[] | null
  labels?: { name: string; color?: string }[] | null
  milestone?: { title: string } | null
  created_at?: string
}
type RawEpic = RawDep & { milestone: { title: string } | null; labels: { name: string }[] | null }
type RawMilestone = { title: string; due_on: string | null; open_issues: number; closed_issues: number }
type MilestoneRow = { title: string; due: string | null; closed: number; total: number }

// What fj remembers of a repo until the next Refresh or /fj, so the picker
// can switch without asking Forgejo again: its open milestones, your open
// issues and the free ones, the dependencies checked so far, the epics, and
// the children of each epic loaded so far.
type Memory = {
  repo: string
  milestones: MilestoneRow[]
  mine: IssueRow[]
  free: IssueRow[]
  blockers: Map<number, number[] | null>
  epics: (Omit<RawEpic, 'milestone'> & { milestone: string | null })[]
  children: Map<number, EpicChild[] | null>
}
let memory: Memory | null = null

// Whether an issue's milestone is in what the picker picked.
const inPick = (pick: string, milestone: string | null) =>
  pick === 'all' || (pick === 'none' ? milestone === null : pick === `m:${milestone}`)

// Asks Forgejo for what the panes show: the open milestones (none when the
// list is refused), your open issues from Forgejo's search (it covers every
// repo the token sees, so it is narrowed to this one), the repo's open
// issues, and the epics. Then the picker, What's next and the epics follow.
async function load($: EngineInterface, r: Repo) {
  const api = `${base(r)}/repos/${slug(r)}`
  memory = null
  if ((await read($, overview)).kind !== 'ok') await update($, overview, (): Overview => ({ kind: 'loading' }))
  if ((await read($, epics)).kind !== 'ok') await update($, epics, (): Epics => ({ kind: 'loading' }))
  const milestones = (await fetchAll<RawMilestone>($, `${api}/milestones?state=open`, 'milestones').catch(() => [])).map(m => ({
    title: m.title,
    due: m.due_on,
    closed: m.closed_issues,
    total: m.open_issues + m.closed_issues,
  }))
  let mine: IssueRow[] = []
  let free: IssueRow[] = []
  try {
    const found = await fetchAll<RawFound>($, `${base(r)}/repos/issues/search?assigned=true&state=open&type=issues`, 'your issues')
    mine = found.filter(i => i.repository.full_name === slug(r)).map(toRow).sort(oldestFirst)
    const open = await fetchAll<RawOpen>($, `${api}/issues?state=open&type=issues`, 'open issues')
    const yours = new Set(mine.map(i => i.number))
    free = open.filter(i => !yours.has(i.number) && !i.assignee && (i.assignees ?? []).length === 0).map(toRow).sort(oldestFirst)
  } catch (err) {
    await update($, overview, (): Overview => ({ kind: 'error', message: message(err) }))
  }
  let found: Memory['epics'] = []
  try {
    const label = configLabel
    found = (await fetchAll<RawEpic>($, `${api}/issues?state=all&type=issues&labels=${encodeURIComponent(label)}`, 'epics'))
      .filter(i => (i.labels ?? []).some(l => l.name === label))
      .map(i => ({ ...i, milestone: i.milestone?.title ?? null }))
  } catch (err) {
    await update($, epics, (): Epics => ({ kind: 'error', message: message(err) }))
  }
  memory = { repo: `${r.host}/${slug(r)}`, milestones, mine, free, blockers: new Map(), epics: found, children: new Map() }
  const failed = (await read($, overview)).kind === 'error'
  await showPicker($)
  if (!failed) await showNext($, r)
  if ((await read($, epics)).kind !== 'error') await showEpics($, r)
}

// The picker's options from what is open, and the pick: the person's when it
// is still offered, else the first milestone, else All.
async function showPicker($: EngineInterface) {
  if (!memory) return
  const items = [...memory.mine, ...memory.free, ...memory.epics.filter(e => e.state === 'open')]
  const options = pickerOptions(memory.milestones, items)
  const wanted = await read($, milestonePick)
  const pick = options.some(o => o.value === wanted)
    ? (wanted as string)
    : (options.find(o => o.value.startsWith('m:'))?.value ?? 'all')
  await update($, picker, () => ({ options, pick }))
}

// What's next within the pick: yours in it are In progress; of the free ones
// in it, walked oldest first, the first with no open dependencies is Next.
async function showNext($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const pick = (await read($, picker))?.pick ?? 'all'
  const inProgress = known.mine.filter(i => inPick(pick, i.milestone))
  const free = known.free.filter(i => inPick(pick, i.milestone))
  const { next, queue, blocked } = await pickNext(free, async n => {
    if (known.blockers.has(n)) return known.blockers.get(n) ?? null
    const deps = await fetchJson<{ number: number; state: string }[]>($, `${base(r)}/repos/${slug(r)}/issues/${n}/dependencies`)
    const open = deps ? deps.filter(d => d.state === 'open').map(d => d.number) : null
    known.blockers.set(n, open)
    return open
  })
  await update($, overview, (): Overview => ({ kind: 'ok', inProgress, next, queue, blocked }))
  // An issue that is closed, or now someone else's, closes: What's next shows.
  const shown = new Set([...known.mine, ...known.free].map(i => i.number))
  await update($, memberOf(picked, { requestId: PANE }), n => (n !== null && shown.has(n) ? n : null))
}

// The epics within the pick, by milestone. For each open epic shown, its
// children: the issues it depends on, with whether each is yours and, for
// the others, whether it is blocked. What was shown stays up while this
// loads, so the picker does not vanish under the person's hand.
async function showEpics($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const api = `${base(r)}/repos/${slug(r)}`
  const openEpics = known.epics.filter(i => i.state === 'open').length
  if (openEpics === 0) {
    await update($, epics, (): Epics => ({ kind: 'ok', groups: [], openEpics }))
    return
  }
  // Who you are, from the setup check: the children assigned to you are yours.
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const pick = (await read($, picker))?.pick ?? 'all'
  const deps = (n: number) => fetchJson<RawDep[]>($, `${api}/issues/${n}/dependencies`)
  const loadOne = async (i: Memory['epics'][number]): Promise<Epic> => {
    const state = i.state === 'closed' ? 'closed' : 'open'
    if (state === 'closed') return { number: i.number, title: i.title, state, children: null }
    if (known.children.has(i.number)) return { number: i.number, title: i.title, state, children: known.children.get(i.number) ?? null }
    const raw = await deps(i.number)
    const children = raw
      ? await Promise.all(
          raw.map(async (c): Promise<EpicChild> => {
            const assignees = (c.assignees ?? []).map(a => a.login)
            const open = c.state !== 'closed'
            const mine = me !== null && assignees.includes(me)
            // Only an open child that is not yours is checked for what blocks it.
            const blockedBy = open && !mine ? ((await deps(c.number)) ?? []).filter(d => d.state !== 'closed').map(d => d.number) : []
            return {
              number: c.number,
              title: c.title,
              state: open ? 'open' : 'closed',
              assignees,
              mine,
              blocked: blockedBy.length > 0,
              labels: (c.labels ?? []).map(l => ({ name: l.name, color: l.color ?? '' })),
              milestone: c.milestone?.title ?? null,
              created: c.created_at ?? '',
              blockedBy,
            }
          }),
        )
      : null
    known.children.set(i.number, children)
    return { number: i.number, title: i.title, state, children }
  }
  try {
    const groups: EpicGroup[] = await Promise.all(
      groupsFor(pick, known.milestones, known.epics).map(async g => {
        const shown = await Promise.all(g.epics.map(loadOne))
        shown.sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0) || a.number - b.number)
        const m = g.milestone
        return { title: m?.title ?? null, due: m?.due ?? null, closed: m?.closed ?? 0, total: m?.total ?? 0, epics: shown }
      }),
    )
    await update($, epics, (): Epics => ({ kind: 'ok', groups, openEpics }))
  } catch (err) {
    await update($, epics, (): Epics => ({ kind: 'error', message: message(err) }))
  }
}

// Picks a milestone for both panes and closes the picker's list.
async function pickMilestone($: EngineInterface, value: string) {
  await update($, pickerOpen, () => false)
  await update($, milestonePick, () => value)
  const r = await read($, repo)
  const label = (await read($, picker))?.options.find(o => o.value === value)?.label ?? value
  if (!r) return
  await counted($, label, async () => {
    await showPicker($)
    if ((await read($, overview)).kind === 'ok') await showNext($, r)
    await showEpics($, r)
  })
}

// The issues read for a detail view, by repo and number, kept until the next
// Refresh or /fj, so opening one again asks Forgejo nothing.
const issuesRead = new Map<string, IssueDetail>()

// Reads issue `n` for the detail view of pane `pane`, or shows it from memory.
async function loadDetail($: EngineInterface, r: Repo, pane: string, n: number) {
  const key = `${r.host}/${slug(r)}#${n}`
  const known = issuesRead.get(key)
  if (known) {
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'ok', issue: known }))
    return
  }
  await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'loading', number: n }))
  const tok = await readToken($)
  const get = async (path: string) => {
    const res = await forgejo($, `${base(r)}/repos/${slug(r)}${path}`, {
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
    const s = await read($, setup)
    const issue = await loadIssue(get, n, s.kind === 'ready' ? s.features : undefined)
    issuesRead.set(key, issue)
    // Another issue opened while this one loaded wins.
    if ((await read($, memberOf(picked, { requestId: pane }))) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'ok', issue }))
  } catch (err) {
    if ((await read($, memberOf(picked, { requestId: pane }))) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'error', number: n, message: message(err) }))
  }
}

// Shows issue `n` in the detail view of pane `pane`, or its list again for null.
async function openIssue($: EngineInterface, pane: string, n: number | null) {
  await update($, memberOf(picked, { requestId: pane }), () => n)
  const r = await read($, repo)
  if (n === null || !r) {
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
    return
  }
  await counted($, `#${n}`, () => loadDetail($, r, pane, n))
}

// Checks setup and, once it passes, loads What's next and the epics and,
// where an issue is open, that issue again.
async function refresh($: EngineInterface): Promise<Repo | null> {
  issuesRead.clear()
  const r = await check($)
  if (r && (await read($, setup)).kind === 'ready') {
    await load($, r)
    for (const pane of [PANE, EPICS_PANE]) {
      const n = await read($, memberOf(picked, { requestId: pane }))
      if (n !== null) await loadDetail($, r, pane, n)
      else await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
    }
  } else {
    await update($, overview, (): Overview => ({ kind: 'idle' }))
    await update($, epics, (): Epics => ({ kind: 'idle' }))
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

// Changes issue `n` in Forgejo (`what` names the change for a refusal), then
// reads it again with What's next and the epics, so the change shows
// everywhere. A refusal is shown under the actions of pane `pane`.
async function writeIssue($: EngineInterface, pane: string, n: number, body: object, what: string): Promise<boolean> {
  const r = await read($, repo)
  if (!r) return false
  const tok = await readToken($)
  const res = await forgejo($, `${base(r)}/repos/${slug(r)}/issues/${n}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${tok.value ?? ''}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err: unknown) => message(err))
  if (typeof res === 'string' || !res.ok) {
    let why = typeof res === 'string' ? res : `HTTP ${res.status}`
    if (typeof res !== 'string') {
      try {
        why = (JSON.parse(res.text) as { message?: string }).message || why
      } catch {
        // The status says enough.
      }
    }
    const error = `Could not ${what} #${n}: ${why.replace(/\.$/, '')}.`
    await update($, memberOf(detail, { requestId: pane }), (d): Detail => (d.kind === 'ok' ? { ...d, error } : d))
    return false
  }
  issuesRead.delete(`${r.host}/${slug(r)}#${n}`)
  for (const p of [PANE, EPICS_PANE]) {
    if ((await read($, memberOf(picked, { requestId: p }))) === n) await loadDetail($, r, p, n)
  }
  await load($, r)
  return true
}

// You on issue `i`, or off it; other assignees stay.
async function assignMe($: EngineInterface, pane: string, i: IssueDetail, on: boolean): Promise<boolean> {
  const s = await read($, setup)
  if (s.kind !== 'ready') return false
  const others = i.assignees.filter(a => a !== s.login)
  return writeIssue($, pane, i.number, { assignees: on ? [...others, s.login] : others }, on ? 'assign' : 'unassign')
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
// With the actions allowed and the issue not yet yours, it is assigned to
// you first.
async function workOn($: EngineInterface, i: DraftSource, take?: { pane: string; issue: IssueDetail }) {
  let taken = false
  if (take) {
    const s = await read($, setup)
    if (s.kind === 'ready' && s.actions.kind !== 'read-only' && !take.issue.assignees.includes(s.login)) {
      taken = await counted($, `assign #${i.number}`, () => assignMe($, take.pane, take.issue, true))
    }
  }
  try {
    const draft = draftFor(i)
    const box = await $.prompt.read()
    const typed = box.text.trim() !== ''
    const done = await $.prompt.fill(typed ? { text: `\n\n${draft}`, mode: 'append' } : { text: draft, mode: 'replace' })
    $.ui.toast(
      done.isFilled
        ? `#${i.number} is ${taken ? 'yours and ' : ''}in the prompt: Esc to edit it there`
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

type Step = 'repo' | 'forgejo' | 'token' | 'access' | 'actions'
const STEPS: readonly Step[] = ['repo', 'forgejo', 'token', 'access', 'actions']
const LABEL: Record<Step, string> = { repo: 'Repo', forgejo: 'Forgejo', token: 'Token', access: 'Access', actions: 'Actions' }

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
  ready: 5,
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
      return s.missing
        ? `The token ${tokenText} reads ${r ? slug(r) : 'the repo'}, but not who it belongs to: fj needs ${s.missing} too.`
        : `The token ${tokenText} is valid but may not read this repo.`
    case 'not-found':
      return `${r ? slug(r) : 'The repo'}, from origin, was not found, or the token's owner cannot see it.`
    case 'error':
      return `Forgejo could not be asked: ${s.message}.`
    case 'not-forgejo': {
      const host = r?.host ?? 'This host'
      return s.reason === 'no-answer'
        ? `${host} did not answer (${s.detail}). Check that https://${host} opens from this computer.`
        : s.reason === 'too-old'
          ? `fj needs Forgejo or Gitea 1.19 or newer, the first with scoped tokens (read:issue, read:repository, read:user). ${host} runs ${s.detail}.`
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

// A pane closing, by fj or by the person: the other one, now without a tab,
// names itself in its title row again.
const paneClosed: Hook<'ui.close'> = async ($, e, next) => {
  await update($, panesOpen, ids => ids.filter(id => id !== e.id))
  return next(e)
}

// A change to Icons or Compact in /config, or by fj's own choice buttons:
// the session follows it, so the setting wins over an earlier choice.
const settingChanged: Hook<'config.set'> = async ($, e, next) => {
  const done = await next(e)
  const field = /^fj(?:@[^.]*)?\.(icons|compact)$/.exec(e.key)?.[1]
  const value = String(e.value)
  if (field === 'icons' && (value === 'icons' || value === 'text' || value === 'ask')) {
    configIcons = value
    await update($, iconsChosen, () => (value === 'ask' ? null : value))
  }
  if (field === 'compact' && (value === 'on' || value === 'off' || value === 'ask')) {
    configCompact = value
    await update($, compactChosen, () => (value === 'ask' ? null : value))
  }
  return done
}

// Both panes draw here: they share setup, the detail view and the repo line.
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const inEpics = e.requestId === EPICS_PANE
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
    access: s.kind === 'ready' ? `${s.openIssues} open issues, as ${s.login}` : '',
    actions: 'assign and close',
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
    actions: '',
    access:
      s.kind === 'token-refused'
        ? 'token refused'
        : s.kind === 'no-scope'
          ? s.missing ? `no ${s.missing}` : 'no permission'
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
    // Actions that cannot be done are no failure: setup passes, read only.
    if (step === 'actions' && s.kind === 'ready' && s.actions.kind !== 'ok') {
      const why =
        s.actions.kind === 'unknown'
          ? 'unknown, scopes not listed'
          : s.actions.reason === 'scope'
            ? 'read only, token lacks write:issue'
            : `read only, ${s.login} may not push here`
      return line(`step-${step}`, `· ${LABEL[step].padEnd(8)}${why}`, { color: 'inactive' })
    }
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
        <Button key="refresh" label="Check again" hotkey="r" onPress={() => counted($, 'Refresh', () => refresh($))} />
      </Box>,
    )
  }

  // Labels as text, each in its Forgejo colour (made lighter when too dark),
  // dim when it has none; commas between them dim.
  const labelTexts = (labels: readonly { name: string; color: string }[]) =>
    labels.flatMap((l, k) => {
      const color = readable(l.color)
      return [
        ...(k > 0 ? [<Text key={`lsep-${k}`} dimColor>{', '}</Text>] : []),
        <Text key={`label-${k}`} color={color} dimColor={!color}>
          {l.name}
        </Text>,
      ]
    })
  // Compact: no empty line between rows, anywhere.
  const compact = ((await read($, compactChosen)) ?? configCompact) === 'on'
  const gap = compact ? 0 : 1
  const today = await $.clock.now()
  // One issue as both lists show it: its mark, number and title on a button
  // that opens it, and under it, dim, its milestone (unless it is the one
  // picked), its labels in colour and its age, or what blocks it. `lead`
  // indents it under an epic; `who` names someone else's at the right.
  type RowIssue = Pick<IssueRow, 'number' | 'title' | 'labels' | 'milestone' | 'created'>
  type RowLook = {
    key: string
    buttonKey: string
    numWidth: number
    mark: string
    markColor?: string
    dim?: boolean
    bold?: boolean
    autoFocus?: boolean
    lead?: number
    who?: string
    blockedBy?: number[]
    onPress: () => unknown
  }
  const issueRow = (i: RowIssue, o: RowLook) => {
    const lead = ' '.repeat(o.lead ?? 0)
    const opened = i.created ? `opened ${age(i.created, today)} ago` : ''
    const parts: RenderChildren[] = (
      o.blockedBy && o.blockedBy.length > 0
        ? [`blocked by ${o.blockedBy.map(n => `#${n}`).join(', ')}`, opened]
        : [pk?.pick === `m:${i.milestone}` ? null : i.milestone, i.labels.length > 0 ? labelTexts(i.labels) : null, opened]
    ).filter(p => p !== null && p !== '')
    const facts = parts.flatMap((p, k) => [
      ...(k > 0 ? [<Text key={`sep-${k}`} dimColor>{' · '}</Text>] : []),
      ...(typeof p === 'string'
        ? [
            <Text key={`part-${k}`} dimColor>
              {p}
            </Text>,
          ]
        : (p as RenderChildren[])),
    ])
    const room = columns - (o.lead ?? 0) - 2 - o.numWidth
    return (
      <Box key={o.key} flexDirection="column" marginBottom={gap} flexShrink={0}>
        <Button key={o.buttonKey} plain autoFocus={o.autoFocus || undefined} onPress={o.onPress}>
          <Text wrap="truncate-end" bold={o.bold} dimColor={o.dim}>
            {lead}
            <Text color={o.markColor}>{o.mark}</Text>
            <Text color={o.dim ? 'inactive' : 'suggestion'}>{`${`#${i.number}`.padStart(o.numWidth - 1)} `}</Text>
            {o.who ? `${fit(i.title, room - o.who.length - 1).padEnd(room - o.who.length - 1)} ` : fit(i.title, room)}
            {o.who && <Text dimColor>{o.who}</Text>}
          </Text>
        </Button>
        <Box>
          <Text>{`${lead}${' '.repeat(2 + o.numWidth)}`}</Text>
          <Text wrap="truncate-end">{facts}</Text>
        </Box>
      </Box>
    )
  }
  // With Debug on, under the repo line: what the last action and the session
  // asked Forgejo.
  const req = configDebug ? await read($, requests) : null
  const counter = req && (
    <Box key="requests" height={1} flexShrink={0}>
      <Text dimColor>{`↯ ${req.label}: `}</Text>
      <Text>{String(req.count)}</Text>
      <Text dimColor>{' requests'}</Text>
      <Box flexGrow={1} />
      <Text>{String(req.total)}</Text>
      <Text dimColor>{' this session'}</Text>
    </Box>
  )
  // The milestone picker both panes share, and what it shows picked.
  const pk = await read($, picker)
  const pickedOption = pk?.options.find(o => o.value === pk.pick)
  // A section's name within the pick: "in v1.2", "without a milestone", or
  // nothing for All.
  const within = !pk || pk.pick === 'all' ? '' : pk.pick === 'none' ? ' without a milestone' : ` in ${pickedOption?.label ?? ''}`
  // The title row both lists share: the pane's name when no tab names it,
  // the picker, Refresh; with the picker open, its list under it at the
  // right, each milestone with its due date and the one picked in bold.
  const titleRow = async (name: string) => {
    const listOpen = pk !== null && pickedOption !== undefined && (await read($, pickerOpen))
    const today = await $.clock.now()
    // One block that keeps its rows however long the list under it: a long
    // list once squeezed the title row out of the pane.
    return (
      <Box key="top" flexDirection="column" flexShrink={0}>
        <Box key="title" height={1} flexShrink={0}>
          {!tabbed && (
            <Text bold wrap="truncate-end">
              {name}
            </Text>
          )}
          <Box flexGrow={1} />
          {pickedOption && (
            <Button key="milestone" label={`${pickedOption.label} ▾`} hotkey="m" onPress={() => update($, pickerOpen, o => !o)} />
          )}
          <Box width={2} />
          <Button key="refresh" label={say(ICON.refresh, 'Refresh')} hotkey="r" onPress={() => counted($, 'Refresh', () => refresh($))} />
        </Box>
        {listOpen && pk && (
          <Box key="choices" flexDirection="column" flexShrink={0} paddingLeft={Math.max(0, columns - 20)}>
            {pk.options.map(o => (
              <Button key={`milestone-${o.value}`} plain onPress={() => pickMilestone($, o.value)}>
                <Text bold={o.value === pk.pick}>{`${o.label.padEnd(14)}${o.due ? day(o.due, today) : ''}`.padEnd(20)}</Text>
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  }
  // With another fj pane open the engine draws tabs that name both, so a
  // title row leaves its pane's name out.
  const tabbed = (await read($, panesOpen)).some(id => id !== e.requestId)
  // A heading with, on its right, the pane's own action when it has one.
  const heading = (text: string, action?: { label: string }) => (
    <Box key="title" height={1} flexShrink={0}>
      {text && (
        <Text bold wrap="truncate-end">
          {text}
        </Text>
      )}
      <Box flexGrow={1} />
      {action && <Button key="refresh" label={say(ICON.refresh, action.label)} hotkey="r" onPress={() => counted($, 'Refresh', () => refresh($))} />}
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

  // Icons chosen, Compact still ask: the second one-time choice, two rows
  // each way to choose by.
  if (s.kind === 'ready' && r && icons !== 'ask' && ((await read($, compactChosen)) ?? configCompact) === 'ask') {
    const sample = (spaced: boolean) => [
      <Text key={`a-${spaced}`}>
        <Text color="suggestion">{'  #37 '}</Text>
        Token refresh on 401
      </Text>,
      <Text key={`a2-${spaced}`} dimColor>
        {'      opened 1w ago'}
      </Text>,
      ...(spaced ? [<Box key={`gap-${spaced}`} height={1} />] : []),
      <Text key={`b-${spaced}`}>
        <Text color="suggestion">{'  #51 '}</Text>
        Rate limit settings page
      </Text>,
      <Text key={`b2-${spaced}`} dimColor>
        {'      opened 6d ago'}
      </Text>,
    ]
    return (
      <Box flexDirection="column" height={height}>
        <Box key="choice" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {heading('Forgejo for Claude is ready!')}
          {steps}
          <Box key="gap" height={1} />
          {line('ask', 'One more choice: space between rows', { bold: true })}
          {para('why', 'Lists can keep an empty line between issues, or sit compact. Two rows each way:')}
          <Box key="gap-space" height={1} />
          {line('with', 'With space', { dimColor: true })}
          {sample(true)}
          <Box key="gap-compact" height={1} />
          {line('without', 'Compact', { dimColor: true })}
          {sample(false)}
          <Box key="choose" height={1} marginTop={1}>
            <Button key="keep-space" label="Keep space" onPress={() => chooseCompact($, 'off')} />
            <Text>{'  '}</Text>
            <Button key="compact" label="Compact" onPress={() => chooseCompact($, 'on')} />
          </Box>
          <Box key="gap-later" height={1} />
          {para('later', 'Asked once, after Icons. Change it later in /config, under fj: Compact.', { dimColor: true })}
        </Box>
      </Box>
    )
  }

  // An issue open: its detail in place of the list.
  const open = await read($, memberOf(picked, e))
  if (s.kind === 'ready' && r && open !== null) {
    const d = await read($, memberOf(detail, e))
    const now = await $.clock.now()
    const top = (
      <Box key="title" height={1} flexShrink={0}>
        <Button
          key="back"
          label={say(ICON.back, inEpics ? '← Epics' : "← What's next")}
          hotkey="b"
          onPress={() => openIssue($, e.requestId, null)}
        />
        <Box flexGrow={1} />
        <Button key="refresh" label={say(ICON.refresh, 'Refresh')} hotkey="r" onPress={() => counted($, 'Refresh', () => refresh($))} />
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
            <Text wrap="truncate-end">{labelTexts(i.labels)}</Text>,
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
      // Assign and close, when fj may: setup's Actions step says so.
      const acts = s.kind === 'ready' ? s.actions : ({ kind: 'read-only', reason: 'scope' } as const)
      const canAct = acts.kind !== 'read-only'
      const mine = s.kind === 'ready' && i.assignees.includes(s.login)
      const closed = i.state === 'closed'
      const error = d.kind === 'ok' ? d.error : undefined
      const actionRows = 2 + (canAct ? 0 : 2) + (error ? 2 : 0)
      const fixed = 1 + titleLines.length + 2 + actionRows + (facts.length > 0 ? facts.length + 1 : 0) + 1 + 1 + 1 + 1
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
      // Right under the title, so they never scroll away with a long issue.
      body.push(
        <Box key="actions" flexDirection="column" flexShrink={0} marginTop={1}>
          <Box height={1}>
            <Button
              key="work"
              label={say(ICON.work, 'Work on this')}
              hotkey="w"
              onPress={() => workOn($, i, { pane: e.requestId, issue: i })}
            />
            {canAct && <Text>{'  '}</Text>}
            {canAct && (
              <Button
                key="assign"
                label={say(mine ? ICON.unassign : ICON.assign, mine ? 'Unassign me' : 'Assign me')}
                hotkey="a"
                onPress={() => counted($, `${mine ? 'unassign' : 'assign'} #${i.number}`, () => assignMe($, e.requestId, i, !mine))}
              />
            )}
            {canAct && <Text>{'  '}</Text>}
            {canAct && (
              <Button
                key="close"
                label={say(closed ? ICON.reopen : ICON.close, closed ? 'Reopen' : 'Close')}
                hotkey="c"
                onPress={() =>
                  counted($, `${closed ? 'reopen' : 'close'} #${i.number}`, () =>
                    writeIssue($, e.requestId, i.number, { state: closed ? 'open' : 'closed' }, closed ? 'reopen' : 'close'),
                  )
                }
              />
            )}
          </Box>
          <Box height={1}>
            <Button key="open" label={say(ICON.open, 'Open in browser')} hotkey="o" onPress={() => openUrl($, i.url)} />
          </Box>
          {!canAct &&
            para('read-only', "Assign and close need a token with write:issue: the setup guide's steps make one.", { dimColor: true })}
          {error && para('action-error', error, { color: 'error' })}
        </Box>,
      )
      if (facts.length > 0) {
        body.push(
          <Box key="facts" flexDirection="column" flexShrink={0} marginTop={1}>
            {facts}
          </Box>,
        )
      }
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
        {counter}
      </Box>
    )
  }

  // The Epics pane, once setup passes.
  const ep = await read($, epics)
  if (inEpics && s.kind === 'ready' && r) {
    const now = await $.clock.now()
    const folds = new Set(await read($, unfolded))
    const groups = ep.kind === 'ok' ? ep.groups : []
    const rows: RenderChildren[] = []
    if (ep.kind === 'loading' || ep.kind === 'idle') rows.push(line('loading', 'Loading the epics…', { dimColor: true }))
    if (ep.kind === 'error') rows.push(para('error', `Could not load the epics: ${ep.message}.`, { color: 'error' }))
    if (ep.kind === 'ok' && groups.length === 0) rows.push(para('none', `No open epics in ${slug(r)}.`, { dimColor: true }))
    const open = (x: Epic) => x.state === 'open' && folds.has(x.number)
    // One number column for every group, so all titles line up.
    const numbers = groups.flatMap(g =>
      g.epics.flatMap(x => [x.number, ...(open(x) ? openChildren(x.children ?? []).map(c => c.number) : [])]),
    )
    const numWidth = Math.max(0, ...numbers.map(n => `#${n}`.length)) + 1
    const num = (n: number) => `${`#${n}`.padStart(numWidth - 1)} `
    // Bar and count at the right of an epic's row: 15 columns.
    const titleWidth = Math.max(0, columns - 2 - numWidth - 15)
    const indent = ' '.repeat(2 + numWidth)
    groups.forEach((g, gi) => {
      // The group's rule: the milestone's name bright, the rest dim.
      const name = g.title ?? 'No milestone'
      const rest = g.title ? `${g.due ? ` · due ${day(g.due, now)}` : ''} · ${g.closed}/${g.total} closed ` : ' '
      rows.push(
        // After the first, an extra empty line sets the group apart from the last epic above.
        <Box key={`group-${gi}`} height={1} flexShrink={0} marginTop={gi > 0 ? 1 : 0}>
          <Text dimColor>{'── '}</Text>
          <Text bold>{name}</Text>
          <Text dimColor>{rest}</Text>
          <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(0, columns - 3 - name.length - rest.length))}</Text>
        </Box>,
      )
      for (const x of g.epics) {
        // A closed epic has nothing to fold; its row opens its detail.
        if (x.state === 'closed') {
          rows.push(
            <Box key={`epic-${x.number}`} flexShrink={0}>
              <Button key={`epic-${x.number}`} plain onPress={() => openIssue($, EPICS_PANE, x.number)}>
                <Text wrap="truncate-end" dimColor>
                  {`  ${num(x.number)}${fit(x.title, titleWidth).padEnd(titleWidth)} ${'✓ closed'.padStart(14)}`}
                </Text>
              </Button>
            </Box>,
          )
          continue
        }
        const t = tally(x.children ?? [])
        const b = bar(t.closed, t.total)
        rows.push(
          <Box key={`epic-${x.number}`} flexDirection="column" flexShrink={0} marginBottom={open(x) ? 0 : gap}>
            {/* Two targets: the mark folds, the rest of the row opens the epic. */}
            <Box height={1}>
              <Button
                key={`fold-${x.number}`}
                plain
                onPress={() =>
                  update($, unfolded, ns => (ns.includes(x.number) ? ns.filter(n => n !== x.number) : [...ns, x.number]))
                }
              >
                <Text>{open(x) ? '− ' : '+ '}</Text>
              </Button>
              <Button key={`epic-${x.number}`} plain onPress={() => openIssue($, EPICS_PANE, x.number)}>
                <Text wrap="truncate-end">
                  <Text color="suggestion">{num(x.number)}</Text>
                  <Text bold>{`${fit(x.title, titleWidth).padEnd(titleWidth)} `}</Text>
                  {b.filled && <Text color="success">{b.filled}</Text>}
                  {b.empty && <Text dimColor>{b.empty}</Text>}
                  <Text dimColor>{`${t.closed}/${t.total}`.padStart(6)}</Text>
                </Text>
              </Button>
            </Box>
            {!open(x) && (
              <Box>
                <Text>{indent}</Text>
                {summary(x).flatMap((part, k) => [
                  ...(k > 0 ? [<Text key={`sep-${k}`} dimColor>{' · '}</Text>] : []),
                  <Text key={`part-${k}`} color={part.color} dimColor={!part.color}>
                    {part.text}
                  </Text>,
                ])}
              </Box>
            )}
          </Box>,
        )
        if (!open(x)) continue
        // Folded open: its open children, then how many are closed.
        const kids: RenderChildren[] = []
        for (const c of openChildren(x.children ?? [])) {
          const st = standing(c)
          kids.push(
            issueRow(c, {
              key: `child-row-${c.number}`,
              buttonKey: `child-${c.number}`,
              numWidth,
              lead: 2,
              mark: st === 'mine' ? '● ' : st === 'blocked' ? '⊘ ' : '  ',
              markColor: st === 'mine' ? 'success' : undefined,
              dim: st === 'blocked',
              who: st === 'taken' || (st === 'blocked' && c.assignees.length > 0) ? (c.assignees[0] ?? '') : '',
              blockedBy: st === 'blocked' ? c.blockedBy : undefined,
              onPress: () => openIssue($, EPICS_PANE, c.number),
            }),
          )
        }
        if (t.closed > 0) kids.push(line(`closed-${x.number}`, `  ✓ ${t.closed} closed`, { color: 'inactive' }))
        if (x.children === null) kids.push(line(`unknown-${x.number}`, `${indent}children unknown`, { dimColor: true }))
        else if (t.total === 0) kids.push(line(`none-${x.number}`, `${indent}no children`, { dimColor: true }))
        // The last child row brings its own empty line; a closing line needs one.
        const endsInRow = t.closed === 0 && x.children !== null && t.total > 0
        rows.push(
          <Box key={`kids-${x.number}`} flexDirection="column" flexShrink={0} marginBottom={endsInRow ? 0 : gap}>
            {kids}
          </Box>,
        )
      }
    })
    const shown = groups.flatMap(g => g.epics)
    const yours = shown.reduce((n, x) => n + tally(x.children ?? []).mine, 0)
    const openShown = shown.filter(x => x.state === 'open').length
    const g = groups.length > 0
    return (
      <Box flexDirection="column" height={height}>
        {await titleRow('Epics')}
        <Box key="gap" height={1} flexShrink={0} />
        <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {rows}
        </Box>
        {fixedLine('where-rule', '─'.repeat(columns))}
        <Box key="where" height={1} flexShrink={0}>
          <Text dimColor>{`${r.host}/`}</Text>
          <Text bold wrap="truncate-end">{slug(r)}</Text>
          <Box flexGrow={1} />
          {g && <Text dimColor>{`${openShown} ${openShown === 1 ? 'epic' : 'epics'} · `}</Text>}
          {g && <Text color="success">{`${yours} yours`}</Text>}
        </Box>
        {counter}
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
      // the lines under them line up whatever the numbers. Numbers sit at
      // its right, their last digits in line.
      const numWidth = Math.max(...listed.map(i => `#${i.number}`.length), 0) + 1
      // Each row starts with its section's mark, so it says where it
      // belongs with its heading scrolled away; the Queue's is blank.
      const MARK = { progress: ['● ', 'success'], next: ['▸ ', 'warning'], queue: ['  ', undefined], blocked: ['⊘ ', 'inactive'] } as const
      // Next is bold and has the focus first, so Enter opens it at once.
      const row = (i: IssueRow, section: keyof typeof MARK, blockedBy?: number[]) => {
        const [mark, markColor] = MARK[section]
        return issueRow(i, {
          key: `issue-${i.number}`,
          buttonKey: `pick-${i.number}`,
          numWidth,
          mark,
          markColor,
          dim: section === 'blocked',
          bold: section === 'next',
          autoFocus: section === 'next',
          blockedBy,
          onPress: () => openIssue($, PANE, i.number),
        })
      }
      if (listed.length === 0) {
        rows.push(
          para('none', within ? `No open issues${within}.` : `No open issues in ${slug(r)}.`, { dimColor: true }),
        )
      } else {
        rows.push(rule('in-progress', `In progress${within} (${m.inProgress.length})`))
        if (m.inProgress.length === 0) {
          rows.push(
            <Box key="no-progress" flexDirection="column" marginBottom={1} flexShrink={0}>
              {para('no-progress-text', 'Nothing in progress. Assign yourself an issue to start.', { dimColor: true })}
            </Box>,
          )
        }
        for (const i of m.inProgress) rows.push(row(i, 'progress'))
        rows.push(rule('next', `Next${within}`))
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
          rows.push(rule('queue', `Queue${within} (${later.length})`))
          for (const i of m.queue) rows.push(row(i, 'queue'))
          for (const b of m.blocked) rows.push(row(b.issue, 'blocked', b.by))
        }
      }
    }
    // The repo, and once loaded how many open issues fj counted and how
    // many are yours, in In progress green.
    const open = m.kind === 'ok' ? m.inProgress.length + (m.next ? 1 : 0) + m.queue.length + m.blocked.length : null
    const repoLine = (
      <Box key="where" height={1} flexShrink={0}>
        <Text dimColor>{`${r.host}/`}</Text>
        <Text bold wrap="truncate-end">{slug(r)}</Text>
        <Box flexGrow={1} />
        {m.kind === 'ok' && <Text dimColor>{`${open} open · `}</Text>}
        {m.kind === 'ok' && <Text color="success">{`${m.inProgress.length} yours`}</Text>}
      </Box>
    )
    return (
      <Box flexDirection="column" height={height}>
        {await titleRow("What's next")}
        <Box key="gap" height={1} flexShrink={0} />
        <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {rows}
        </Box>
        {fixedLine('where-rule', '─'.repeat(columns))}
        {repoLine}
        {counter}
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
}

// /fj opens both panes; /fj next (n) and /fj epics (e) put that one in front.
async function runFj($: EngineInterface, word: string) {
  const lower = word.toLowerCase()
  const want = lower === '' ? 'both' : lower === 'next' || lower === 'n' ? 'next' : lower === 'epics' || lower === 'e' ? 'epics' : null
  if (!want) return { text: `fj does not know "${word}". Try /fj next (or n), /fj epics (or e), or /fj for both.` }
  const openNext = async (title: string, focus?: true) => {
    await $.ui.open({ id: PANE, title, ...(focus ? { focus } : {}) })
    await update($, panesOpen, ids => (ids.includes(PANE) ? ids : [...ids, PANE]))
  }
  // Epics alone opens nothing until it knows there are epics to show.
  if (want !== 'epics') await openNext('fj')
  const r = await refresh($)
  const s = await read($, setup)
  const ep = await read($, epics)
  const hasEpics = ep.kind === 'ok' && ep.openEpics > 0
  if (want === 'epics' && (s.kind !== 'ready' || !r)) {
    await openNext('fj')
    return { text: 'fj needs setting up: see its pane.' }
  }
  if (want === 'epics' && r && !hasEpics) {
    return { text: ep.kind === 'error' ? `Could not load the epics: ${ep.message}.` : `No open epics in ${slug(r)}.` }
  }
  if (r) await openNext("What's next")
  // The Epics pane, a tab next to What's next, only while there are open epics.
  if (hasEpics) {
    await $.ui.open({ id: EPICS_PANE, title: 'Epics', ...(want === 'epics' ? { focus: true as const } : {}) })
    await update($, panesOpen, ids => (ids.includes(EPICS_PANE) ? ids : [...ids, EPICS_PANE]))
  } else if (ep.kind === 'ok' && (await read($, panesOpen)).includes(EPICS_PANE)) {
    await $.ui.close({ id: EPICS_PANE })
  }
  if (want === 'next' && r) await openNext("What's next", true)
  const o = await read($, overview)
  if (s.kind !== 'ready' || !r) return { text: 'fj needs setting up: see its pane.' }
  const pk = await read($, picker)
  const showing = pk?.options.find(x => x.value === pk.pick)?.label ?? 'All'
  if (want === 'epics' && ep.kind === 'ok') {
    return { text: `fj epics for ${slug(r)}: ${ep.openEpics} open, showing ${showing}.` }
  }
  if (o.kind !== 'ok') return { text: `fj is ready for ${slug(r)}, but could not load its issues.` }
  if (o.inProgress.length + o.queue.length + o.blocked.length === 0 && !o.next) {
    return { text: `fj is ready for ${slug(r)}: no open issues.` }
  }
  const then = o.next ? `next is #${o.next.number}` : o.blocked.length > 0 ? 'nothing ready' : 'nothing else open'
  const filter = pk && pk.pick !== 'all' ? ` (${showing})` : ''
  return { text: `fj is ready for ${slug(r)}: ${o.inProgress.length} in progress, ${then}${filter}.` }
}

export const register: Register = (on, options) => {
  configToken = String(options.token ?? '').trim() || null
  configIcons = String(options.icons ?? 'ask')
  configCompact = String(options.compact ?? 'ask')
  configLabel = String(options.label ?? 'epic').trim() || 'epic'
  configDebug = options.debug === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fj',
      description: 'Open the Forgejo pane for this repo',
      argumentHint: '[next|epics]',
    })
    // A reload brings new code but keeps the session's state, which the old
    // code wrote. With fj's panes open, load once, so they show what this
    // code would.
    if ((await read($, panesOpen)).length > 0) await counted($, 'reload', () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'fj' }, async ($, e) => {
    const word = e.args.trim()
    return counted($, word ? `/fj ${word}` : '/fj', () => runFj($, word))
  })

  on('config.set', settingChanged)
  on('ui.close', { id: PANE }, paneClosed)
  on('ui.close', { id: EPICS_PANE }, paneClosed)
  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: EPICS_PANE }, renderPane)
}
