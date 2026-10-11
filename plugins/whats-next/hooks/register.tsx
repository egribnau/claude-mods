import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, RenderChildren, RenderInput } from 'claude-code'

import type { Detail, Epic, Epics, IssueDetail, IssueRow, Milestone, MilestoneIssue, Overview, Ref, Repo, Scope, Setup, TokenSource } from '../types'
import { bar, dueFirst, forYou, inMilestone, markOf, openChildren, pickerOptions, standing, summary, tally, tree, type Folding, type Mark, type Standing, type TreeLine } from './epics'
import { configureCommand, detect, forgeName, gitlabSetting, tokenFor, type Forge, type TokenSetting } from './forge'
import { forgejo } from './forgejo'
import { github } from './github'
import { gitlab } from './gitlab'
import { day, dueSoon, dueText, duration, readable, wrap } from './issue'
import { changesSince, epicTree, growTree, loadRepo, milestoneIssues, milestoneKnown, noteChange, startingPick, whatsNext, type Memory } from './load'
import { waitingText } from './next'
import { message, withoutToken, type Send, type Tracker } from './tracker'

const PANE = 'next'
const EPICS_PANE = 'next-epics'
const MILESTONES_PANE = 'next-milestones'
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
const treeKids = atom({ plugin: 'whats-next', key: 'treeKids' } as const, {})
const issuesFolded = atom({ plugin: 'whats-next', key: 'issuesFolded' } as const, false)
const descriptionUnfolded = atom({ plugin: 'whats-next', key: 'descriptionUnfolded' } as const, false)
const milestones = atom({ plugin: 'whats-next', key: 'milestones' } as const, null)
const milestonesUnfolded = atom({ plugin: 'whats-next', key: 'milestonesUnfolded' } as const, [])
const milestoneOpen = atom({ plugin: 'whats-next', key: 'milestoneOpen' } as const, null)
const milestoneError = atom({ plugin: 'whats-next', key: 'milestoneError' } as const, null)
const msIssues = atom({ plugin: 'whats-next', key: 'milestoneIssues' } as const, {})
const closedMilestones = atom({ plugin: 'whats-next', key: 'closedMilestones' } as const, [])
const closedShown = atom({ plugin: 'whats-next', key: 'closedShown' } as const, false)
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

// The tracker behind repo `r`: GitLab or GitHub where setup found it, else
// Forgejo. A token goes only to the forge setup found at the host: with none
// found, the Forgejo tracker gets no token. What it says never carries the token.
const tracker = ($: EngineInterface, r: Repo): Tracker => {
  const forge = forges.get(r.host)
  return forge?.kind === 'gitlab'
    ? trackerOf('gitlab', $, r, gitlabToken(r.host).value, forge.version)
    : forge?.kind === 'github'
      ? trackerOf('github', $, r, readToken('GitHub token', r.host).value, forge.version)
      : trackerOf('forgejo', $, r, forge?.kind === 'forgejo' ? readToken('Forgejo tokens', r.host).value : null)
}

// The tracker of one forge for repo `r`, with `token` cut out of what it says.
const trackerOf = (kind: 'forgejo' | 'gitlab' | 'github', $: EngineInterface, r: Repo, token: string | null, version?: string | null): Tracker =>
  withoutToken(
    kind === 'gitlab'
      ? gitlab(send($), r, token, version ?? null, configLabel)
      : kind === 'github'
        ? github(send($), r, token, version ?? null, configLabel)
        : forgejo(send($), r, token, configLabel, version ?? undefined),
    token,
  )

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
// The command that sets a token, with the marketplace What's Next was
// installed from once session.start has read it off /config.
let configure = configureCommand([])

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
        : { kind: 'no-repo', reason: 'bad-origin', dir, origin: url.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1') }
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
  const c = await trackerOf(forge.kind, $, r, tok.value, forge.version).check()
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
// issues, the repo's open issues, and the epics. Then the milestones, the
// milestone filter, What's next and the epics follow.
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
  await update($, milestones, () => loaded.memory.milestones)
  await update($, closedMilestones, () => loaded.memory.closedMilestones)
  await showPicker($, r)
  if (issuesError === null) await showNext($, r)
  if (epicsError === null) await showEpics($, r)
  // The milestones folded open, and the one in its detail, are asked again;
  // the rest cost nothing.
  await update($, msIssues, () => ({}))
  const asked = await read($, milestonesUnfolded)
  const inDetail = await read($, milestoneOpen)
  for (const title of inDetail === null || asked.includes(inDetail) ? asked : [...asked, inDetail]) await showMilestone($, r, title)
}

// The open issues of milestone `title`, for the Milestones pane.
async function showMilestone($: EngineInterface, r: Repo, title: string) {
  if (!memory) return
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const issues = await milestoneIssues(tracker($, r), memory, title, me, !(await off($, 'deps'))).catch(() => null)
  await update($, msIssues, known => ({ ...known, [title]: issues }))
  await showTree($, r)
}

// The children every tree shown needs, as far as it is folded open: the
// Epics pane's, each milestone's folded open, and the one in its detail.
async function showTree($: EngineInterface, r: Repo) {
  if (!memory) return
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const ep = await read($, epics)
  const trees: Epic[][] = ep.kind === 'ok' ? [ep.groups.flatMap(g => g.epics)] : []
  const issuesOf = await read($, msIssues)
  const inDetail = await read($, milestoneOpen)
  for (const title of new Set([...(await read($, milestonesUnfolded)), ...(inDetail === null ? [] : [inDetail])])) {
    const issues = issuesOf[title]
    if (issues) trees.push(inMilestone(issues).epics.map(e => ({ number: e.number, title: e.title, state: e.state, due: e.due, children: e.children ?? null })))
  }
  const kids = await growTree(tracker($, r), memory, trees, new Set(await read($, unfolded)), me)
  await update($, treeKids, () => kids)
}

// Folds milestone `title` open or shut; open the first time, its issues are asked.
async function foldMilestone($: EngineInterface, title: string) {
  const was = await read($, milestonesUnfolded)
  await update($, milestonesUnfolded, () => (was.includes(title) ? was.filter(t => t !== title) : [...was, title]))
  const r = await read($, repo)
  if (!r || was.includes(title) || title in (await read($, msIssues))) return
  await counted($, title, () => showMilestone($, r, title))
}

// Opens milestone `title` in its detail, or the list again for null. Its
// issues are asked unless a fold already did.
async function openMilestone($: EngineInterface, title: string | null) {
  await update($, milestoneOpen, () => title)
  await update($, milestoneError, () => null)
  const r = await read($, repo)
  if (!r || title === null || title in (await read($, msIssues))) return
  await counted($, title, () => showMilestone($, r, title))
}

// Closes milestone `m`, or opens it again, then shows the list, read again,
// where it moved to Closed or back. A refusal keeps the detail open, shown
// under its actions.
async function closeMilestone($: EngineInterface, m: Milestone, closed: boolean) {
  const r = await read($, repo)
  if (!r) return
  const why = await tracker($, r).closeMilestone(m, closed)
  if (why !== null) {
    await update($, milestoneError, () => `Could not ${closed ? 'close' : 'reopen'} ${m.title}: ${why.replace(/\.$/, '')}.`)
    return
  }
  await openMilestone($, null)
  await refresh($)
}

// The milestone filter's options from what is open, and what it is set to:
// the person's choice while it is still offered, else where you work
// (docs/whats-next/ORDERING.md), else the first milestone, else All.
async function showPicker($: EngineInterface, r: Repo) {
  if (!memory) return
  const items = [...memory.mine, ...memory.free, ...memory.epics.filter(e => e.state === 'open')]
  const options = pickerOptions(memory.milestones, items)
  const wanted = await read($, milestonePick)
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const pick = options.some(o => o.value === wanted)
    ? (wanted as string)
    : ((await startingPick(tracker($, r), memory, me, options)) ?? options.find(o => o.value.startsWith('m:'))?.value ?? 'all')
  await update($, picker, () => ({ options, pick }))
}

// What's next within the milestone filter.
async function showNext($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const pick = (await read($, picker))?.pick ?? 'all'
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const next = await whatsNext(tracker($, r), known, pick, !(await off($, 'deps')), me, await $.clock.now())
  await update($, overview, (): Overview => ({ kind: 'ok', ...next }))
  // An issue that is closed, or now with others, closes: What's next shows.
  const shown = new Set([...known.mine, ...known.free].map(i => i.number))
  await update($, memberOf(picked, { requestId: PANE }), n => (n !== null && shown.has(n) ? n : null))
}

// The epics within the milestone filter, by milestone. What was shown stays
// up while this loads, so the milestone filter does not vanish under the person's hand.
async function showEpics($: EngineInterface, r: Repo) {
  if (!memory) return
  const known = memory
  const openEpics = known.epics.filter(i => i.state === 'open').length
  if (openEpics === 0) {
    await update($, epics, (): Epics => ({ kind: 'ok', groups: [], openEpics, held: [] }))
    return
  }
  // Who you are, from the setup check: the children assigned to you are yours.
  const s = await read($, setup)
  const me = s.kind === 'ready' ? s.login : null
  const pick = (await read($, picker))?.pick ?? 'all'
  try {
    const shown = await epicTree(tracker($, r), known, pick, me)
    await update($, epics, (): Epics => ({ kind: 'ok', ...shown, openEpics }))
    await showTree($, r)
  } catch (err) {
    await update($, epics, (): Epics => ({ kind: 'error', message: message(err) }))
  }
}

// Folds issue `n` open or shut in Epics; open, the children it now shows
// are asked for, those not asked before.
async function foldIssue($: EngineInterface, n: number) {
  const was = await read($, unfolded)
  await update($, unfolded, () => (was.includes(n) ? was.filter(x => x !== n) : [...was, n]))
  const r = await read($, repo)
  if (!r || was.includes(n)) return
  await counted($, `#${n}`, () => showTree($, r))
}

// Sets the milestone filter for both panes and closes its list.
async function pickMilestone($: EngineInterface, value: string) {
  await update($, pickerOpen, () => false)
  await update($, milestonePick, () => value)
  const r = await read($, repo)
  const label = (await read($, picker))?.options.find(o => o.value === value)?.label ?? value
  if (!r) return
  await counted($, label, async () => {
    await showPicker($, r)
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
    const hadMilestones = ((await read($, milestones)) ?? []).length > 0
    await load($, r)
    const after = await read($, epics)
    if (after.kind === 'ok') {
      await followPane($, EPICS_PANE, 'Epics', before.kind === 'ok' && before.openEpics > 0, after.openEpics > 0)
    }
    await followPane($, MILESTONES_PANE, 'Milestones', hadMilestones, ((await read($, milestones)) ?? []).length > 0)
    for (const pane of [PANE, EPICS_PANE, MILESTONES_PANE]) {
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

// The Epics or Milestones pane, `id`, follows a load that found the first
// open epic or milestone (`had` none before, `has` one now), or none left:
// it opens as a tab next to What's next, without the focus, or closes. A
// pane the person closed while there was something to show stays closed
// until /next. One opened without the person asking (a reload) may wait
// undrawn on a narrow terminal; the next Refresh, which they ask for, opens
// it again so it is drawn.
async function followPane($: EngineInterface, id: string, title: string, had: boolean, has: boolean) {
  // The engine's record says whether it is drawn; without it, What's Next's own
  // list of open panes, taken as drawn.
  const panes = await $.ui.panes().catch(async () => (await read($, panesOpen)).map(id => ({ id, isPlaced: true })))
  const pane = panes.find(p => p.id === id)
  if (has && (pane ? !pane.isPlaced : !had)) {
    await $.ui.open({ id, title })
    await update($, panesOpen, ids => (ids.includes(id) ? ids : [...ids, id]))
  } else if (!has && pane) {
    await $.ui.close({ id })
    await update($, panesOpen, ids => ids.filter(i => i !== id))
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

// A due date's colour: red once passed, amber within 7 days, dim otherwise.
function dueLook(iso: string, now: number): { color?: string; dimColor?: boolean } {
  const soon = dueSoon(iso, now)
  return soon === 'passed' ? { color: 'error' } : soon === 'soon' ? { color: 'warning' } : { dimColor: true }
}

// How a place shows its due date (docs/whats-next/DRAWING.md): the short form (30 Oct) or
// the long one (30 Oct, in 19 days); `bare` leaves out the ⧗ before it, `done`
// draws it dim, and `width` pads it to a column. No due date shows nothing.
type DueShown = { form: 'short' | 'long'; bare?: boolean; done?: boolean; width?: number }

// The words of a due date as `o` shows it; null where nothing is shown.
function dueWords(iso: string | null, now: number, o: DueShown): string | null {
  const words = iso ? `${o.bare ? '' : '⧗ '}${o.form === 'short' ? day(iso, now) : dueText(iso, now).text}` : null
  if (words === null) return o.width ? ''.padEnd(o.width) : null
  return o.width ? words.padEnd(o.width) : words
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
  for (const p of [PANE, EPICS_PANE, MILESTONES_PANE]) {
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
      ? `Run \`${configure}\` and paste it as ${t.setting}.`
      : `Run \`${configure}\` and paste it as ${t?.setting ?? 'Forgejo tokens'}, alone or as \`${host}=<token>\` next to tokens for other hosts.`,
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

  // A due date, drawn: every due date in the panes is drawn by this.
  const dueDate = (key: string, iso: string | null, now: number, o: DueShown): RenderChildren | null => {
    const words = dueWords(iso, now, o)
    if (words === null) return null
    return (
      <Text key={key} {...(iso && !o.done ? dueLook(iso, now) : { dimColor: true })}>
        {words}
      </Text>
    )
  }
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
  // One part of a line made of parts: its words, dim unless it has a
  // colour, or drawn as `node` where it is more than one text.
  type Part = { text: string; color?: string; node?: RenderChildren }
  // Parts joined by a dim ` · ` (DRAWING.md, Lines that hold several parts).
  const joined = (parts: readonly Part[]): RenderChildren[] =>
    parts.flatMap((p, k) => [
      ...(k > 0 ? [<Text key={`sep-${k}`} dimColor>{' · '}</Text>] : []),
      p.node ?? (
        <Text key={`part-${k}`} color={p.color} dimColor={!p.color}>
          {p.text}
        </Text>
      ),
    ])
  // A due date as one part of a line: none where there is no due date, so
  // a line never starts with ` · `.
  const duePart = (key: string, iso: string | null, now: number, o: DueShown): Part[] =>
    iso ? [{ text: dueWords(iso, now, o) ?? '', node: dueDate(key, iso, now, o) }] : []
  // A line of parts `lead` columns in: one text, cut once at its end, so a
  // narrow pane cuts its last parts and never squeezes them one by one.
  const partsLine = (key: string, lead: number, parts: readonly Part[]) => (
    <Text key={key} wrap="truncate-end">
      {' '.repeat(lead)}
      {joined(parts)}
    </Text>
  )
  // A rule (DRAWING.md, Rules): `── ` dim, its name bold, what belongs to it
  // after ` · `, and the line to the pane's edge, in one text. One that
  // folds starts with its + or − instead, plain, and is one target.
  const rule = (key: string, name: string, after: readonly Part[] = [], fold?: { key: string; open: boolean; onPress: () => unknown }) => {
    const lead = fold ? `${fold.open ? '−' : '+'} ` : '── '
    const used = lead.length + name.length + after.reduce((n, p) => n + 3 + p.text.length, 0) + 1
    const text = (
      <Text wrap="truncate-end">
        <Text dimColor={!fold}>{lead}</Text>
        <Text bold>{name}</Text>
        {after.length > 0 && <Text dimColor>{' · '}</Text>}
        {joined(after)}
        <Text dimColor>{` ${'─'.repeat(Math.max(0, columns - used))}`}</Text>
      </Text>
    )
    return (
      <Box key={key} height={1} flexShrink={0}>
        {fold ? (
          <Button key={fold.key} plain onPress={fold.onPress}>
            {text}
          </Button>
        ) : (
          text
        )}
      </Box>
    )
  }
  // A row's mark and the space after it (DRAWING-issue.md, Marks).
  const markText = (m: Mark) => (
    <Text key="mark" color={m.color} dimColor={m.dim}>
      {`${m.glyph} `}
    </Text>
  )
  // An issue's number at the right of its column, and a space: blue, grey
  // once closed (DRAWING-issue.md, Number and title).
  const numberText = (n: number, width: number, closed = false) => (
    <Text key="number" color={closed ? 'inactive' : 'suggestion'}>{`${`#${n}`.padStart(width - 1)} `}</Text>
  )
  // How many are closed, of all, at the end of a row: the bar where the row
  // has room for one, then the count, dim in 6 columns (DRAWING.md, Counts).
  const barText = (closed: number, total: number): RenderChildren[] => {
    const b = bar(closed, total)
    return [
      b.filled ? (
        <Text key="filled" color="success">
          {b.filled}
        </Text>
      ) : null,
      b.empty ? (
        <Text key="empty" dimColor>
          {b.empty}
        </Text>
      ) : null,
    ]
  }
  const countText = (closed: number, total: number, withBar: boolean): RenderChildren[] => [
    ...(withBar ? barText(closed, total) : []),
    <Text key="count" dimColor>
      {`${closed}/${total}`.padStart(6)}
    </Text>,
  ]
  // The bar and count take 15 columns at the end of a row, the count alone 6;
  // a closed row ends in ✓ where an open one's count ends.
  const COUNT = 15
  const CLOSED_END = '✓'.padStart(COUNT - 1)
  // A closed epic: one grey row, `lead` columns in, ending in ✓ where an open
  // one's count ends; it opens its detail.
  const closedRow = (key: string, buttonKey: string, lead: number, n: number, numWidth: number, title: string, onPress: () => unknown) => {
    const width = Math.max(0, columns - lead - numWidth - COUNT)
    return (
      <Box key={key} flexShrink={0}>
        <Button key={buttonKey} plain onPress={onPress}>
          <Text wrap="truncate-end" color="inactive">
            {`${' '.repeat(lead)}${`#${n}`.padStart(numWidth - 1)} ${fit(title, width).padEnd(width)} ${CLOSED_END}`}
          </Text>
        </Button>
      </Box>
    )
  }
  // How many children or issues under an unfolded row are closed: one grey
  // line in the mark column, `lead` columns in.
  const closedLine = (key: string, lead: number, n: number) => line(key, `${' '.repeat(lead)}✓ ${n} closed`, { color: 'inactive' })
  // A row at the top of a tree that folds (DRAWING.md, Rows that fold): its
  // mark, a target that folds it, then the rest of the row, `body`, a target
  // that opens its detail.
  const foldRow = (o: {
    lead: number
    mark: Mark
    foldKey: string
    onFold: () => unknown
    openKey: string
    onOpen: () => unknown
    body: RenderChildren[]
    color?: string
  }) => (
    <Box height={1}>
      {o.lead > 0 && <Text>{' '.repeat(o.lead)}</Text>}
      <Button key={o.foldKey} plain onPress={o.onFold}>
        {markText(o.mark)}
      </Button>
      <Button key={o.openKey} plain onPress={o.onOpen}>
        <Text wrap="truncate-end" color={o.color}>
          {o.body}
        </Text>
      </Button>
    </Box>
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
  // A section still ends in an empty line with Compact on, where its rows
  // no longer leave one (DRAWING.md, Rules).
  const sectionEnd = (key: string) => (compact ? [<Box key={`end-${key}`} height={1} flexShrink={0} />] : [])
  const today = await $.clock.now()
  // How many open issues wait on issue `n`, as far as What's next knows.
  const waiting = (n: number) => (m.kind === 'ok' ? (m.unblocks[n] ?? 0) : 0)
  // One issue as every list shows it (DRAWING-issue.md): its mark, number
  // and title on a button that opens it, and under it the facts line: what
  // blocks it, how many it unblocks, its due date, its milestone (unless the
  // milestone filter is set to it), its labels in colour and its age. `lead` indents it in a tree; `who` names
  // whom it is with, dim at the right.
  type RowIssue = Pick<IssueRow, 'number' | 'title' | 'labels' | 'milestone' | 'created' | 'due'>
  type RowLook = {
    key: string
    buttonKey: string
    numWidth: number
    standing: Standing
    bold?: boolean
    lead?: number
    who?: string
    blockedBy?: number[]
    // Leaves the milestone out of the facts, where the list is one milestone's.
    noMilestone?: boolean
    // A row with children of its own, in the tree: its fold mark, coloured by
    // its standing, a target of its own (none for one shown above), and how
    // many of its children are closed, of all, at the right.
    fold?: { state: Folding; key: string; onPress?: () => unknown }
    count?: string
    // Said dim on the second line, in place of the facts.
    note?: string
    onPress: () => unknown
  }
  // Whom a child is with, for the right of its row: the first assignee of
  // one with others, or of one blocked that someone holds.
  const whoOf = (c: { assignees: string[] }, st: Standing) =>
    st === 'withOthers' || (st === 'blocked' && c.assignees.length > 0) ? (c.assignees[0] ?? '') : ''
  const issueRow = (i: RowIssue, o: RowLook) => {
    const lead = ' '.repeat(o.lead ?? 0)
    const dim = o.standing === 'blocked'
    const opened: Part[] = i.created ? [{ text: `✎ ${age(i.created, today)}` }] : []
    // What blocks it: ⊘ dim, its numbers blue, as issue numbers are.
    const blockers = (by: number[]): Part => ({
      text: `⊘ ${by.map(n => `#${n}`).join(', ')}`,
      node: [
        <Text key="by" dimColor>
          {'⊘ '}
        </Text>,
        ...by.flatMap((n, k) => [
          ...(k > 0 ? [<Text key={`by-sep-${k}`} dimColor>{', '}</Text>] : []),
          <Text key={`by-${n}`} color="suggestion">
            {`#${n}`}
          </Text>,
        ]),
      ],
    })
    const shownMilestone = !o.noMilestone && i.milestone !== null && pk?.pick !== `m:${i.milestone}`
    // The facts line's recipe (DRAWING-issue.md, The facts line).
    const facts: Part[] = o.note
      ? [{ text: o.note }]
      : [
          ...(o.blockedBy && o.blockedBy.length > 0 ? [blockers(o.blockedBy)] : []),
          // How many open issues wait on it: ↦, the bar this issue, the arrow what it opens.
          ...(waiting(i.number) > 0 ? [{ text: `↦ ${waiting(i.number)}` }] : []),
          ...duePart('due', i.due, today, { form: 'short' }),
          ...(shownMilestone ? [{ text: i.milestone ?? '' }] : []),
          ...(i.labels.length > 0 ? [{ text: '', node: labelTexts(i.labels) }] : []),
          ...opened,
        ]
    const room = columns - (o.lead ?? 0) - 2 - o.numWidth - (o.count !== undefined ? 6 : 0)
    const title =
      o.who || o.count !== undefined
        ? `${fit(i.title, room - (o.who ? o.who.length + 1 : 0)).padEnd(room - (o.who ? o.who.length + 1 : 0))}${o.who ? ' ' : ''}`
        : fit(i.title, room)
    const fold = o.fold
    const mark = markOf(o.standing, fold?.state ?? null)
    const rest = [
      numberText(i.number, o.numWidth),
      dim ? <Text key="title" dimColor>{title}</Text> : title,
      o.who ? <Text key="who" dimColor>{o.who}</Text> : null,
      o.count !== undefined ? <Text key="count" dimColor>{o.count.padStart(6)}</Text> : null,
    ]
    return (
      <Box key={o.key} flexDirection="column" marginBottom={gap} flexShrink={0}>
        {fold ? (
          // Two targets, as an epic's: the mark folds, the rest opens its detail.
          <Box height={1}>
            <Text>{lead}</Text>
            {fold.onPress ? (
              <Button key={fold.key} plain onPress={fold.onPress}>
                {markText(mark)}
              </Button>
            ) : (
              markText(mark)
            )}
            <Button key={o.buttonKey} plain onPress={o.onPress}>
              <Text wrap="truncate-end">{rest}</Text>
            </Button>
          </Box>
        ) : (
          <Button key={o.buttonKey} plain onPress={o.onPress}>
            <Text wrap="truncate-end" bold={o.bold}>
              {lead}
              {markText(mark)}
              {rest}
            </Text>
          </Button>
        )}
        {/* One row: a line too long for the pane is cut, but would still
            take the height of its overflow. The indent keeps its width, so
            a cut line starts under the title like the others. */}
        {facts.length > 0 && (
          <Box height={1}>
            <Box key="indent" flexShrink={0}>
              <Text>{`${lead}${' '.repeat(2 + o.numWidth)}`}</Text>
            </Box>
            {partsLine('facts', 0, facts)}
          </Box>
        )}
      </Box>
    )
  }
  // What the trees know: the children loaded of any issue (undefined while
  // not asked yet), and the repo's open epics.
  const loadedKids = await read($, treeKids)
  const kidsOf = (n: number) => (n in loadedKids ? loadedKids[n] : undefined)
  const openEpicNumbers = new Set((memory?.epics ?? []).filter(e => e.state === 'open').map(e => e.number))
  // How a tree is drawn in a pane: its first level `lead` columns in, each
  // level two more; its rows open in `pane` and are addressed `button`-n.
  // `drawn` counts each issue drawn in the pane so far, so one shown again
  // gets another address; `at` sets its closing lines apart.
  type TreeLook = { lead: number; numWidth: number; pane: string; button: string; drawn: Map<number, number>; at: string }
  const drawTree = (under: TreeLine[], o: TreeLook): RenderChildren[] =>
    under.map((l, k) => {
      const lead = o.lead + 2 * l.depth
      if (l.kind !== 'child') {
        // A closing line sets itself apart from a row after it.
        const after = under[k + 1]?.kind === 'child' ? gap : 0
        const at = `${o.at}-${k}`
        const text = `${' '.repeat(lead + o.numWidth)}${l.kind === 'unknown' ? 'children unknown' : l.kind === 'none' ? 'no children' : 'Loading the children…'}`
        return (
          <Box key={`${l.kind}-${at}`} flexShrink={0} marginBottom={after}>
            {l.kind === 'closed' ? closedLine(`${l.kind}-line-${at}`, lead, l.closed) : line(`${l.kind}-line-${at}`, text, { dimColor: true })}
          </Box>
        )
      }
      const c = l.child
      // An issue shown twice needs another address the second time.
      const times = (o.drawn.get(c.number) ?? 0) + 1
      o.drawn.set(c.number, times)
      const at = times === 1 ? `${c.number}` : `${c.number}@${times}`
      const st = standing(c)
      return issueRow(c, {
        key: `${o.button}-row-${at}`,
        buttonKey: `${o.button}-${at}`,
        numWidth: o.numWidth,
        lead,
        standing: st,
        who: whoOf(c, st),
        blockedBy: st === 'blocked' ? c.blockedBy : undefined,
        ...(l.fold && {
          fold:
            l.fold === 'shown above'
              ? { state: l.fold, key: `fold-${at}` }
              : { state: l.fold, key: `fold-${at}`, onPress: () => foldIssue($, c.number) },
          count: l.count ? `${l.count.closed}/${l.count.total}` : '',
          ...(l.fold === 'shown above' && { note: 'shown above' }),
        }),
        onPress: () => openIssue($, o.pane, c.number),
      })
    })

  // An open epic at the top of a tree, in Epics and under a milestone: its
  // fold mark, number, bold title, bar and count; folded, the line under it:
  // its due date, then what there is for you in it.
  const epicRow = (x: Epic, o: { key: string; foldKey: string; openKey: string; lead: number; numWidth: number; open: boolean; pane: string }) => {
    const t = tally(x.children ?? [])
    const width = Math.max(0, columns - o.lead - 2 - o.numWidth - COUNT)
    return (
      <Box key={o.key} flexDirection="column" flexShrink={0} marginBottom={o.open ? 0 : gap}>
        {foldRow({
          lead: o.lead,
          mark: markOf(null, o.open ? 'unfolded' : 'folded'),
          foldKey: o.foldKey,
          onFold: () => foldIssue($, x.number),
          openKey: o.openKey,
          onOpen: () => openIssue($, o.pane, x.number),
          body: [
            numberText(x.number, o.numWidth),
            <Text key="title" bold>
              {`${fit(x.title, width).padEnd(width)} `}
            </Text>,
            ...countText(t.closed, t.total, true),
          ],
        })}
        {!o.open && partsLine(`under-${o.key}`, o.lead + 2 + o.numWidth, [...duePart('due', x.due, today, { form: 'short' }), ...summary(x)])}
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
      <Text wrap="truncate-end">
        <Text dimColor>{`↯ ${req.label}: `}</Text>
        <Text>{String(req.count)}</Text>
        <Text dimColor>{' requests'}</Text>
      </Text>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text>
          <Text>{String(req.total)}</Text>
          <Text dimColor>{' this session'}</Text>
        </Text>
      </Box>
    </Box>
  )
  // The milestone filter both panes share, and what it is set to.
  const pk = await read($, picker)
  const pickedOption = pk?.options.find(o => o.value === pk.pick)
  // What the milestone filter is set to, for a sentence: "in v1.2",
  // "without a milestone", or nothing for All. The section rules leave it
  // out: the milestone filter shows it.
  const within = !pk || pk.pick === 'all' ? '' : pk.pick === 'none' ? ' without a milestone' : ` in ${pickedOption?.label ?? ''}`
  // The title row both lists share: the pane's name when no tab names it,
  // the milestone filter, Refresh; with the milestone filter open, its list
  // under it at the right, each milestone with its due date and the one set in bold.
  // Milestones, which shows every milestone, has no milestone filter.
  const titleRow = async (name: string, withPicker = true) => {
    const shown = withPicker ? pickedOption : undefined
    const listOpen = pk !== null && shown !== undefined && (await read($, pickerOpen))
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
          {shown && (
            <Button key="milestone" label={`${shown.label} ▾`} hotkey="m" onPress={() => update($, pickerOpen, o => !o)} />
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
                  {dueDate('due', o.due ?? null, today, { form: 'short', bare: true, width: 6 })}
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
        {'      ✎ 1w'}
      </Text>,
      ...(spaced ? [<Box key={`gap-${spaced}`} height={1} />] : []),
      <Text key={`b-${spaced}`}>
        <Text color="suggestion">{'  #51 '}</Text>
        Rate limit settings page
      </Text>,
      <Text key={`b2-${spaced}`} dimColor>
        {'      ✎ 6d'}
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
          label={from !== undefined ? say(`${ICON.back} #${from}`, `← #${from}`) : say(ICON.back, inEpics ? '← Epics' : e.requestId === MILESTONES_PANE ? '← Milestones' : "← What's next")}
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
        facts.push(keyed('due', 'Due', dueDate('due-date', i.due, now, { form: 'long', bare: true })))
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
          {/* Closed: grey as a whole, number and title. */}
          {titleLines.map((t, k) => (
            <Text key={`t-${k}`} bold wrap="truncate-end" color={closed ? 'inactive' : undefined}>
              {k === 0 && !closed ? <Text color="suggestion">{`#${i.number}`}</Text> : null}
              {k === 0 && !closed ? t.slice(`#${i.number}`.length) : t}
            </Text>
          ))}
          {partsLine('state', 0, [
            { text: i.state },
            { text: i.milestone ? i.milestone.title : 'no milestone' },
            ...(milestoneDue ? [{ text: '', node: dueDate('milestone-due', milestoneDue, now, { form: 'short' }) }] : []),
            { text: comments },
          ])}
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
          rule('last', 'Last comment', [{ text: last.author }, { text: `${age(last.when, now)} ago` }]),
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

  // The Milestones pane, once setup passes: each open milestone folded, due
  // first, with how far it is from its own counts; then the last closed.
  if (e.requestId === MILESTONES_PANE && s.kind === 'ready' && r) {
    const now = await $.clock.now()
    const known = await read($, milestones)
    const folds = new Set(await read($, milestonesUnfolded))
    const rows: RenderChildren[] = []
    if (known === null) rows.push(line('loading', 'Loading the milestones…', { dimColor: true }))
    if (known !== null && known.length === 0) rows.push(para('none', `No open milestones in ${slug(r)}.`, { dimColor: true }))
    const issuesOf = await read($, msIssues)
    const closedOnes = await read($, closedMilestones)
    const showClosed = await read($, closedShown)
    const epicFolds = new Set(await read($, unfolded))
    // A milestone's issues as a tree, in its row folded open or in its
    // detail: its epics at the top of the tree, each with its fold mark, bar
    // and closed/total, folded the line under it and unfolded its tree; then
    // the issues no open epic in it holds, its closed epics grey (in a closed
    // milestone), and how many of its issues are closed.
    const treeOf = (issues: readonly MilestoneIssue[]) => {
      const parts = inMilestone(issues)
      const top = parts.epics.map((e): Epic => ({ number: e.number, title: e.title, state: e.state, due: e.due, children: e.children ?? null }))
      return { ...parts, lines: tree(top, kidsOf, epicFolds, openEpicNumbers).lines }
    }
    const milestoneNumbers = (issues: readonly MilestoneIssue[]) => {
      const { lines } = treeOf(issues)
      return [...issues.map(c => c.number), ...[...lines.values()].flat().flatMap(l => (l.kind === 'child' ? [l.child.number] : []))]
    }
    const milestoneRows = (ms: Milestone, issues: readonly MilestoneIssue[], isClosed: boolean, numWidth: number, drawn: Map<number, number>) => {
      const { epics: tops, plain, closedEpics, lines } = treeOf(issues)
      // An issue drawn twice in the pane needs another address the second time.
      const at = (n: number) => {
        const times = (drawn.get(n) ?? 0) + 1
        drawn.set(n, times)
        return times === 1 ? `${n}` : `${n}@${times}`
      }
      const out: RenderChildren[] = []
      for (const c of tops) {
        const unfolded = epicFolds.has(c.number)
        const key = at(c.number)
        const asEpic: Epic = { number: c.number, title: c.title, state: 'open', due: c.due, children: c.children ?? null }
        out.push(epicRow(asEpic, { key: `ms-epic-${key}`, foldKey: `fold-${key}`, openKey: `ms-issue-${key}`, lead: 2, numWidth, open: unfolded, pane: MILESTONES_PANE }))
        if (!unfolded) continue
        const under = lines.get(c.number) ?? []
        out.push(
          <Box key={`ms-tree-${key}`} flexDirection="column" flexShrink={0} marginBottom={under.at(-1)?.kind === 'child' ? 0 : gap}>
            {drawTree(under, { lead: 4, numWidth, pane: MILESTONES_PANE, button: 'ms-issue', drawn, at: `${ms.title}-${key}` })}
          </Box>,
        )
      }
      for (const c of openChildren(plain)) {
        const st = standing(c)
        const key = at(c.number)
        out.push(
          issueRow(c, {
            key: `ms-row-${key}`,
            buttonKey: `ms-issue-${key}`,
            numWidth,
            lead: 2,
            standing: st,
            who: whoOf(c, st),
            blockedBy: st === 'blocked' ? c.blockedBy : undefined,
            noMilestone: true,
            onPress: () => openIssue($, MILESTONES_PANE, c.number),
          }),
        )
      }
      if (isClosed) {
        for (const c of closedEpics) {
          const key = at(c.number)
          out.push(closedRow(`ms-epic-${key}`, `ms-issue-${key}`, 4, c.number, numWidth, c.title, () => openIssue($, MILESTONES_PANE, c.number)))
        }
      }
      if (ms.closed > 0) out.push(closedLine(`closed-${ms.title}`, 2, ms.closed))
      return out
    }

    // A milestone open: its detail in place of the list. One no longer
    // listed after a Refresh shows the list.
    const inDetail = await read($, milestoneOpen)
    const shownMs = inDetail === null ? undefined : [...(known ?? []), ...closedOnes].find(m => m.title === inDetail)
    if (shownMs) {
      const isClosed = !(known ?? []).includes(shownMs)
      const issues = issuesOf[shownMs.title]
      const plain = (issues ?? []).filter(c => c.children === undefined)
      const parts = issues ? forYou(tally(plain)) : []
      // The heading wraps over two lines at most; a longer title ends the
      // second in ….
      const wrapped = wrap(shownMs.title, columns)
      const titleLines = wrapped.length > 2 ? [wrapped[0] ?? '', fit(shownMs.title.slice((wrapped[0] ?? '').length).trimStart(), columns)] : wrapped
      const when = shownMs.closedAt ? Math.round((now - Date.parse(shownMs.closedAt)) / 86400000) : null
      const state = !isClosed
        ? 'open'
        : when === null
          ? 'closed'
          : `closed ${when === 0 ? 'today' : when === 1 ? 'yesterday' : `${when} days ago`}`
      // All closed is amber while the milestone is still open: close it.
      const allClosed = shownMs.total > 0 && shownMs.closed === shownMs.total
      const progress: Part[] = [
        { text: `${shownMs.closed}/${shownMs.total}` },
        allClosed ? { text: 'all closed', ...(isClosed ? {} : { color: 'warning' }) } : { text: `${shownMs.total - shownMs.closed} open` },
      ]
      // Description, folded, shows its first three lines.
      const text = (shownMs.description ?? '').trim()
      const descLines = text === '' ? [] : wrap(text, columns)
      const descOpen = await read($, descriptionUnfolded)
      const descShown = descOpen || descLines.length <= 3 ? descLines.length : 3
      const body: RenderChildren[] = [
        <Box key="head" flexDirection="column" flexShrink={0}>
          {titleLines.map((t, k) => (
            <Text key={`t-${k}`} bold wrap="truncate-end" color={isClosed ? 'inactive' : undefined}>
              {t}
            </Text>
          ))}
          {partsLine('state', 0, [{ text: state }, ...duePart('due', shownMs.due, now, { form: isClosed ? 'short' : 'long', done: isClosed })])}
        </Box>,
        <Box key="progress" flexDirection="column" flexShrink={0} marginTop={1}>
          <Text wrap="truncate-end">
            {barText(shownMs.closed, shownMs.total)}
            {' '}
            {joined(progress)}
          </Text>
          {issues === undefined && line('ms-loading', 'Loading the issues…', { dimColor: true })}
          {issues === null && line('ms-unknown', 'issues unknown', { dimColor: true })}
          {issues && partsLine('for-you', 0, parts)}
        </Box>,
      ]
      // No Work on this or Assign: a milestone is not work you pick up. Close
      // and Reopen as on Issue detail, not where the token is read only.
      const url = shownMs.url
      const canClose = shownMs.id !== undefined && s.actions.kind !== 'read-only'
      const error = await read($, milestoneError)
      if (url || canClose) {
        body.push(
          <Box key="actions" flexDirection="column" flexShrink={0} marginTop={1}>
            <Box height={1}>
              {url && <Button key="open" label={say(ICON.open, 'Open in browser')} hotkey="o" onPress={() => openUrl($, url)} />}
              {url && canClose && <Text>{'  '}</Text>}
              {canClose && (
                <Button
                  key="close"
                  label={say(isClosed ? ICON.reopen : ICON.close, isClosed ? 'Reopen' : 'Close')}
                  hotkey="c"
                  onPress={() => counted($, `${isClosed ? 'reopen' : 'close'} ${shownMs.title}`, () => closeMilestone($, shownMs, !isClosed))}
                />
              )}
            </Box>
            {error && para('action-error', error, { color: 'error' })}
          </Box>,
        )
      }
      // Two sections, each folding on its rule as Closed does: Issues, the
      // milestone's issues as a tree, unfolded at first; then Description.
      const issuesShut = await read($, issuesFolded)
      body.push(
        <Box key="gap-issues" height={1} flexShrink={0} />,
        rule('issues-section-rule', 'Issues', [{ text: `${shownMs.total - shownMs.closed} open` }], {
          key: 'issues-section',
          open: !issuesShut,
          onPress: () => update($, issuesFolded, f => !f),
        }),
      )
      if (!issuesShut) {
        const list: RenderChildren[] = []
        if (issues === undefined) list.push(line('ms-list-loading', '  Loading the issues…', { dimColor: true }))
        if (issues === null) list.push(line('ms-list-unknown', '  issues unknown', { dimColor: true }))
        if (issues) {
          const width = Math.max(0, ...milestoneNumbers(issues).map(n => `#${n}`.length)) + 1
          list.push(...milestoneRows(shownMs, issues, isClosed, width, new Map()))
        }
        body.push(
          <Box key="issues" flexDirection="column" flexShrink={0}>
            {list}
          </Box>,
        )
      }
      // Three lines or fewer: nothing to fold, the rule as on Issue detail.
      // One empty line before it: the last issue row leaves one without Compact.
      const endsInRow = !issuesShut && shownMs.closed === 0 && Array.isArray(issues) && issues.length > 0
      body.push(
        ...(endsInRow ? sectionEnd('desc') : [<Box key="gap-desc" height={1} flexShrink={0} />]),
        descLines.length > 3
          ? rule('description-section-rule', 'Description', [], { key: 'description-section', open: descOpen, onPress: () => update($, descriptionUnfolded, o => !o) })
          : rule('desc', 'Description'),
      )
      if (descLines.length === 0) body.push(line('no-desc', 'No description.', { dimColor: true }))
      descLines.slice(0, descShown).forEach((t, k) => body.push(line(`d-${k}`, t || ' ')))
      if (descShown < descLines.length) {
        body.push(line('d-more', `… ${descLines.length - descShown} more lines`, { dimColor: true }))
      }
      return (
        <Box flexDirection="column" height={height}>
          <Box key="title" height={1} flexShrink={0}>
            <Button key="back" label={say(ICON.back, '← Milestones')} hotkey="b" onPress={() => openMilestone($, null)} />
            <Box flexGrow={1} />
            <Button key="refresh" label={say(ICON.refresh, 'Refresh')} hotkey="r" onPress={() => counted($, 'Refresh', () => refresh($))} />
          </Box>
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
    // Bar and count at the right of a row.
    const titleWidth = Math.max(0, columns - 2 - COUNT)
    // One number column for every milestone folded open, so all titles line up.
    const numbers = [...folds].flatMap(t => milestoneNumbers(issuesOf[t] ?? []))
    const numWidth = Math.max(0, ...numbers.map(n => `#${n}`.length)) + 1
    const drawn = new Map<number, number>()
    // A milestone's row and, folded open, its issues. A closed one is a grey
    // row ending in ✓, its closed epics grey under its open issues.
    const depsOn = !(await off($, 'deps'))
    const draw = (ms: Milestone, isClosed: boolean) => {
      const open = folds.has(ms.title)
      // Once asked: its open issues, its epics first, and what there is for
      // you among the issues that are not epics.
      const issues = issuesOf[ms.title]
      const plain = (issues ?? []).filter(c => c.children === undefined)
      // Folded and never asked: only what is known without asking (yours,
      // the rest once every issue not yours was checked).
      const seen = issues || !memory ? null : milestoneKnown(memory, ms.title, depsOn)
      const parts = issues
        ? forYou(tally(plain))
        : seen
          ? forYou({ closed: 0, total: 0, ...(seen.checked ? seen : { yours: seen.yours, available: 0, withOthers: 0, blocked: 0 }) })
          : []
      // Two targets, as an epic's: the mark folds, the rest opens its detail.
      const fold = { foldKey: `ms-fold-${ms.title}`, onFold: () => foldMilestone($, ms.title), openKey: `milestone-${ms.title}`, onOpen: () => openMilestone($, ms.title) }
      const mark = markOf(null, open ? 'unfolded' : 'folded', isClosed)
      if (isClosed) {
        rows.push(
          <Box key={`ms-${ms.title}`} flexShrink={0}>
            {foldRow({ lead: 0, mark, ...fold, color: 'inactive', body: [`${fit(ms.title, titleWidth).padEnd(titleWidth)} ${CLOSED_END}`] })}
          </Box>,
        )
      } else {
        // One line, as under a folded epic: its due date, then all closed,
        // amber (the milestone is done, close it), or what there is for you.
        // Folded, issues it could not list say so; folded open, the list does.
        const allClosed = ms.total > 0 && ms.closed === ms.total
        const unknown = !open && (issues === null || (issues === undefined && memory !== null && !memory.listed))
        const under: Part[] = [
          ...duePart('due', ms.due, now, { form: 'short' }),
          ...(allClosed ? [{ text: 'all closed', color: 'warning' }] : unknown ? [{ text: 'issues unknown' }] : parts),
        ]
        rows.push(
          <Box key={`ms-${ms.title}`} flexDirection="column" flexShrink={0} marginBottom={open ? 0 : gap}>
            {foldRow({
              lead: 0,
              mark,
              ...fold,
              body: [
                <Text key="title" bold>
                  {`${fit(ms.title, titleWidth).padEnd(titleWidth)} `}
                </Text>,
                ...countText(ms.closed, ms.total, true),
              ],
            })}
            {under.length > 0 && partsLine(`under-${ms.title}`, 2, under)}
          </Box>,
        )
      }
      if (!open) return
      // Folded open: its issues, or that they are loading or unknown.
      const kids: RenderChildren[] = []
      if (issues === undefined) kids.push(line(`loading-${ms.title}`, '  Loading the issues…', { dimColor: true }))
      if (issues === null) kids.push(line(`unknown-${ms.title}`, '  issues unknown', { dimColor: true }))
      if (issues) kids.push(...milestoneRows(ms, issues, isClosed, numWidth, drawn))
      // The last issue row brings its own empty line; a closing line needs one.
      const endsInRow = ms.closed === 0 && issues !== undefined && issues !== null && issues.length > 0
      rows.push(
        <Box key={`ms-kids-${ms.title}`} flexDirection="column" flexShrink={0} marginBottom={endsInRow ? 0 : gap}>
          {kids}
        </Box>,
      )
    }
    for (const ms of dueFirst(known ?? [])) draw(ms, false)
    if (closedOnes.length > 0) {
      // The open milestones' rows leave an empty line only without Compact.
      if ((known ?? []).length > 0) rows.push(...sectionEnd('closed'))
      rows.push(
        <Box key="closed-rule" flexShrink={0} marginBottom={showClosed ? 0 : gap}>
          {rule('closed-rule-line', 'Closed', [{ text: `${closedOnes.length}` }], {
            key: 'closed-section',
            open: showClosed,
            onPress: () => update($, closedShown, o => !o),
          })}
        </Box>,
      )
      if (showClosed) for (const ms of closedOnes) draw(ms, true)
    }
    const count = known?.length ?? 0
    const openIssues = (known ?? []).reduce((n, ms) => n + ms.total - ms.closed, 0)
    return (
      <Box flexDirection="column" height={height}>
        {await titleRow('Milestones', false)}
        <Box key="gap" height={1} flexShrink={0} />
        <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {rows}
        </Box>
        {fixedLine('where-rule', '─'.repeat(columns))}
        <Box key="where" height={1} flexShrink={0}>
          {count > 0 && partsLine('counts', 0, [{ text: `${count} ${count === 1 ? 'milestone' : 'milestones'}` }, { text: `${openIssues} open` }])}
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
    // The tree under each unfolded epic, from what is loaded so far.
    const { lines: treeLines } = tree(groups.flatMap(g => g.epics), kidsOf, folds, openEpicNumbers)
    // One number column for every group, so all titles line up.
    const numbers = groups.flatMap(g =>
      g.epics.flatMap(x => [x.number, ...(treeLines.get(x.number) ?? []).flatMap(l => (l.kind === 'child' ? [l.child.number] : []))]),
    )
    const numWidth = Math.max(0, ...numbers.map(n => `#${n}`.length)) + 1
    const drawn = new Map<number, number>()
    // Whether what was pushed last ends in an empty line: an open epic's row
    // or tree does without Compact, a closed epic's row never does.
    let blank = false
    groups.forEach((g, gi) => {
      // The group's rule: the milestone's name, its due date and how many of
      // its issues are closed.
      const due: Part[] = g.title ? duePart('due', g.due, now, { form: 'short' }) : []
      rows.push(
        // After the first, one empty line before it (DRAWING.md, Rules).
        <Box key={`group-${gi}`} flexShrink={0} marginTop={gi > 0 && !blank ? 1 : 0}>
          {rule(`group-rule-${gi}`, g.title ?? 'No milestone', g.title ? [...due, { text: `${g.closed}/${g.total} closed` }] : [])}
        </Box>,
      )
      for (const x of g.epics) {
        // A closed epic has nothing to fold; its row opens its detail.
        if (x.state === 'closed') {
          rows.push(closedRow(`epic-${x.number}`, `epic-${x.number}`, 2, x.number, numWidth, x.title, () => openIssue($, EPICS_PANE, x.number)))
          blank = false
          continue
        }
        blank = !compact
        rows.push(epicRow(x, { key: `epic-${x.number}`, foldKey: `fold-${x.number}`, openKey: `epic-${x.number}`, lead: 0, numWidth, open: open(x), pane: EPICS_PANE }))
        if (!open(x)) continue
        // Folded open: the tree under it, each level two columns further in.
        const under = treeLines.get(x.number) ?? []
        const kids = drawTree(under, { lead: 2, numWidth, pane: EPICS_PANE, button: 'child', drawn, at: `${x.number}` })
        // The last child row brings its own empty line; a closing line needs one.
        const endsInRow = under.at(-1)?.kind === 'child'
        rows.push(
          <Box key={`kids-${x.number}`} flexDirection="column" flexShrink={0} marginBottom={endsInRow ? 0 : gap}>
            {kids}
          </Box>,
        )
      }
    })
    // Every open epic in the milestone filter, at the top or under a parent; each child
    // of yours once, however many epics hold it.
    const shown = [...groups.flatMap(g => g.epics), ...(ep.kind === 'ok' ? ep.held : [])].filter(x => x.state === 'open')
    const yours = new Set(shown.flatMap(x => (x.children ?? []).filter(c => c.state === 'open' && standing(c) === 'yours').map(c => c.number))).size
    const openShown = shown.length
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
          {g && partsLine('counts', 0, [{ text: `${openShown} ${openShown === 1 ? 'epic' : 'epics'}` }, { text: `${yours} yours`, color: 'success' }])}
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
    // Last closed, above the bottom line: its rule and its row.
    const lastRows: RenderChildren[] = []
    // Whether the list ends without an empty line, for Last closed's rule.
    let lastOpen = false
    if (m.kind === 'loading') rows.push(line('loading', 'Loading the issues…', { dimColor: true }))
    if (m.kind === 'ok') {
      const later = [...m.queue, ...m.blocked.map(b => b.issue)]
      const listed = [...m.inProgress, ...(m.next ? [m.next] : []), ...later]
      // The number column: the longest number and a space, so titles and
      // the lines under them line up whatever the numbers. Numbers sit at
      // its right, their last digits in line. Last closed shares it.
      const numWidth = Math.max(...[...listed, ...(m.lastClosed ? [m.lastClosed] : [])].map(i => `#${i.number}`.length), 0) + 1
      // Where an issue of Next or the Queue was taken from, after the
      // section's name in its rule (ORDERING.md, Scopes): `in epic #30`, the
      // number blue, or `in v1.2`; nothing for the rest of the milestone filter.
      const scopePart = (sc: Scope | undefined): Part[] =>
        sc === undefined
          ? []
          : sc.kind === 'milestone'
            ? [{ text: `in ${sc.title}` }]
            : [
                {
                  text: `in epic #${sc.number}`,
                  node: [
                    <Text key="in" dimColor>
                      {'in epic '}
                    </Text>,
                    <Text key="epic" color="suggestion">{`#${sc.number}`}</Text>,
                  ],
                },
              ]
      const sameScope = (a: Scope | undefined, b: Scope | undefined) =>
        a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))
      // The mark says how a row stands for you: yours in In progress,
      // available in Next and the Queue, blocked at the Queue's end. Next is
      // also bold; nothing has the focus until Tab or an arrow moves it.
      const STANDING = { progress: 'yours', next: 'available', queue: 'available', blocked: 'blocked' } as const
      const row = (i: IssueRow, section: keyof typeof STANDING, blockedBy?: number[]) => {
        return issueRow(i, {
          key: `issue-${i.number}`,
          buttonKey: `pick-${i.number}`,
          numWidth,
          standing: STANDING[section],
          bold: section === 'next',
          blockedBy,
          onPress: () => openIssue($, PANE, i.number),
        })
      }
      // Exactly one empty line before every rule but the first, Compact or
      // not (DRAWING.md, Rules): a row leaves one only without Compact, a
      // paragraph always does. `open`: what was pushed last ends without one.
      let open = false
      const pushRow = (...items: RenderChildren[]) => {
        rows.push(...items)
        open = compact
      }
      const pushBlock = (item: RenderChildren) => {
        rows.push(item)
        open = false
      }
      const pushRule = (item: RenderChildren) => {
        if (open) rows.push(<Box key={`end-${rows.length}`} height={1} flexShrink={0} />)
        rows.push(item)
        open = false
      }
      if (listed.length === 0) {
        rows.push(para('none', within ? `No open issues${within}.` : `No open issues in ${slug(r)}.`, { dimColor: true }))
        open = true
      } else {
        pushRule(rule('in-progress', 'In progress', [{ text: `${m.inProgress.length}` }]))
        if (m.inProgress.length === 0) {
          pushBlock(
            <Box key="no-progress" flexDirection="column" marginBottom={1} flexShrink={0}>
              {para('no-progress-text', 'Nothing in progress. Assign yourself an issue to start.', { dimColor: true })}
            </Box>,
          )
        }
        for (const i of m.inProgress) pushRow(row(i, 'progress'))
        pushRule(rule('next', 'Next', scopePart(m.next ? m.scopes[m.next.number] : undefined)))
        if (m.next) pushRow(row(m.next, 'next'))
        else if (m.blocked.length > 0) {
          pushBlock(
            <Box key="nothing-available" flexDirection="column" marginBottom={1} flexShrink={0}>
              {line('nothing-available-title', 'Nothing available', { bold: true })}
              {para('nothing-available-why', waitingText(m.blocked), { dimColor: true })}
            </Box>,
          )
        } else {
          pushBlock(
            <Box key="nothing-else" flexDirection="column" marginBottom={1} flexShrink={0}>
              {para('nothing-else-text', 'No other open issues.', { dimColor: true })}
            </Box>,
          )
        }
        // The Queue shows up to its limit, a rule for each scope it takes
        // from and no count (DRAWING.md, Rules); the issues past the limit
        // are counted on one line under the available ones.
        if (later.length > 0) {
          if (m.queue.length === 0) pushRule(rule('queue', 'Queue'))
          m.queue.forEach((i, k) => {
            const sc = m.scopes[i.number]
            const before = k > 0 ? m.queue[k - 1] : undefined
            if (k === 0 || !sameScope(sc, before && m.scopes[before.number])) {
              pushRule(rule(k === 0 ? 'queue' : `queue-${i.number}`, 'Queue', scopePart(sc)))
            }
            pushRow(row(i, 'queue'))
          })
          if (m.more > 0) {
            pushRow(
              <Box key="more" flexDirection="column" marginBottom={gap} flexShrink={0}>
                {line('more-text', `${' '.repeat(2)}and ${m.more} more`, { dimColor: true })}
              </Box>,
            )
          }
          for (const b of m.blocked) pushRow(row(b.issue, 'blocked', b.by))
        }
      }
      lastOpen = open
      // The issue you closed last within the milestone filter, as What's next
      // follows on from it: a rule saying how long ago and the epic it was in,
      // then one grey closed row, ✓ in the mark column, that opens it.
      const last = m.lastClosed
      if (last) {
        lastRows.push(
          rule('last-closed', 'Last closed', [{ text: `${age(last.closed, today)} ago` }, ...(last.epic !== null ? scopePart({ kind: 'epic', number: last.epic }) : [])]),
        )
        lastRows.push(
          <Box key="last-closed-row" flexShrink={0}>
            <Button key="last-closed-open" plain onPress={() => openIssue($, PANE, last.number)}>
              <Text wrap="truncate-end" color="inactive">
                {'✓ '}
                {numberText(last.number, numWidth, true)}
                {fit(last.title, columns - 2 - numWidth)}
              </Text>
            </Button>
          </Box>,
        )
      }
    }
    // Once loaded, how many open issues What's Next counted and how many are
    // yours, in In progress green; the version at the right.
    const open = m.kind === 'ok' ? m.inProgress.length + (m.next ? 1 : 0) + m.queue.length + m.more + m.blocked.length : null
    const bottomLine = (
      <Box key="where" height={1} flexShrink={0}>
        {m.kind === 'ok' && partsLine('counts', 0, [{ text: `${open} open` }, { text: `${m.inProgress.length} yours`, color: 'success' }])}
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
        {lastRows.length > 0 && (
          <Box key="last" flexDirection="column" flexShrink={0} marginTop={lastOpen ? 1 : 0}>
            {lastRows}
          </Box>
        )}
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
  // The milestone filter starts where you work again: a choice holds until /next.
  await update($, milestonePick, () => null)
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
  // The Milestones pane, a tab after Epics, only while there are open
  // milestones; one the person closed opens again.
  const ms = await read($, milestones)
  const open = await read($, panesOpen)
  if (r && s.kind === 'ready' && ms !== null && ms.length > 0 && !open.includes(MILESTONES_PANE)) {
    await $.ui.open({ id: MILESTONES_PANE, title: 'Milestones' })
    await update($, panesOpen, ids => (ids.includes(MILESTONES_PANE) ? ids : [...ids, MILESTONES_PANE]))
  } else if (ms !== null && ms.length === 0 && open.includes(MILESTONES_PANE)) {
    await $.ui.close({ id: MILESTONES_PANE })
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
  const scope = o.next ? o.scopes[o.next.number] : undefined
  const where = scope?.kind === 'epic' ? `, in epic #${scope.number}` : scope?.kind === 'milestone' ? `, in ${scope.title}` : ''
  const then = o.next ? `next is #${o.next.number}${where}` : o.blocked.length > 0 ? 'nothing available' : 'nothing else open'
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
    // Which marketplace What's Next came from, for the command that sets a token.
    configure = configureCommand(((await $.config.list().catch(() => [])) ?? []).map(r => r.key))
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
    const ours = (await $.ui.panes().catch(() => [])).map(p => p.id).filter(id => id === PANE || id === EPICS_PANE || id === MILESTONES_PANE)
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
  on('ui.close', { id: MILESTONES_PANE }, paneClosed)
  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: EPICS_PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: MILESTONES_PANE }, renderPane)
}
