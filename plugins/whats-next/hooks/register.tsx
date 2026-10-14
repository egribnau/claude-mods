import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, RenderInput } from 'claude-code'

import type { Comment, Detail, Epic, Epics, IssueDetail, IssueRow, Milestone, MilestoneFilter, Overview, Ref, Repo, Setup, TokenSource } from '../types'
import { draw, type Look } from './draw'
import { inMilestone } from './epics'
import { configureCommand, type Forge, type TokenSetting } from './forge'
import { ALL, filterWord, sameFilter } from './filter'
import { changesSince, loadRepo, noteChange, type Known } from './load'
import { anyToken, checkForge, findRepo, trackerFor, type Tokens } from './setup'
import { message, slug, type Send, type Tracker } from './tracker'
import * as step from './where'
import { issueOf } from './where'
import { EPICS_PANE, go, MILESTONES_PANE, milestoneShown, PANE, placeOf } from './panes'
import { epicsView } from './views/epics'
import { frame, hidden, views, type Acts, type Pane } from './views/frame'
import { helpView } from './views/help'
import { issueView } from './views/issue'
import { milestonesView } from './views/milestones'
import { nextView } from './views/next'
import { compactChoice, iconsChoice, setupView } from './views/setup'

// The command, and the one it falls back to when another has /next.
const COMMAND = 'next'
const FALLBACK_COMMAND = 'whats-next'

const repo = atom({ plugin: 'whats-next', key: 'repo' } as const, null)
const version = atom({ plugin: 'whats-next', key: 'version' } as const, null)
const token = atom({ plugin: 'whats-next', key: 'token' } as const, null)
const setup = atom({ plugin: 'whats-next', key: 'setup' } as const, { kind: 'checking' })
const overview = atom({ plugin: 'whats-next', key: 'overview' } as const, { kind: 'idle' })
// Per pane, keyed by its id: what was loaded for the issue it shows. Each
// pane opens issues in a detail of its own; where it is, hooks/panes.ts.
const detail = atom({ plugin: 'whats-next', key: 'detail' } as const, { kind: 'idle' })
const iconsChosen = atom({ plugin: 'whats-next', key: 'icons' } as const, null)
const compactChosen = atom({ plugin: 'whats-next', key: 'compact' } as const, null)
const epics = atom({ plugin: 'whats-next', key: 'epics' } as const, { kind: 'idle' })
const unfolded = atom({ plugin: 'whats-next', key: 'unfolded' } as const, [])
const treeKids = atom({ plugin: 'whats-next', key: 'treeKids' } as const, {})
const issuesFolded = atom({ plugin: 'whats-next', key: 'issuesFolded' } as const, false)
const descriptionUnfolded = atom({ plugin: 'whats-next', key: 'descriptionUnfolded' } as const, false)
const milestones = atom({ plugin: 'whats-next', key: 'milestones' } as const, null)
const milestonesUnfolded = atom({ plugin: 'whats-next', key: 'milestonesUnfolded' } as const, [])
const milestoneError = atom({ plugin: 'whats-next', key: 'milestoneError' } as const, null)
const msIssues = atom({ plugin: 'whats-next', key: 'milestoneIssues' } as const, {})
const closedMilestones = atom({ plugin: 'whats-next', key: 'closedMilestones' } as const, [])
const panesOpen = atom({ plugin: 'whats-next', key: 'panesOpen' } as const, [])
const filterChosen = atom({ plugin: 'whats-next', key: 'filterChosen' } as const, null)
const filterShown = atom({ plugin: 'whats-next', key: 'filterShown' } as const, null)
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

// The tracker behind repo `r`, as setup's check found its forge.
const tracker = ($: EngineInterface, r: Repo): Tracker => trackerFor(send($), r, forges.get(r.host), configTokens, configLabel)

// Runs an action and records how many requests it sent, under `label`.
async function counted<T>($: EngineInterface, label: string, action: () => Promise<T>): Promise<T> {
  const before = requestsMade
  const result = await action()
  const count = requestsMade - before
  await update($, requests, last => ({ label, count, total: (last?.total ?? 0) + count }))
  return result
}

// The token settings' text, read in `register`; a reload reads them again.
const configTokens: Tokens = {
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

// The /config row key of What's Next's setting `field`: `whats-next.<field>`
// from a folder, else `whats-next@<marketplace>.<field>`, and a marketplace
// name may hold a dot (`configureCommand` reads the same keys).
const settingKey = (field: string) => new RegExp(`^whats-next(@.*)?\\.${field}$`)

// Saves the Icons choice: in /config where the session offers it, and in the
// session's state so it shows at once.
async function chooseIcons($: EngineInterface, value: 'icons' | 'text') {
  await update($, iconsChosen, () => value)
  const rows = await $.config.list()
  const row = rows.find(r => settingKey('icons').test(r.key))
  if (!row) return
  const done = await $.config.set({ key: row.key, value })
  if (done.deny !== undefined) $.ui.toast(`Icons not saved: ${done.deny}`)
}

// Saves the Compact choice the same way.
async function chooseCompact($: EngineInterface, value: 'on' | 'off') {
  await update($, compactChosen, () => value)
  const rows = await $.config.list()
  const row = rows.find(r => settingKey('compact').test(r.key))
  if (!row) return
  const done = await $.config.set({ key: row.key, value })
  if (done.deny !== undefined) $.ui.toast(`Compact not saved: ${done.deny}`)
}

// Each step in turn, stopping at the first that fails (hooks/setup.ts has
// the steps): this reads `git`, keeps what each step found and passes the
// settings in.
async function check($: EngineInterface): Promise<Repo | null> {
  await update($, setup, (): Setup => ({ kind: 'checking' }))
  await update($, token, () => anyToken(configTokens))

  const git = async (...args: string[]) => {
    const run = await $.process.run(['git', ...args]).catch(() => null)
    return run?.exitCode === 0 ? run.stdout.trim() : null
  }
  const url = await git('remote', 'get-url', 'origin')
  const found = await findRepo(url, async () => {
    const inRepo = url !== null || (await git('rev-parse', '--is-inside-work-tree')) === 'true'
    const pwd = await $.process.run(['pwd']).catch(() => null)
    return { inRepo, dir: (pwd?.exitCode === 0 ? pwd.stdout.trim() : 'this folder').replace(/^\/(?:Users|home)\/[^/]+/, '~') }
  })
  const r = found.repo
  await update($, repo, () => r)
  await update($, version, () => null)
  if (!r) {
    await update($, setup, () => found.setup)
    return null
  }

  const checked = await checkForge(send($), r, configTokens, configLabel, forges.get(r.host))
  forges.set(r.host, checked.forge)
  await update($, token, () => checked.token)
  await update($, version, () => checked.version)
  await update($, setup, () => checked.setup)
  return r
}

// What is known of the repo, built by each load and kept until the next
// Refresh or /next; while a load asks again, the last one's.
let known: Known | null = null

// Asks the tracker for what the panes show: the open milestones, your open
// issues, the repo's open issues, and the epics. Then the milestones, the
// milestone filter, What's next and the epics follow. What was known before
// goes to What's next, which tells an issue that left the lists from one
// that was never in them.
async function load($: EngineInterface, r: Repo) {
  const before = known
  if ((await read($, overview)).kind !== 'ok') await update($, overview, (): Overview => ({ kind: 'loading' }))
  if ((await read($, epics)).kind !== 'ok') await update($, epics, (): Epics => ({ kind: 'loading' }))
  const s = await read($, setup)
  const ready = s.kind === 'ready'
  const loaded = await loadRepo(tracker($, r), {
    me: ready ? s.login : null,
    features: ready ? s.features : { time: true, deps: true, epics: true },
    changes: changesSince(`${r.host}/${slug(r)}`, await $.clock.now()),
  })
  const { issuesError, epicsError } = loaded
  if (issuesError !== null) await update($, overview, (): Overview => ({ kind: 'error', message: issuesError }))
  if (epicsError !== null) await update($, epics, (): Epics => ({ kind: 'error', message: epicsError }))
  known = loaded
  await update($, milestones, () => loaded.milestones)
  await update($, closedMilestones, () => loaded.closedMilestones)
  await showFilter($)
  if (issuesError === null) await showNext($, before)
  if (epicsError === null) await showEpics($)
  // The milestones folded open, and the one in its detail, are asked again;
  // the rest cost nothing.
  await update($, msIssues, () => ({}))
  const asked = await read($, milestonesUnfolded)
  const inDetail = await milestoneShown($)
  for (const title of inDetail === null || asked.includes(inDetail) ? asked : [...asked, inDetail]) await showMilestone($, title)
}

// The open issues of milestone `title`, for the Milestones pane.
async function showMilestone($: EngineInterface, title: string) {
  if (!known) return
  const issues = await known.milestone(title)
  await update($, msIssues, shown => ({ ...shown, [title]: issues }))
  await showTree($)
}

// The children every tree shown needs, as far as it is folded open: the
// Epics pane's, each milestone's folded open, and the one in its detail.
async function showTree($: EngineInterface) {
  if (!known) return
  const ep = await read($, epics)
  const trees: Epic[][] = ep.kind === 'ok' ? [ep.groups.flatMap(g => g.epics)] : []
  const issuesOf = await read($, msIssues)
  const inDetail = await milestoneShown($)
  for (const title of new Set([...(await read($, milestonesUnfolded)), ...(inDetail === null ? [] : [inDetail])])) {
    const issues = issuesOf[title]
    if (issues) trees.push(inMilestone(issues).epics.map(e => ({ number: e.number, title: e.title, state: e.state, due: e.due, children: e.children ?? null })))
  }
  const kids = await known.grow(trees, new Set(await read($, unfolded)))
  await update($, treeKids, () => kids)
}

// Folds milestone `title` open or shut; open the first time, its issues are asked.
async function foldMilestone($: EngineInterface, title: string) {
  const was = await read($, milestonesUnfolded)
  await update($, milestonesUnfolded, () => (was.includes(title) ? was.filter(t => t !== title) : [...was, title]))
  if (!known || was.includes(title) || title in (await read($, msIssues))) return
  await counted($, title, () => showMilestone($, title))
}

// Opens milestone `title` in its detail, or the list again for null. Its
// issues are asked unless a fold already did.
// It opens as its rules say, every time (DRAWING.md, A detail scrolls).
async function openMilestone($: EngineInterface, title: string | null) {
  await go($, MILESTONES_PANE, w => step.openMilestone(w, title))
  await update($, milestoneError, () => null)
  await update($, issuesFolded, () => false)
  await update($, descriptionUnfolded, () => false)
  if (!known || title === null || title in (await read($, msIssues))) return
  await counted($, title, () => showMilestone($, title))
}

// Closes milestone `m`, or opens it again, then shows the list, read again,
// where it moved to Closed or back. A refusal keeps the detail open, shown
// under its actions.
async function closeMilestone($: EngineInterface, m: Milestone, closed: boolean) {
  if (!known) return
  const why = await known.tracker.closeMilestone(m, closed)
  if (why !== null) {
    await update($, milestoneError, () => `Could not ${closed ? 'close' : 'reopen'} ${m.title}: ${why.replace(/\.$/, '')}.`)
    return
  }
  await openMilestone($, null)
  await refresh($)
}

// The milestone filter's options from what is open, and what it is set to:
// the person's choice while it is still offered, else where you work
// (docs/whats-next/ORDERING.md).
async function showFilter($: EngineInterface) {
  if (!known) return
  const options = known.options()
  const wanted = await read($, filterChosen)
  const set = options.find(o => sameFilter(wanted, o.filter))?.filter ?? (await known.startingFilter(options))
  await update($, filterShown, () => ({ options, set }))
}

// What the milestone filter is set to, All until it is loaded.
const filterSet = async ($: EngineInterface): Promise<MilestoneFilter> => (await read($, filterShown))?.set ?? ALL

// What's next within the milestone filter. `before`: what was known before
// a load; without it (the milestone filter switching) nothing left the lists.
async function showNext($: EngineInterface, before: Known | null = null) {
  const k = known
  if (!k) return
  const next = await k.whatsNext(await filterSet($), await $.clock.now())
  await update($, overview, (): Overview => ({ kind: 'ok', ...next }))
  // An issue the pane listed open before the load, and lists open no more
  // (closed, or taken by someone else), closes: What's next shows. One it
  // opened on purpose from elsewhere, the Last closed issue or one reached
  // through Blocked by or Blocks, stays.
  await go($, PANE, w => {
    const n = issueOf(w)
    return n !== null && before !== null && before.listedOpen(n) && !k.listedOpen(n) ? step.closed(w) : w
  })
}

// The epics within the milestone filter, by milestone. What was shown stays
// up while this loads, so the milestone filter does not vanish under the person's hand.
async function showEpics($: EngineInterface) {
  if (!known) return
  const openEpics = known.openEpics.size
  if (openEpics === 0) {
    await update($, epics, (): Epics => ({ kind: 'ok', groups: [], openEpics, held: [] }))
    return
  }
  const shown = await known.epics(await filterSet($))
  await update($, epics, (): Epics => ({ kind: 'ok', ...shown, openEpics }))
  await showTree($)
}

// Folds issue `n` open or shut in Epics; open, the children it now shows
// are asked for, those not asked before.
async function foldIssue($: EngineInterface, n: number) {
  const was = await read($, unfolded)
  await update($, unfolded, () => (was.includes(n) ? was.filter(x => x !== n) : [...was, n]))
  if (!known || was.includes(n)) return
  await counted($, `#${n}`, () => showTree($))
}

// Sets the milestone filter for both panes and closes its list.
async function setFilter($: EngineInterface, filter: MilestoneFilter, label: string) {
  await update($, pickerOpen, () => false)
  await update($, filterChosen, () => filter)
  if (!known) return
  await counted($, label, async () => {
    await showFilter($)
    if ((await read($, overview)).kind === 'ok') await showNext($)
    await showEpics($)
  })
}

// The issues read for a detail view, by repo and number, kept until the next
// Refresh or /next, so opening one again asks Forgejo nothing.
const issuesRead = new Map<string, IssueDetail>()

// Reads issue `n` for the detail view of pane `pane`, or shows it from memory.
async function loadDetail($: EngineInterface, r: Repo, pane: string, n: number) {
  const k = known
  if (!k) return
  const key = `${r.host}/${slug(r)}#${n}`
  const cached = issuesRead.get(key)
  // The issue it is a child of, from what the lists know: one request the
  // first time, none once Next has asked.
  const parentOf = () => k.parent(n)
  // Whether it waits on an open issue that is not its own child, for its mark.
  const blockedOf = (i: IssueDetail) => k.blocked(i, (i.blockedBy ?? []).filter(x => x.state === 'open').map(x => x.number))
  // The issues it holds, for its Children lines: an epic's, or on GitHub
  // any issue's sub-issues.
  const childrenOf = async (): Promise<Ref[] | null> => {
    const all = await k.children(n)
    return all ? all.map(c => ({ number: c.number, title: c.title, state: c.state, assignees: c.assignees, blocked: c.blocked })) : null
  }
  if (cached) {
    const [parent, blocked, children] = await Promise.all([parentOf(), blockedOf(cached), childrenOf()])
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'ok', issue: cached, parent, blocked, children }))
    return
  }
  await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'loading', number: n }))
  try {
    const [issue, parent, children] = await Promise.all([k.issue(n), parentOf(), childrenOf()])
    const blocked = await blockedOf(issue)
    issuesRead.set(key, issue)
    // Another issue opened while this one loaded wins.
    if (issueOf(await placeOf($, pane)) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'ok', issue, parent, blocked, children }))
  } catch (err) {
    if (issueOf(await placeOf($, pane)) !== n) return
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'error', number: n, message: message(err) }))
  }
}

// Opens issue `n` in the detail of pane `pane`, from its list: Back goes to
// the list.
async function openIssue($: EngineInterface, pane: string, n: number) {
  await go($, pane, w => step.open(w, n))
  await loadIssue($, pane, n)
}

// The help page (DRAWING.md, The help page) in pane `pane`, over what it
// shows, at its top; Back returns to that, as it was.
async function showHelp($: EngineInterface, pane: string) {
  if ((await placeOf($, pane)).help) return
  await go($, pane, step.help)
  await update($, pickerOpen, () => false)
}

const leaveHelp = ($: EngineInterface, pane: string) => go($, pane, step.leaveHelp)

// Opens issue `n` in pane `pane`, reached from the one shown through its
// Blocked by or Blocks: Back returns to that one.
async function followIssue($: EngineInterface, pane: string, n: number) {
  await go($, pane, w => step.follow(w, n))
  await loadIssue($, pane, n)
}

// Back: the issue the open one was reached from, else the list.
async function goBack($: EngineInterface, pane: string) {
  await go($, pane, step.back)
  await loadIssue($, pane, issueOf(await placeOf($, pane)))
}

// Loads issue `n` for pane `pane`, which has moved to it; null shows no detail.
async function loadIssue($: EngineInterface, pane: string, n: number | null) {
  const r = await read($, repo)
  if (n === null || !r) {
    await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
    return
  }
  await counted($, `#${n}`, () => loadDetail($, r, pane, n))
}

// Pane `pane` shows its list again: What's next or the epics.
async function backToList($: EngineInterface, pane: string) {
  await go($, pane, step.list)
  await update($, memberOf(detail, { requestId: pane }), (): Detail => ({ kind: 'idle' }))
}

// Checks setup and, once it passes, loads What's next and the epics and,
// where an issue is open, that issue again. The Epics and Milestones panes
// follow what the load found (`followPane`), unless `follow` is off: /next
// opens them itself, in its own order, once What's next is placed.
async function refresh($: EngineInterface, follow = true): Promise<Repo | null> {
  issuesRead.clear()
  const r = await check($)
  if (r && (await read($, setup)).kind === 'ready') {
    const before = await read($, epics)
    const hadMilestones = ((await read($, milestones)) ?? []).length > 0
    await load($, r)
    const after = await read($, epics)
    if (follow && after.kind === 'ok') {
      await followPane($, EPICS_PANE, 'Epics', before.kind === 'ok' && before.openEpics > 0, after.openEpics > 0)
    }
    if (follow) await followPane($, MILESTONES_PANE, 'Milestones', hadMilestones, ((await read($, milestones)) ?? []).length > 0)
    for (const pane of [PANE, EPICS_PANE, MILESTONES_PANE]) {
      const n = issueOf(await placeOf($, pane))
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
  const k = known
  if (!r || !k) return false
  const why = await change(k.tracker)
  if (why !== null) {
    const error = `Could not ${what} #${n}: ${why.replace(/\.$/, '')}.`
    await update($, memberOf(detail, { requestId: pane }), (d): Detail => (d.kind === 'ok' ? { ...d, error } : d))
    return false
  }
  const key = `${r.host}/${slug(r)}#${n}`
  issuesRead.delete(key)
  await backToList($, pane)
  for (const p of [PANE, EPICS_PANE, MILESTONES_PANE]) {
    if (issueOf(await placeOf($, p)) === n) await loadDetail($, r, p, n)
  }
  // The issue as the change left it, read again unless a pane just did, so
  // the lists show the change even where the forge's lists lag it.
  const fresh = issuesRead.get(key) ?? (await k.issue(n).catch(() => null))
  if (fresh) noteChange(`${r.host}/${slug(r)}`, fresh, await $.clock.now())
  await load($, r)
  return true
}

// You on issue `i`, or off it; other assignees stay.
async function assignMe($: EngineInterface, pane: string, i: IssueDetail, on: boolean): Promise<boolean> {
  const me = known?.me
  if (!me) return false
  const others = i.assignees.filter(a => a !== me)
  const assignees = on ? [...others, me] : others
  return writeIssue($, pane, i.number, t => t.assign(i.number, assignees), on ? 'assign' : 'unassign')
}

// What a draft is made from: the issue, and its comments when known.
type DraftSource = Pick<IssueRow, 'number' | 'title' | 'url' | 'body'> & {
  commentList?: Comment[] | null
}

// The prompt What's Next drafts for an issue: what to do, where the issue is, what it
// says, and the last word on it.
function draftFor(i: DraftSource): string {
  const parts = [`Work on #${i.number}: ${i.title}\n${i.url}`]
  const body = i.body.trim()
  if (body) parts.push(body)
  const latest = i.commentList?.at(-1)
  const last = latest?.body.trim()
  if (last) parts.push(`Last comment, by ${latest?.author}:\n${last}`)
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
    const me = known?.me
    if (s.kind === 'ready' && s.actions.kind !== 'read-only' && me && !take.issue.assignees.includes(me)) {
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

// The element that last took the focus ring, by pane id.
const lastFocus = new Map<string, string | undefined>()

// A detail scrolls its own rows, between its top row and its bottom line,
// which stay in place: the wheel and the page keys move them by `e.by`.
const scrollDetail: Hook<'ui.scroll'> = async ($, e, next) => {
  const v = views.get(e.requestId)
  if (!v) return next(e)
  const max = Math.max(0, v.rows - v.room)
  await go($, e.requestId, w => step.scrollTo(w, Math.min(max, Math.max(0, w.scroll + e.by))))
  return {}
}

// Tab and the arrows pass over the hidden hotkeys: on to the first control,
// or, coming back from it, no further. A control out of a detail's view is
// scrolled into it; the last control scrolls the detail to its end, so the
// text after it is reached too, and the first to its top.
const focusMoved: Hook<'ui.focus'> = async ($, e, next) => {
  const h = hidden.get(e.requestId)
  if (e.element !== undefined && h?.keys.has(e.element)) {
    if (lastFocus.get(e.requestId) === h.first) return {}
    lastFocus.set(e.requestId, h.first)
    return next({ ...e, element: h.first })
  }
  lastFocus.set(e.requestId, e.element)
  const v = views.get(e.requestId)
  const row = e.element === undefined ? undefined : v?.at.get(e.element)
  if (v && row !== undefined) {
    const off = (await placeOf($, e.requestId)).scroll
    const rows = [...v.at.values()]
    const to =
      row === Math.max(...rows)
        ? Math.max(0, v.rows - v.room)
        : row === Math.min(...rows)
          ? 0
          : row < off
            ? row
            : row >= off + v.room
              ? row - v.room + 1
              : off
    if (to !== off) await go($, e.requestId, w => step.scrollTo(w, to))
  }
  return next(e)
}

// A pane closing, by What's Next or by the person: the other one, now without a tab,
// names itself in its title row again.
const paneClosed: Hook<'ui.close'> = async ($, e, next) => {
  await update($, panesOpen, ids => ids.filter(id => id !== e.id))
  await go($, e.id, step.dropHelp)
  return next(e)
}

// A change to Icons or Compact in /config, or by What's Next's own choice buttons:
// the session follows it, so the setting wins over an earlier choice.
const settingChanged: Hook<'config.set'> = async ($, e, next) => {
  const done = await next(e)
  const field = settingKey('(icons|compact)').exec(e.key)?.[2]
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

// What's Next's own version and repository, from its manifest, read once by
// the code that runs: a session keeps the version it loaded until
// /reload-plugins, even when the folder on disk has moved on. Each is null
// where the manifest has none or could not be read.
type Built = { version: string | null; repository: string | null }
let ownManifest: Promise<Built> | null = null
function builtManifest($: EngineInterface): Promise<Built> {
  const word = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const from = (path: string) =>
    $.fs.read(path).then(text => {
      const m = JSON.parse(text) as { version?: unknown; repository?: unknown }
      return { version: word(m.version), repository: word(m.repository) }
    })
  // The plugin's folder, or the .claude-plugin folder in it.
  const root = $.plugin.root
  ownManifest ??= from(`${root}/.claude-plugin/plugin.json`)
    .catch(() => from(`${root}/plugin.json`))
    .catch(() => ({ version: null, repository: null }))
  return ownManifest
}

// Every pane draws here: it reads the look once, then picks the view that
// draws what the pane shows (hooks/views).
async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  // A list draws no detail; the detail below sets its own again.
  views.delete(e.requestId)
  hidden.delete(e.requestId)
  const id = e.requestId
  const r = await read($, repo)
  const s = await read($, setup)
  const m = await read($, overview)
  const icons = (await read($, iconsChosen)) ?? configIcons
  const compact = (await read($, compactChosen)) ?? configCompact
  const look: Look = {
    ui: $.ui.resolve(e),
    columns: e.props.bodyColumns,
    compact: compact === 'on',
    icons: icons === 'icons',
    today: await $.clock.now(),
    filter: await read($, filterShown),
    unblocks: m.kind === 'ok' ? m.unblocks : {},
  }
  const built = await builtManifest($)
  const acts: Acts = {
    refresh: () => counted($, 'Refresh', () => refresh($)),
    showHelp: () => showHelp($, id),
    leaveHelp: () => leaveHelp($, id),
    setFilter: (filter, label) => setFilter($, filter, label),
    openIssue: (pane, n) => openIssue($, pane, n),
    followIssue: n => followIssue($, id, n),
    goBack: () => goBack($, id),
    foldIssue: n => foldIssue($, n),
    foldMilestone: title => foldMilestone($, title),
    openMilestone: title => openMilestone($, title),
    closeMilestone: (ms, closed) => closeMilestone($, ms, closed),
    assignMe: (i, on) => assignMe($, id, i, on),
    writeIssue: (n, change, what) => writeIssue($, id, n, change, what),
    workOn: i => workOn($, i, { pane: id, issue: i }),
    openUrl: url => openUrl($, url),
    counted: (label, action) => counted($, label, action),
    chooseIcons: value => chooseIcons($, value),
    chooseCompact: value => chooseCompact($, value),
  }
  const p: Pane = {
    e,
    id,
    place: await placeOf($, id),
    // The pane's full height, so the last rows sit at its bottom.
    height: e.props.scroll.bodyRows,
    look,
    draw: draw(look),
    known,
    // The tracker behind the repo, for its name and where it makes tokens.
    tracker: r ? tracker($, r) : null,
    acts,
    version: built.version,
    repository: built.repository,
    requests: configDebug ? await read($, requests) : null,
  }
  const f = await frame($, p)
  const open = issueOf(p.place)
  if (p.place.help) return helpView(p, f)
  if (s.kind === 'ready' && r && icons === 'ask') return iconsChoice($, p, f)
  if (s.kind === 'ready' && r && compact === 'ask') return compactChoice($, p, f)
  if (s.kind === 'ready' && r && open !== null) return issueView($, p, f, r, open)
  if (id === MILESTONES_PANE && s.kind === 'ready' && r) return milestonesView($, p, f, s, r)
  if (id === EPICS_PANE && s.kind === 'ready' && r) return epicsView($, p, f, r)
  if (s.kind === 'ready' && r && m.kind !== 'idle' && m.kind !== 'error') return nextView(p, f, m, r)
  return setupView($, p, f, configure)
}

// /next opens both panes with What's next in front, and so does /next next
// (n); /next epics (e) puts Epics in front; /next help opens What's next on
// the help page. `name`: the command as registered.
async function runNext($: EngineInterface, name: string, word: string) {
  const lower = word.toLowerCase()
  const want =
    lower === '' || lower === 'next' || lower === 'n' ? 'both' : lower === 'epics' || lower === 'e' ? 'epics' : lower === 'help' ? 'help' : null
  if (!want) {
    return { text: `/${name} does not know "${word}". Try /${name} for What's next in front, /${name} epics (or e) for Epics, or /${name} help.` }
  }
  const openNext = async (title: string) => {
    await $.ui.open({ id: PANE, title })
    await update($, panesOpen, ids => (ids.includes(PANE) ? ids : [...ids, PANE]))
  }
  // The milestone filter starts where you work again: a choice holds until /next.
  await update($, filterChosen, () => null)
  // Epics alone opens nothing until it knows there are epics to show. The
  // load opens no pane of its own: the Epics and Milestones tabs come below,
  // after What's next, so the tabs are in the same order whatever the word.
  if (want !== 'epics') await openNext("What's Next")
  const r = await refresh($, false)
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
  // A pane opened new comes in front of the rest, and only `focus` brings an
  // open one back: What's next last, with the keyboard, as Epics for /next epics.
  if (want !== 'epics') await $.ui.open({ id: PANE, title: r ? "What's next" : "What's Next", focus: true })
  if (want === 'help') {
    await showHelp($, PANE)
    return { text: "What's Next's help is open in What's next: what each sign and colour means." }
  }
  const o = await read($, overview)
  if (s.kind !== 'ready' || !r) return { text: "What's Next needs setting up: see its pane." }
  const shownFilter = await read($, filterShown)
  // The filter's word in a sentence.
  const showing = shownFilter ? filterWord(shownFilter.set) : 'All'
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
  const filter = shownFilter && shownFilter.set.kind !== 'all' ? ` (${showing})` : ''
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
      argumentHint: '[epics | help]',
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
  for (const requestId of [PANE, EPICS_PANE, MILESTONES_PANE]) {
    on('ui.scroll', { requestId }, scrollDetail)
    on('ui.focus', { requestId }, focusMoved)
  }
  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: EPICS_PANE }, renderPane)
  on('ui.render', { component: 'Pane', requestId: MILESTONES_PANE }, renderPane)
}
