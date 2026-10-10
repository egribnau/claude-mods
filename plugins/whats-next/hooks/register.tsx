import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, RenderChildren, RenderInput } from 'claude-code'

import type { Detail, Epic, Epics, IssueDetail, IssueRow, Overview, Ref, Repo, Setup, TokenSource } from '../types'
import { bar, openChildren, pickerOptions, standing, summary, tally } from './epics'
import { detect, forgeName, gitlabSetting, tokenFor, type Forge, type TokenSetting } from './forge'
import { forgejo } from './forgejo'
import { github } from './github'
import { gitlab } from './gitlab'
import { day, dueSoon, dueText, duration, readable, wrap } from './issue'
import { changesSince, epicGroups, loadRepo, noteChange, whatsNext, type Memory } from './load'
import { waitingText } from './next'
import { message, type Send, type Tracker } from './tracker'

const PANE = 'next'
const EPICS_PANE = 'next-epics'
const CONFIGURE = '/plugin configure whats-next@egribnau-mods'
// The command, and the one it falls back to when another has /next.
const COMMAND = 'next'
const FALLBACK_COMMAND = 'whats-next'

const repo = atom({ plugin: 'whats-next', key: 'repo' } as const, null)
const version = atom({ plugin: 'whats-next', key: 'version' } as const, null)
const token = atom({ plugin: 'whats-next', key: 'token' } as const, null)
const setup = atom({ plugin: 'whats-next', key: 'setup' } as const, { kind: 'checking' })
const overview = atom({ plugin: 'whats-next', key: 'overview' } as const, { kind: 'idle' })
// Per pane, keyed by its id: each opens issues in a detail view of its own.
const picked = atom({ plugin: 'whats-next', key: 'picked' } as const, null)
const detail = atom({ plugin: 'whats-next', key: 'detail' } as const, { kind: 'idle' })
const trail = atom({ plugin: 'whats-next', key: 'trail' } as const, [])
const iconsChosen = atom({ plugin: 'whats-next', key: 'icons' } as const, null)
const compactChosen = atom({ plugin: 'whats-next', key: 'compact' } as const, null)
const epics = atom({ plugin: 'whats-next', key: 'epics' } as const, { kind: 'idle' })
const unfolded = atom({ plugin: 'whats-next', key: 'unfolded' } as const, [])
const panesOpen = atom({ plugin: 'whats-next', key: 'panesOpen' } as const, [])
const milestonePick = atom({ plugin: 'whats-next', key: 'milestonePick' } as const, null)
const picker = atom({ plugin: 'whats-next', key: 'picker' } as const, null)
const pickerOpen = atom({ plugin: 'whats-next', key: 'pickerOpen' } as const, false)
const requests = atom({ plugin: 'whats-next', key: 'requests' } as const, null)

// Every request What's Next sends the forge, counted, so Debug can say what each action cost.
let requestsMade = 0
const send =
  ($: EngineInterface): Send =>
  (url, init) => {
    requestsMade++
    return $.http.fetch(url, init)
  }

// The forge each host runs, as setup's check found it.
const forges = new Map<string, Forge>()

// The tracker behind repo `r`: GitLab or GitHub where setup found it, else Forgejo.
const tracker = ($: EngineInterface, r: Repo): Tracker => {
  const forge = forges.get(r.host)
  return forge?.kind === 'gitlab'
    ? gitlab(send($), r, gitlabToken(r.host).value, forge.version, configLabel)
    : forge?.kind === 'github'
      ? github(send($), r, readToken('GitHub token', r.host).value, forge.version, configLabel)
      : forgejo(send($), r, tokenFor(configTokens['Forgejo tokens'], r.host)?.value ?? null, configLabel)
}

// Runs an action and records how many requests it sent, under `label`.
async function counted<T>($: EngineInterface, label: string, action: () => Promise<T>): Promise<T> {
  const before = requestsMade
  const result = await action()
  const count = requestsMade - before
  await update($, requests, last => ({ label, count, total: (last?.total ?? 0) + count }))
  return result
}

// The token settings' text, read in `register`; a reload reads them again.
const configTokens: Record<TokenSetting, string> = {
  'Forgejo tokens': '',
  'GitLab.com token': '',
  'Private GitLab token': '',
  'GitHub token': '',
}
// The Icons setting: ask, icons or text.
let configIcons = 'ask'
// The Compact setting: ask, on or off.
let configCompact = 'ask'
// The Epic label setting: the label that makes an issue an epic.
let configLabel = 'epic'
// The Debug setting: count What's Next's requests on a line under the bottom line.
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
  const row = rows.find(r => /^whats-next(@[^.]*)?\.icons$/.test(r.key))
  if (!row) return
  const done = await $.config.set({ key: row.key, value })
  if (done.deny !== undefined) $.ui.toast(`Icons not saved: ${done.deny}`)
}

// Saves the Compact choice the same way.
async function chooseCompact($: EngineInterface, value: 'on' | 'off') {
  await update($, compactChosen, () => value)
  const rows = await $.config.list()
  const row = rows.find(r => /^whats-next(@[^.]*)?\.compact$/.test(r.key))
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

// The token for `host` (null: no repo yet) from one token setting, kept in
// secure storage. The settings are the only source, so the token is the
// same in the terminal and the app.
function readToken(setting: TokenSetting, host: string | null): { value: string | null; from: TokenSource } {
  const t = tokenFor(configTokens[setting], host)
  return t ? { value: t.value, from: { setting, host: t.host ? host : null } } : { value: null, from: null }
}

// The GitLab token for `host`. gitlab.com's comes from GitLab.com token, else
// from a `gitlab.com=` pair in Private GitLab token, as older setups have it,
// never from that setting's bare token. Any other host's comes from Private
// GitLab token.
function gitlabToken(host: string): { value: string | null; from: TokenSource } {
  if (gitlabSetting(host) === 'Private GitLab token') return readToken('Private GitLab token', host)
  const com = readToken('GitLab.com token', host)
  if (com.value !== null) return com
  const old = tokenFor(configTokens['Private GitLab token'], host)
  return old?.host ? { value: old.value, from: { setting: 'Private GitLab token', host } } : { value: null, from: null }
}

// Each step in turn, stopping at the first that fails: the repo behind
// origin, the forge at its host, then the tracker's own steps: a token, and
// the token reading the repo.
async function check($: EngineInterface): Promise<Repo | null> {
  await update($, setup, (): Setup => ({ kind: 'checking' }))
  await update($, token, () => readToken('Forgejo tokens', null).from)

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

  const forge = await detect(send($), r.host)
  forges.set(r.host, forge)
  if (forge.kind === 'unknown') {
    await update($, token, () => null)
    await update($, setup, (): Setup => ({ kind: 'not-forgejo', reason: forge.reason, detail: forge.detail }))
    return r
  }
  const tok =
    forge.kind === 'gitlab' ? gitlabToken(r.host) : forge.kind === 'github' ? readToken('GitHub token', r.host) : readToken('Forgejo tokens', r.host)
  await update($, token, () => tok.from)
  const c =
    forge.kind === 'gitlab'
      ? await gitlab(send($), r, tok.value, forge.version, configLabel).check()
      : forge.kind === 'github'
        ? await github(send($), r, tok.value, forge.version, configLabel).check()
        : await forgejo(send($), r, tok.value, configLabel, forge.version).check()
  await update($, version, () => c.version)
  await update($, setup, () => c.setup)
  return r
}

// The repo as loaded, kept until the next Refresh or /next.
let memory: Memory | null = null

// Whether the tracker turned a feature off; a setup check from older code
// may not say, which counts as on.
async function off($: EngineInterface, feature: 'deps' | 'epics'): Promise<boolean> {
  const s = await read($, setup)
  return s.kind === 'ready' && s.features[feature] === false
}

// Asks the tracker for what the panes show: the open milestones, your open
// issues, the repo's open issues, and the epics. Then the picker, What's
// next and the epics follow.
async function load($: EngineInterface, r: Repo) {
  memory = null
  if ((await read($, overview)).kind !== 'ok') await update($, overview, (): Overview => ({ kind: 'loading' }))
  if ((await read($, epics)).kind !== 'ok') await update($, epics, (): Epics => ({ kind: 'loading' }))
  const s = await read($, setup)
  const key = `${r.host}/${slug(r)}`
  const loaded = await loadRepo(tracker($, r), !(await off($, 'epics')), changesSince(key, await $.clock.now()), s.kind === 'ready' ? s.login : null)
  const issuesError = loaded.issuesError
  const epicsError = loaded.epicsError
  if (issuesError !== null) await update($, overview, (): Overview => ({ kind: 'error', message: issuesError }))
  if (epicsError !== null) await update($, epics, (): Epics => ({ kind: 'error', message: epicsError }))
  memory = loaded.memory
  await showPicker($)
  if (issuesError === null) await showNext($, r)
  if (epicsError === null) await showEpics($, r)
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

// What's next within the pick.
async function showNext($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const pick = (await read($, picker))?.pick ?? 'all'
  const next = await whatsNext(tracker($, r), known, pick, !(await off($, 'deps')))
  await update($, overview, (): Overview => ({ kind: 'ok', ...next }))
  // An issue that is closed, or now someone else's, closes: What's next shows.
  const shown = new Set([...known.mine, ...known.free].map(i => i.number))
  await update($, memberOf(picked, { requestId: PANE }), n => (n !== null && shown.has(n) ? n : null))
}

// The epics within the pick, by milestone. What was shown stays up while
// this loads, so the picker does not vanish under the person's hand.
async function showEpics($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const openEpics = known.epics.filter(i => i.state === 'open').length
  if (openEpics === 0) {
    await update($, epics, (): Epics => ({ kind: 'ok', groups: [], openEpics }))
    return
  }
  // Who you are, from the setup check: the children assigned to you are yours.
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const pick = (await read($, picker))?.pick ?? 'all'
  try {
    const groups = await epicGroups(tracker($, r), known, pick, me)
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
// Refresh or /next, so opening one again asks Forgejo nothing.
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
  try {
    const s = await read($, setup)
    const features = s.kind === 'ready' ? s.features : { time: true, deps: true, epics: true }
    const issue = await tracker($, r).issue(n, features)
    issuesRead.set(key, issue)
    // Another issue opened while this one loaded wins.
    if ((await read($, memberOf(picked, { requestId: pane }))) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'ok', issue }))
  } catch (err) {
    if ((await read($, memberOf(picked, { requestId: pane }))) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'error', number: n, message: message(err) }))
  }
}

// Shows issue `n` in the detail view of pane `pane`, or its list again for
// null. Opened from a list, so Back goes to the list.
async function openIssue($: EngineInterface, pane: string, n: number | null) {
  await update($, memberOf(trail, { requestId: pane }), () => [])
  await showIssue($, pane, n)
}

// Shows issue `n` in pane `pane`, reached from issue `from`'s Blocked by or
// Blocks: Back returns to `from`.
async function followIssue($: EngineInterface, pane: string, from: number, n: number) {
  await update($, memberOf(trail, { requestId: pane }), t => [...t, from])
  await showIssue($, pane, n)
}

// Back: the issue the open one was reached from, else the list.
async function goBack($: EngineInterface, pane: string) {
  const t = await read($, memberOf(trail, { requestId: pane }))
  const from = t.at(-1)
  if (from === undefined) return openIssue($, pane, null)
  await update($, memberOf(trail, { requestId: pane }), () => t.slice(0, -1))
  await showIssue($, pane, from)
}

async function showIssue($: EngineInterface, pane: string, n: number | null) {
  await update($, memberOf(picked, { requestId: pane }), () => n)
  const r = await read($, repo)
  if (n === null || !r) {
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
    return
  }
  await counted($, `#${n}`, () => loadDetail($, r, pane, n))
}

// Pane `pane` shows its list again: What's next or the epics.
async function backToList($: EngineInterface, pane: string) {
  await update($, memberOf(trail, { requestId: pane }), () => [])
  await update($, memberOf(picked, { requestId: pane }), () => null)
  await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
}

// Checks setup and, once it passes, loads What's next and the epics and,
// where an issue is open, that issue again.
async function refresh($: EngineInterface): Promise<Repo | null> {
  issuesRead.clear()
  const r = await check($)
  if (r && (await read($, setup)).kind === 'ready') {
    const before = await read($, epics)
    await load($, r)
    await followEpics($, before)
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

// The Epics pane follows a load that found the first open epic, or none
// left: it opens as a tab next to What's next, without the focus, or
// closes. An Epics pane the person closed while there were epics stays
// closed until /next. One opened without the person asking (a reload) may
// wait undrawn on a narrow terminal; the next Refresh, which they ask for,
// opens it again so it is drawn.
async function followEpics($: EngineInterface, before: Epics) {
  const after = await read($, epics)
  if (after.kind !== 'ok') return
  // The engine's record says whether it is drawn; without it, What's Next's own
  // list of open panes, taken as drawn.
  const panes = await $.ui.panes().catch(async () => (await read($, panesOpen)).map(id => ({ id, isPlaced: true })))
  const pane = panes.find(p => p.id === EPICS_PANE)
  const first = !(before.kind === 'ok' && before.openEpics > 0)
  if (after.openEpics > 0 && (pane ? !pane.isPlaced : first)) {
    await $.ui.open({ id: EPICS_PANE, title: 'Epics' })
    await update($, panesOpen, ids => (ids.includes(EPICS_PANE) ? ids : [...ids, EPICS_PANE]))
  } else if (after.openEpics === 0 && pane) {
    await $.ui.close({ id: EPICS_PANE })
    await update($, panesOpen, ids => ids.filter(id => id !== EPICS_PANE))
  }
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

// A due date's colour, an issue's or a milestone's: red once passed, amber
// within 7 days, dim otherwise.
function dueLook(iso: string, now: number): { color?: string; dimColor?: boolean } {
  const soon = dueSoon(iso, now)
  return soon === 'passed' ? { color: 'error' } : soon === 'soon' ? { color: 'warning' } : { dimColor: true }
}

// Changes issue `n` with `change` (`what` names it for a refusal), then
// reads it again with What's next and the epics, so the change shows
// everywhere. Pane `pane` goes back to its list; a refusal keeps the issue
// open there, shown under its actions.
async function writeIssue(
  $: EngineInterface,
  pane: string,
  n: number,
  change: (t: Tracker) => Promise<string | null>,
  what: string,
): Promise<boolean> {
  const r = await read($, repo)
  if (!r) return false
  const why = await change(tracker($, r))
  if (why !== null) {
    const error = `Could not ${what} #${n}: ${why.replace(/\.$/, '')}.`
    await update($, memberOf(detail, { requestId: pane }), (d): Detail => (d.kind === 'ok' ? { ...d, error } : d))
    return false
  }
  const key = `${r.host}/${slug(r)}#${n}`
  issuesRead.delete(key)
  await backToList($, pane)
  for (const p of [PANE, EPICS_PANE]) {
    if ((await read($, memberOf(picked, { requestId: p }))) === n) await loadDetail($, r, p, n)
  }
  // The issue as the change left it, read again unless a pane just did, so
  // the lists show the change even where the forge's lists lag it.
  const s = await read($, setup)
  const fresh =
    issuesRead.get(key) ??
    (await tracker($, r)
      .issue(n, s.kind === 'ready' ? s.features : { time: true, deps: true, epics: true })
      .catch(() => null))
  if (fresh) noteChange(`${r.host}/${slug(r)}`, fresh, await $.clock.now())
  await load($, r)
  return true
}

// You on issue `i`, or off it; other assignees stay.
async function assignMe($: EngineInterface, pane: string, i: IssueDetail, on: boolean): Promise<boolean> {
  const s = await read($, setup)
  if (s.kind !== 'ready') return false
  const others = i.assignees.filter(a => a !== s.login)
  const assignees = on ? [...others, s.login] : others
  return writeIssue($, pane, i.number, t => t.assign(i.number, assignees), on ? 'assign' : 'unassign')
}

// What a draft is made from: the issue, and its last comment when known.
type DraftSource = Pick<IssueRow, 'number' | 'title' | 'url' | 'body'> & {
  lastComment?: { author: string; body: string } | null
}

// The prompt What's Next drafts for an issue: what to do, where the issue is, what it
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
// you first. Its pane goes back to its list once the draft is in, unless
// the assign was refused.
async function workOn($: EngineInterface, i: DraftSource, take?: { pane: string; issue: IssueDetail }) {
  let taken = false
  let refused = false
  if (take) {
    const s = await read($, setup)
    if (s.kind === 'ready' && s.actions.kind !== 'read-only' && !take.issue.assignees.includes(s.login)) {
      taken = await counted($, `assign #${i.number}`, () => assignMe($, take.pane, take.issue, true))
      refused = !taken
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
    if (take && done.isFilled && !refused) await backToList($, take.pane)
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

type Step = 'repo' | 'forge' | 'token' | 'access' | 'actions'
const STEPS: readonly Step[] = ['repo', 'forge', 'token', 'access', 'actions']
const LABEL: Record<Step, string> = { repo: 'Repo', forge: 'Forge', token: 'Token', access: 'Access', actions: 'Actions' }

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

// What the pane says about the step that failed, before what to do. `v`:
// the forge, as the Forge step names it; `t`: the tracker, once there is a
// repo.
function intro(s: Setup, r: Repo | null, t: Tracker | null, v: string | null, tokenText: string): string | null {
  const name = t?.name ?? 'Forgejo'
  const what = "What's Next shows the issues of the repo this session runs in."
  switch (s.kind) {
    case 'no-repo':
      return s.reason === 'not-git'
        ? `${what} ${s.dir} is not a git repo, so there is nothing to show here.`
        : s.reason === 'no-origin'
          ? `${what} This repo has no remote origin.`
          : `${what} origin is ${s.origin}, which names no host.`
    case 'token-refused':
      return `${name} did not accept the token ${tokenText}: it may be mistyped, expired or revoked.`
    case 'no-scope':
      return s.missing === 'read_api'
        ? `The token ${tokenText} may not read ${r ? slug(r) : 'the repo'}: What's Next needs read_api.`
        : s.missing === 'Issues'
          ? `The token ${tokenText} reads ${r ? slug(r) : 'the repo'}, but not its issues: What's Next needs the Issues permission.`
          : s.missing
          ? `The token ${tokenText} reads ${r ? slug(r) : 'the repo'}, but not who it belongs to: What's Next needs ${s.missing} too.`
          : `The token ${tokenText} is valid but may not read this repo.`
    case 'not-found':
      return `${r ? slug(r) : 'The repo'}, from origin, was not found, or the token's owner cannot see it.`
    case 'error':
      return `${name} could not be asked: ${s.message}.`
    case 'not-forgejo': {
      const host = r?.host ?? 'This host'
      return s.reason === 'no-answer'
        ? `${host} did not answer (${s.detail}). Check that https://${host} opens from this computer.`
        : s.reason === 'too-old'
          ? `What's Next needs Forgejo or Gitea 1.19 or newer, the first with scoped tokens (read:issue, read:repository, read:user). ${host} runs ${s.detail}.`
          : `${host} does not answer as Forgejo, Gitea, GitLab or GitHub Enterprise (${s.detail}). What's Next has nothing to show for this repo.`
    }
    default:
      return null
  }
}

// What to do about the step that failed, one line per action.
// `t`: the tracker, which says where it makes tokens, once there is a repo.
function todo(s: Setup, r: Repo | null, t: Tracker | null): string[] {
  const page = t?.tokensUrl ?? 'Settings › Applications in Forgejo'
  const create = `Create a token at ${page} with ${t?.scopes ?? 'write:issue, read:repository and read:user; read:issue instead of write:issue is read only'}.`
  const host = r?.host ?? 'your-forge'
  // GitLab has a setting per kind of host, so no host=token hint there.
  const set = [
    t?.name === 'GitLab'
      ? `Run \`${CONFIGURE}\` and paste it as ${t.setting}.`
      : `Run \`${CONFIGURE}\` and paste it as ${t?.setting ?? 'Forgejo tokens'}, alone or as \`${host}=<token>\` next to tokens for other hosts.`,
  ]
  switch (s.kind) {
    case 'no-repo': {
      const remote = 'https://your-forge/owner/repo.git'
      return [
        s.reason === 'not-git'
          ? `If this folder belongs on a forge: \`git init\` and \`git remote add origin ${remote}\`, then press r.`
          : s.reason === 'no-origin'
            ? `If this repo is on a forge: \`git remote add origin ${remote}\`, then press r.`
            : `If this repo is on a forge: \`git remote set-url origin ${remote}\`, then press r.`,
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
        `If origin points to the wrong repo: \`git remote set-url origin https://${host}/owner/repo.git\`.`,
        t?.name === 'GitHub'
          ? "If the repo is private, create the token as a user who can see it; a fine-grained token also needs it among its repositories."
          : 'If the repo is private, create the token as a user who can see it.',
        ...set,
      ]
    case 'error':
      return []
    default:
      return []
  }
}

// A pane closing, by What's Next or by the person: the other one, now without a tab,
// names itself in its title row again.
const paneClosed: Hook<'ui.close'> = async ($, e, next) => {
  await update($, panesOpen, ids => ids.filter(id => id !== e.id))
  return next(e)
}

// A change to Icons or Compact in /config, or by What's Next's own choice buttons:
// the session follows it, so the setting wins over an earlier choice.
const settingChanged: Hook<'config.set'> = async ($, e, next) => {
  const done = await next(e)
  const field = /^whats-next(?:@[^.]*)?\.(icons|compact)$/.exec(e.key)?.[1]
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

// What's Next's own version, from its manifest, read once by the code that
// runs: a session keeps the version it loaded until /reload-plugins, even
// when the folder on disk has moved on. null: the manifest could not be read.
let ownVersion: Promise<string | null> | null = null
function builtVersion($: EngineInterface): Promise<string | null> {
  const from = (path: string) =>
    $.fs.read(path).then(text => {
      const v = (JSON.parse(text) as { version?: unknown }).version
      return typeof v === 'string' && v !== '' ? v : null
    })
  // The plugin's folder, or the .claude-plugin folder in it.
  const root = $.plugin.root
  ownVersion ??= from(`${root}/.claude-plugin/plugin.json`)
    .catch(() => from(`${root}/plugin.json`))
    .catch(() => null)
  return ownVersion
}

// Both panes draw here: they share setup, the detail view and the bottom line.
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const inEpics = e.requestId === EPICS_PANE
  const r = await read($, repo)
  const v = await read($, version)
  // Older code kept a word here: that counts as none found.
  const held = await read($, token)
  const from = held && typeof held === 'object' ? held : null
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

  const tokenText = from ? `${from.host ? `for ${from.host} ` : ''}from ${from.setting}` : 'none found'
  // The tracker behind the repo, for its name and where it makes tokens.
  const t = r ? tracker($, r) : null
  const doneText: Record<Step, string> = {
    repo: r ? slug(r) : '',
    forge: v && r ? `${v} at ${r.host}` : '',
    token: tokenText,
    access: s.kind === 'ready' ? `${s.openIssues} open issues, as ${s.login}` : '',
    actions: 'assign and close',
  }
  const failText: Record<Step, string> = {
    repo: 'no repo here',
    forge:
      s.kind === 'not-forgejo' && s.reason === 'no-answer'
        ? `no answer from ${r?.host ?? 'this host'}`
        : s.kind === 'not-forgejo' && s.reason === 'too-old'
          ? `${s.detail}, too old`
          : `no known forge at ${r?.host ?? 'this host'}`,
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
  // Without a repo, or on a Forgejo too old, the token is still checked: it
  // needs no answer from the forge. The steps that do say so; the token too,
  // where What's Next has no setting for the forge or knows none.
  const noRepo = s.kind === 'no-repo'
  const noForge = s.kind === 'not-forgejo'
  const tokenChecked = noRepo || (s.kind === 'not-forgejo' && s.reason === 'too-old')
  const steps = STEPS.map((step, i) => {
    const mark =
      s.kind === 'checking'
        ? '…'
        : noForge && !tokenChecked && step === 'token'
          ? '·'
          : tokenChecked && step === 'token'
            ? from ? '✓' : '✗'
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
              ? 'needs a forge'
              : ''
    // Actions that cannot be done are no failure: setup passes, read only.
    if (step === 'actions' && s.kind === 'ready' && s.actions.kind !== 'ok') {
      const why =
        s.actions.kind === 'unknown'
          ? 'unknown, scopes not listed'
          : s.actions.reason === 'later'
            ? `read only on ${t?.name ?? 'this forge'} for now`
            : s.actions.reason === 'scope'
              ? `read only, token lacks ${t?.writeScope ?? 'write:issue'}`
              : s.actions.reason === 'role'
                ? `read only, ${s.login} is below Reporter here`
                : `read only, ${s.login} may not push here`
      return line(`step-${step}`, `· ${LABEL[step].padEnd(8)}${why}`, { color: 'inactive' })
    }
    return line(`step-${step}`, `${mark} ${LABEL[step].padEnd(8)}${text}`, { color })
  })

  const body: RenderChildren[] = []
  if (s.kind !== 'ready' && s.kind !== 'checking') {
    const about = intro(s, r, t, v, tokenText)
    if (about) body.push(para('intro', about), <Box key="gap-intro" height={1} />)
    const actions = todo(s, r, t)
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
    // What blocks it: its numbers blue, as issue numbers are, the words dim.
    const blockers = (by: number[]) => [
      <Text key="by" dimColor>
        {'blocked by '}
      </Text>,
      ...by.flatMap((n, k) => [
        ...(k > 0 ? [<Text key={`by-sep-${k}`} dimColor>{', '}</Text>] : []),
        <Text key={`by-${n}`} color="suggestion">
          {`#${n}`}
        </Text>,
      ]),
    ]
    const parts: RenderChildren[] = (
      o.blockedBy && o.blockedBy.length > 0
        ? [blockers(o.blockedBy), opened]
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
    const title = o.who ? `${fit(i.title, room - o.who.length - 1).padEnd(room - o.who.length - 1)} ` : fit(i.title, room)
    return (
      <Box key={o.key} flexDirection="column" marginBottom={gap} flexShrink={0}>
        <Button key={o.buttonKey} plain autoFocus={o.autoFocus || undefined} onPress={o.onPress}>
          <Text wrap="truncate-end" bold={o.bold}>
            {lead}
            <Text color={o.markColor} dimColor={o.dim}>
              {o.mark}
            </Text>
            <Text color="suggestion">{`${`#${i.number}`.padStart(o.numWidth - 1)} `}</Text>
            {o.dim ? <Text dimColor>{title}</Text> : title}
            {o.who && <Text dimColor>{o.who}</Text>}
          </Text>
        </Button>
        {/* One row: a line too long for the pane is cut, but would still
            take the height of its overflow. The indent keeps its width, so
            a cut line starts under the title like the others. */}
        {facts.length > 0 && (
          <Box height={1}>
            <Box key="indent" flexShrink={0}>
              <Text>{`${lead}${' '.repeat(2 + o.numWidth)}`}</Text>
            </Box>
            <Text wrap="truncate-end">{facts}</Text>
          </Box>
        )}
      </Box>
    )
  }
  // The right of the bottom line: What's Next's version, dim, kept whole on
  // a narrow pane.
  const built = await builtVersion($)
  const ours = built && (
    <Box key="ours" flexShrink={0}>
      <Text dimColor>{`  v${built}`}</Text>
    </Box>
  )
  // With Debug on, under the bottom line: what the last action and the session
  // asked the forge.
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
                <Text bold={o.value === pk.pick}>
                  {o.label.padEnd(14)}
                  {o.due ? <Text {...dueLook(o.due, today)}>{day(o.due, today).padEnd(6)}</Text> : ''.padEnd(6)}
                </Text>
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  }
  // With another What's Next pane open the engine draws tabs that name both, so a
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
          {heading("What's Next is ready!")}
          {steps}
          <Box key="gap" height={1} />
          {line('ask', 'One choice: icons on buttons', { bold: true })}
          {para(
            'why',
            "What's Next can show its buttons as Nerd Font icons, which keeps them narrow. Look at the four below: do they show as icons, or as boxes or question marks?",
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
          {para('later', "Asked once. Change it later in /config, under What's Next: Icons.", { dimColor: true })}
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
          {heading("What's Next is ready!")}
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
          {para('later', "Asked once, after Icons. Change it later in /config, under What's Next: Compact.", { dimColor: true })}
        </Box>
      </Box>
    )
  }

  // An issue open: its detail in place of the list.
  const open = await read($, memberOf(picked, e))
  if (s.kind === 'ready' && r && open !== null) {
    const d = await read($, memberOf(detail, e))
    const now = await $.clock.now()
    // Back names where it goes: the issue this one was reached from, else the list.
    const from = (await read($, memberOf(trail, e))).at(-1)
    const top = (
      <Box key="title" height={1} flexShrink={0}>
        <Button
          key="back"
          label={from !== undefined ? say(`${ICON.back} #${from}`, `← #${from}`) : say(ICON.back, inEpics ? '← Epics' : "← What's next")}
          hotkey="b"
          onPress={() => goBack($, e.requestId)}
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
      // One issue or pull request on a line: number, title, state. Numbers
      // sit at the right of one column, states at the right of the line, so
      // titles start in one column. Closed is a grey ✓; an open blocker that
      // is itself blocked says so, dim. Blocked by and Blocks lines are
      // buttons that open their issue here.
      type RefKind = 'blocker' | 'blocks' | 'pull'
      const refs = [...(i.blockedBy ?? []), ...(i.blocks ?? []), ...(i.pulls ?? [])]
      const stateOf = (x: Ref) => (x.state === 'closed' ? '✓' : x.blocked ? 'blocked' : x.state)
      const refNum = Math.max(0, ...refs.map(x => `#${x.number}`.length))
      const refState = Math.max(0, ...refs.map(x => stateOf(x).length))
      const refLine = (key: string, label: string, x: Ref, kind: RefKind) => {
        const state = stateOf(x)
        const done = x.state === 'closed'
        const room = columns - KEY - refNum - 1 - 1 - refState
        const row = (
          <Text wrap="truncate-end">
            <Text color={done ? 'inactive' : kind === 'blocker' ? 'error' : 'suggestion'}>{`#${x.number}`.padStart(refNum)}</Text>
            <Text color={done ? 'inactive' : undefined}>{` ${fit(x.title, room).padEnd(room)} `}</Text>
            <Text
              color={
                done ? 'inactive' : x.blocked ? undefined : x.state === 'open' ? (kind === 'blocker' ? 'error' : undefined) : x.state === 'merged' ? 'merged' : undefined
              }
              dimColor={!done && (x.blocked || (x.state !== 'open' && x.state !== 'merged'))}
            >
              {state.padStart(refState)}
            </Text>
          </Text>
        )
        return keyed(
          key,
          label,
          kind === 'pull' ? (
            row
          ) : (
            <Button key={`follow-${x.number}`} plain onPress={() => followIssue($, e.requestId, i.number, x.number)}>
              {row}
            </Button>
          ),
        )
      }
      const facts: RenderChildren[] = []
      if (i.due) {
        const due = dueText(i.due, now)
        facts.push(keyed('due', 'Due', <Text {...dueLook(i.due, now)}>{due.text}</Text>))
      }
      if (i.branch) facts.push(keyed('branch', 'Branch', <Text>{i.branch}</Text>))
      const time = i.logged
        ? `${duration(i.logged)} logged${i.estimate ? ` of ${duration(i.estimate)} estimated` : ''}`
        : i.estimate
          ? `${duration(i.estimate)} estimated`
          : null
      if (time) facts.push(keyed('time', 'Time', <Text>{time}</Text>))
      if (i.labels.length > 0) {
        facts.push(
          keyed(
            'labels',
            'Labels',
            <Text wrap="truncate-end">{labelTexts(i.labels)}</Text>,
          ),
        )
      }
      ;(i.blockedBy ?? []).forEach((x, k) => facts.push(refLine(`blocked-${k}`, k === 0 ? 'Blocked by' : '', x, 'blocker')))
      ;(i.blocks ?? []).forEach((x, k) => facts.push(refLine(`blocks-${k}`, k === 0 ? 'Blocks' : '', x, 'blocks')))
      ;(i.pulls ?? []).forEach((x, k) => facts.push(refLine(`pull-${k}`, k === 0 ? 'Pull requests' : '', x, 'pull')))
      ;(i.commits ?? []).slice(0, 3).forEach((c, k) =>
        facts.push(
          keyed(
            `commit-${k}`,
            k === 0 ? 'Commits' : '',
            <>
              <Text dimColor>{`${c.sha} `}</Text>
              <Text wrap="truncate-end">{fit(c.message, columns - KEY - c.sha.length - 1 - `${age(c.when, now)} ago`.length - 1)}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{` ${age(c.when, now)} ago`}</Text>
            </>,
          ),
        ),
      )

      // The heading wraps over two lines at most; a longer title ends the
      // second in ….
      const headText = `#${i.number} ${i.title}`
      const wrapped = wrap(headText, columns)
      const titleLines =
        wrapped.length > 2 ? [wrapped[0] ?? '', fit(headText.slice((wrapped[0] ?? '').length).trimStart(), columns)] : wrapped
      const milestoneDue = i.milestone?.due ?? null
      const comments = `${i.comments} ${i.comments === 1 ? 'comment' : 'comments'}`

      // What is left for the description and the last comment; the rule
      // above the bottom line is one of the rows kept.
      // Assign and close, when What's Next may: setup's Actions step says so.
      const acts = s.kind === 'ready' ? s.actions : ({ kind: 'read-only', reason: 'scope' } as const)
      const canAct = acts.kind !== 'read-only'
      const mine = s.kind === 'ready' && i.assignees.includes(s.login)
      const closed = i.state === 'closed'
      const error = d.kind === 'ok' ? d.error : undefined
      const actionRows = 2 + (canAct ? 0 : 2) + (error ? 2 : 0)
      const fixed = 1 + titleLines.length + 2 + actionRows + (facts.length > 0 ? facts.length + 1 : 0) + 1 + 1 + 1 + 1 + 1
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
              {k === 0 ? <Text color={closed ? 'inactive' : 'suggestion'}>{`#${i.number}`}</Text> : null}
              {k === 0 ? t.slice(`#${i.number}`.length) : t}
            </Text>
          ))}
          <Text wrap="truncate-end">
            <Text dimColor>{`${i.state} · ${i.milestone ? i.milestone.title : 'no milestone'}`}</Text>
            {milestoneDue && <Text dimColor>{' '}</Text>}
            {milestoneDue && <Text {...dueLook(milestoneDue, now)}>{`(due ${day(milestoneDue, now)})`}</Text>}
            <Text dimColor>{` · ${comments}`}</Text>
          </Text>
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
                    writeIssue($, e.requestId, i.number, t => t.close(i.number, !closed), closed ? 'reopen' : 'close'),
                  )
                }
              />
            )}
          </Box>
          <Box height={1}>
            <Button key="open" label={say(ICON.open, 'Open in browser')} hotkey="o" onPress={() => openUrl($, i.url)} />
          </Box>
          {!canAct &&
            para(
              'read-only',
              acts.kind === 'read-only' && acts.reason === 'later'
                ? `What's Next cannot assign or close ${t?.name ?? 'its'} issues yet.`
                : acts.kind === 'read-only' && acts.reason === 'role'
                  ? `Assign and close need Reporter or higher on ${slug(r)}.`
                  : acts.kind === 'read-only' && acts.reason === 'push'
                    ? `Assign and close need push rights on ${slug(r)}.`
                    : `Assign and close need a token with ${t?.writeScope ?? 'write:issue'}: the setup guide's steps make one.`,
              { dimColor: true },
            )}
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
        {fixedLine('where-rule', '─'.repeat(columns))}
        <Box key="where" height={1} flexShrink={0}>
          <Box flexGrow={1} />
          {ours}
        </Box>
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
      const due = g.title && g.due ? ` · due ${day(g.due, now)}` : ''
      const rest = g.title ? ` · ${g.closed}/${g.total} closed ` : ' '
      rows.push(
        // After the first, an extra empty line sets the group apart from the last epic above.
        <Box key={`group-${gi}`} height={1} flexShrink={0} marginTop={gi > 0 ? 1 : 0}>
          <Text dimColor>{'── '}</Text>
          <Text bold>{name}</Text>
          {due && <Text dimColor>{' · '}</Text>}
          {due && g.due && <Text {...dueLook(g.due, now)}>{due.slice(3)}</Text>}
          <Text dimColor>{rest}</Text>
          <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(0, columns - 3 - name.length - due.length - rest.length))}</Text>
        </Box>,
      )
      for (const x of g.epics) {
        // A closed epic has nothing to fold; its row opens its detail.
        if (x.state === 'closed') {
          rows.push(
            <Box key={`epic-${x.number}`} flexShrink={0}>
              <Button key={`epic-${x.number}`} plain onPress={() => openIssue($, EPICS_PANE, x.number)}>
                <Text wrap="truncate-end" color="inactive">
                  {`  ${num(x.number)}${fit(x.title, titleWidth).padEnd(titleWidth)} ${'✓'.padStart(14)}`}
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
              // Hollow beside the filled ● for yours: someone else's.
              mark: st === 'mine' ? '● ' : st === 'blocked' ? '⊘ ' : st === 'taken' ? '○ ' : '  ',
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
          {g && <Text dimColor>{`${openShown} ${openShown === 1 ? 'epic' : 'epics'} · `}</Text>}
          {g && <Text color="success" wrap="truncate-end">{`${yours} yours`}</Text>}
          <Box flexGrow={1} />
          {ours}
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
      // The mark says how a row stands for you: yours, blocked, or blank.
      // Next has none of its own: it is bold and has the focus first.
      const MARK = { progress: ['● ', 'success'], next: ['  ', undefined], queue: ['  ', undefined], blocked: ['⊘ ', undefined] } as const
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
        // The Queue shows up to its limit; the issues past it are counted,
        // in the heading and on one line under the free ones.
        if (later.length > 0) {
          const count = m.more > 0 ? `${later.length} of ${later.length + m.more}` : `${later.length}`
          rows.push(rule('queue', `Queue${within} (${count})`))
          for (const i of m.queue) rows.push(row(i, 'queue'))
          if (m.more > 0) {
            rows.push(
              <Box key="more" flexDirection="column" marginBottom={gap} flexShrink={0}>
                {line('more-text', `${' '.repeat(2)}and ${m.more} more`, { dimColor: true })}
              </Box>,
            )
          }
          for (const b of m.blocked) rows.push(row(b.issue, 'blocked', b.by))
        }
      }
    }
    // Once loaded, how many open issues What's Next counted and how many are
    // yours, in In progress green; the version at the right.
    const open = m.kind === 'ok' ? m.inProgress.length + (m.next ? 1 : 0) + m.queue.length + m.more + m.blocked.length : null
    const bottomLine = (
      <Box key="where" height={1} flexShrink={0}>
        {m.kind === 'ok' && <Text dimColor>{`${open} open · `}</Text>}
        {m.kind === 'ok' && <Text color="success" wrap="truncate-end">{`${m.inProgress.length} yours`}</Text>}
        <Box flexGrow={1} />
        {ours}
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
        {bottomLine}
        {counter}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height={height}>
      <Box key="setup" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {m.kind === 'error' && para('overview-error', `Could not load the issues: ${m.message}.`, { color: 'error' })}
        {s.kind === 'ready'
          ? heading("What's Next is ready!", { label: 'Refresh' })
          : heading("Set up What's Next")}
        {steps}
        <Box key="gap" height={1} />
        {body}
      </Box>
    </Box>
  )
}

// /next opens both panes with What's next in front, and so does /next next
// (n); /next epics (e) puts Epics in front. `name`: the command as registered.
async function runNext($: EngineInterface, name: string, word: string) {
  const lower = word.toLowerCase()
  const want = lower === '' || lower === 'next' || lower === 'n' ? 'both' : lower === 'epics' || lower === 'e' ? 'epics' : null
  if (!want) return { text: `/${name} does not know "${word}". Try /${name} for What's next in front, or /${name} epics (or e) for Epics.` }
  const openNext = async (title: string) => {
    await $.ui.open({ id: PANE, title })
    await update($, panesOpen, ids => (ids.includes(PANE) ? ids : [...ids, PANE]))
  }
  // Epics alone opens nothing until it knows there are epics to show.
  if (want !== 'epics') await openNext("What's Next")
  const r = await refresh($)
  const s = await read($, setup)
  const ep = await read($, epics)
  const hasEpics = ep.kind === 'ok' && ep.openEpics > 0
  if (want === 'epics' && (s.kind !== 'ready' || !r)) {
    await openNext("What's Next")
    return { text: "What's Next needs setting up: see its pane." }
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
  const o = await read($, overview)
  if (s.kind !== 'ready' || !r) return { text: "What's Next needs setting up: see its pane." }
  const pk = await read($, picker)
  const showing = pk?.options.find(x => x.value === pk.pick)?.label ?? 'All'
  if (want === 'epics' && ep.kind === 'ok') {
    return { text: `Epics for ${slug(r)}: ${ep.openEpics} open, showing ${showing}.` }
  }
  if (o.kind !== 'ok') return { text: `What's Next is ready for ${slug(r)}, but could not load its issues.` }
  if (o.inProgress.length + o.queue.length + o.blocked.length === 0 && !o.next) {
    return { text: `What's Next is ready for ${slug(r)}: no open issues.` }
  }
  const then = o.next ? `next is #${o.next.number}` : o.blocked.length > 0 ? 'nothing ready' : 'nothing else open'
  const filter = pk && pk.pick !== 'all' ? ` (${showing})` : ''
  return { text: `What's Next is ready for ${slug(r)}: ${o.inProgress.length} in progress, ${then}${filter}.` }
}

export const register: Register = (on, options) => {
  configTokens['Forgejo tokens'] = String(options.token ?? '').trim()
  configTokens['GitLab.com token'] = String(options.gitlabComToken ?? '').trim()
  configTokens['Private GitLab token'] = String(options.gitlabTokens ?? '').trim()
  configTokens['GitHub token'] = String(options.githubTokens ?? '').trim()
  configIcons = String(options.icons ?? 'ask')
  configCompact = String(options.compact ?? 'ask')
  configLabel = String(options.label ?? 'epic').trim() || 'epic'
  configDebug = options.debug === true

  on('session.start', async ($, e, next) => {
    // /next, unless another plugin, the person or an MCP server has it:
    // then /whats-next. A `next` whose plugin the engine does not name
    // cannot be told from another's, so it counts as taken.
    const commands = await $.command.list().catch(() => [])
    const taken = commands.some(c => c.name === COMMAND && !(c.source === 'plugin' && c.plugin !== undefined && /^whats-next(@|$)/.test(c.plugin)))
    await $.command.register({
      name: taken ? FALLBACK_COMMAND : COMMAND,
      description: "Your issues and what's next, for this repo",
      argumentHint: '[epics]',
    })
    if (taken) $.ui.toast("/next is taken by another command: What's Next is /whats-next in this session.")
    // A reload brings new code but keeps the session's state, which the old
    // code wrote. With What's Next's panes open, load once, so they show what this
    // code would.
    if ((await read($, panesOpen)).length > 0) await counted($, 'reload', () => refresh($))
    return next(e)
  })

  // A /clear starts the session's state over, What's Next's list of open
  // panes too, and fires no session.start; the panes themselves stay up. With
  // one of them up, take the list from the engine's record and load again.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.source !== 'clear') return done
    const ours = (await $.ui.panes().catch(() => [])).map(p => p.id).filter(id => id === PANE || id === EPICS_PANE)
    if (ours.length > 0) {
      await update($, panesOpen, () => ours)
      await counted($, 'clear', () => refresh($))
    }
    return done
  })

  // Both names: only the one registered reaches here.
  for (const command of [COMMAND, FALLBACK_COMMAND]) {
    on('command.run', { command }, async ($, e) => {
      const word = e.args.trim()
      return counted($, word ? `/${command} ${word}` : `/${command}`, () => runNext($, command, word))
    })
  }

  on('config.set', settingChanged)
  on('ui.close', { id: PANE }, paneClosed)
  on('ui.close', { id: EPICS_PANE }, paneClosed)
  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: EPICS_PANE }, renderPane)
}
