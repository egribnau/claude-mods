import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Child, Detail, Epic, Milestone, Mine, Status } from '../types'

type RawIssue = { number: number; title: string; state: string; body: string | null }
type RawMilestone = { id: number; title: string; state: string }
type RawFound = RawIssue & {
  created_at: string
  due_date?: string | null
  milestone?: { id: number } | null
  labels?: { name: string }[] | null
  repository: { full_name: string }
}
type RawPull = { number: number; body: string | null; head: { ref: string } }
type RawDetail = RawIssue & {
  created_at: string
  updated_at: string
  comments: number
  user: { login: string }
  labels: { name: string }[] | null
  milestone: { title: string } | null
  assignees: { login: string }[] | null
}

// What one refresh reads from: the repo's API base and the settings.
type Source = { api: string; slug: string; label: string; heading: string }

const PANE = 'epics'

const milestones = atom({ plugin: 'fj', key: 'milestones' } as const, [])
const selected = atom({ plugin: 'fj', key: 'selected' } as const, null)
const epics = atom({ plugin: 'fj', key: 'epics' } as const, [])
const status = atom({ plugin: 'fj', key: 'status' } as const, { kind: 'idle' })
const expanded = atom({ plugin: 'fj', key: 'expanded' } as const, [])
const mine = atom({ plugin: 'fj', key: 'mine' } as const, [])
const assignedStatus = atom({ plugin: 'fj', key: 'assignedStatus' } as const, {
  kind: 'idle',
})
const picked = atom({ plugin: 'fj', key: 'picked' } as const, null)
const detail = atom({ plugin: 'fj', key: 'detail' } as const, null)
const view = atom({ plugin: 'fj', key: 'view' } as const, 'main')
const listTop = atom({ plugin: 'fj', key: 'listTop' } as const, 0)
const detailStatus = atom({ plugin: 'fj', key: 'detailStatus' } as const, { kind: 'idle' })

// The host, owner and repo a git remote URL names, in any of the forms git
// takes: ssh://git@host:2222/o/r.git, git@host:o/r.git, https://host/o/r.
function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  const m =
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m?.[1] || !m[2] || !m[3]) return null
  return { host: m[1], owner: m[2], repo: m[3] }
}

// The Forgejo repo behind `origin` of the directory the session runs in.
async function source($: EngineInterface, label: string, heading: string): Promise<Source> {
  const run = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  if (run.exitCode !== 0) throw new Error('no git remote "origin" here')
  const url = run.stdout.trim()
  const r = parseRemote(url)
  if (!r) throw new Error(`cannot read a repo from ${url}`)
  return {
    api: `https://${r.host}/api/v1/repos/${r.owner}/${r.repo}`,
    slug: `${r.owner}/${r.repo}`,
    label,
    heading,
  }
}

async function get($: EngineInterface, src: Source, path: string): Promise<unknown> {
  return fetchJson($, `${src.api}${path}`, `${src.slug}${path}`)
}

// Where a request's token would come from, for /fj to say; never the token.
async function tokenSource($: EngineInterface): Promise<string> {
  if (configToken) return 'setting'
  return (await $.env.get('FORGEJO_TOKEN')) ? 'FORGEJO_TOKEN' : 'none'
}

// The settings this plugin declares, by field, in the order the screen shows them.
const FIELDS = ['label', 'childrenHeading', 'login'] as const

// Writes one setting the way /config does; a refusal shows as a toast.
async function saveSetting($: EngineInterface, key: string, value: string) {
  const done = await $.config.set({ key, value })
  if (done.deny !== undefined) $.ui.toast(`Not saved: ${done.deny}`)
}

async function fetchJson(
  $: EngineInterface,
  url: string,
  name: string,
  write?: { method: 'PATCH'; body: unknown },
): Promise<unknown> {
  // The Token setting, else the environment's; an app started from the Dock
  // does not pass a shell's variables on to the sessions it starts.
  const token = configToken ?? (await $.env.get('FORGEJO_TOKEN'))
  if (!token) throw new Error('no token: set it with /plugin configure fj@egribnau-mods, or set FORGEJO_TOKEN')
  const res = await $.http.fetch(url, {
    method: write?.method ?? 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/json',
      ...(write ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(write ? { body: JSON.stringify(write.body) } : {}),
  })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return JSON.parse(res.text)
}

// The token owner's login: the `login` setting, else asked of Forgejo, which
// takes a token with the read:user scope.
async function whoami($: EngineInterface, src: Source): Promise<string> {
  if (me) return me
  const instance = src.api.replace(/\/repos\/[^/]+\/[^/]+$/, '')
  try {
    const user = (await fetchJson($, `${instance}/user`, '/user')) as { login: string }
    me = user.login
    return me
  } catch {
    throw new Error('who you are is unknown: set Login under fj in /config, or give FORGEJO_TOKEN read:user')
  }
}

// Adds the token owner to issue `n`'s assignees, keeping the ones it has.
async function assignMe($: EngineInterface, src: Source, n: number) {
  try {
    const login = await whoami($, src)
    const i = (await get($, src, `/issues/${n}`)) as RawDetail
    const now = (i.assignees ?? []).map(a => a.login)
    if (!now.includes(login)) {
      await fetchJson($, `${src.api}/issues/${n}`, `${src.slug}/issues/${n}`, {
        method: 'PATCH',
        body: { assignees: [...now, login] },
      })
    }
    await Promise.all([pick($, src, n), loadMine($, src)])
  } catch (err) {
    $.ui.toast(`Not assigned: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Selects issue `n` and reads it for the detail at the bottom of the pane.
async function pick($: EngineInterface, src: Source, n: number) {
  await update($, picked, () => n)
  await update($, detailStatus, (): Status => ({ kind: 'loading' }))
  try {
    const i = (await get($, src, `/issues/${n}`)) as RawDetail
    // A second pick while this one was in flight wins.
    if ((await read($, picked)) !== n) return
    await update($, detail, (): Detail => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user.login,
      created: i.created_at.slice(0, 10),
      updated: i.updated_at.slice(0, 10),
      comments: i.comments,
      labels: (i.labels ?? []).map(l => l.name),
      milestone: i.milestone?.title ?? null,
      assignees: (i.assignees ?? []).map(a => a.login),
      body: i.body ?? '',
    }))
    await update($, detailStatus, (): Status => ({ kind: 'idle' }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, detailStatus, (): Status => ({ kind: 'error', message }))
  }
}

// The issue number a branch name carries: `137-x`, `feature/137-x`,
// `issue-137`, `gh_137`. A version such as `release/1.2` carries none.
function issueOfBranch(name: string): number | null {
  const m = /^(?:[\w.-]+\/)*(?:(?:issue|gh)[-_]?)?(\d+)(?:[-_/]|$)/i.exec(name.trim())
  return m?.[1] ? Number(m[1]) : null
}

// The issues an open PR works on: its branch's number, and each one its body
// closes with a keyword Forgejo knows (`Closes #12`, `fixes #3`).
function issuesOfPull(pr: RawPull): number[] {
  const out = new Set<number>()
  const n = issueOfBranch(pr.head.ref)
  if (n !== null) out.add(n)
  for (const m of (pr.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) {
    out.add(Number(m[1]))
  }
  return [...out]
}

// Your open issues split into what you are on, the one to do next, and the
// rest. In progress: the current branch's issue, then the ones an open PR
// works on. The others in order: the milestone `current` first, then the
// earliest due date (none last), then the oldest.
function ranked(list: readonly Mine[], current: number | null) {
  const progress = list
    .filter(i => i.working !== null)
    .sort((a, b) => Number(b.working === 'branch') - Number(a.working === 'branch') || a.number - b.number)
  const rest = list
    .filter(i => i.working === null)
    .sort(
      (a, b) =>
        Number(b.milestone !== null && b.milestone === current) -
          Number(a.milestone !== null && a.milestone === current) ||
        (a.due ?? '￿').localeCompare(b.due ?? '￿') ||
        a.created.localeCompare(b.created),
    )
  return { progress, next: rest[0] ?? null, queue: rest.slice(1) }
}

// The status line: what you are on and what is next.
async function showStatus($: EngineInterface) {
  const r = ranked(await read($, mine), await read($, selected))
  const on = r.progress[0] ? `on #${r.progress[0].number}` : null
  const next = r.next ? `next #${r.next.number}` : null
  const parts = [on, next].filter(Boolean)
  $.ui.status(parts.length > 0 ? `fj ${parts.join(' · ')}` : undefined)
}

// Your open issues in this repo, epics left out, each with what ranks it. The
// search covers every repo the token sees, so it is narrowed here. The branch
// and the PRs only mark issues in progress: when either can't be read, none is.
async function loadMine($: EngineInterface, src: Source) {
  await update($, assignedStatus, (): Status => ({ kind: 'loading' }))
  try {
    const instance = src.api.replace(/\/repos\/[^/]+\/[^/]+$/, '')
    const found: RawFound[] = []
    for (let page = 1; ; page++) {
      const path = `/repos/issues/search?assigned=true&state=open&type=issues&limit=50&page=${page}`
      const raw = (await fetchJson($, `${instance}${path}`, path)) as RawFound[]
      found.push(...raw)
      if (raw.length < 50) break
    }
    const here = found.filter(
      i => i.repository.full_name === src.slug && !(i.labels ?? []).some(l => l.name === src.label),
    )

    const run = await $.process.run(['git', 'branch', '--show-current']).catch(() => null)
    const onBranch = run?.exitCode === 0 ? issueOfBranch(run.stdout) : null
    const byPull = new Map<number, number>()
    try {
      const pulls = (await get($, src, '/pulls?state=open&limit=50')) as RawPull[]
      for (const pr of pulls) for (const n of issuesOfPull(pr)) if (!byPull.has(n)) byPull.set(n, pr.number)
    } catch {
      // No PRs to go on; the branch alone marks work in progress.
    }

    const list: Mine[] = here.map(i => ({
      number: i.number,
      title: i.title,
      milestone: i.milestone?.id ?? null,
      due: i.due_date ? i.due_date.slice(0, 10) : null,
      created: i.created_at,
      working:
        i.number === onBranch ? 'branch' : byPull.has(i.number) ? `PR #${byPull.get(i.number)}` : null,
    }))
    await update($, mine, () => list)
    await update($, assignedStatus, (): Status => ({ kind: 'idle' }))
    await showStatus($)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, assignedStatus, (): Status => ({ kind: 'error', message }))
  }
}

// The issues an epic's checklist under `## <heading>` names: the first `#N` on
// each `- [ ]` or `- [x]` line, up to the next `## ` heading. The box itself is
// not read: it is ticked by hand and lags the issue's own state.
function children(body: string, heading: string): number[] {
  const out: number[] = []
  let inside = false
  for (const line of body.split('\n')) {
    if (/^##\s/.test(line)) {
      inside = line.replace(/^##\s+/, '').trim().toLowerCase() === heading.trim().toLowerCase()
      continue
    }
    const m = inside ? /^\s*[-*]\s+\[[ xX]\]\s+#(\d+)/.exec(line) : null
    if (m?.[1]) out.push(Number(m[1]))
  }
  return out
}

// Every issue's title and state by number, read a page at a time.
async function allIssues($: EngineInterface, src: Source): Promise<Map<number, RawIssue>> {
  const all = new Map<number, RawIssue>()
  for (let page = 1; ; page++) {
    const raw = (await get($, src, `/issues?state=all&type=issues&limit=50&page=${page}`)) as RawIssue[]
    for (const i of raw) all.set(i.number, i)
    if (raw.length < 50) return all
  }
}

// Closed is grayed out, open stands out; a number not found is neither.
function stateColor(state: string) {
  return state === 'closed' ? 'inactive' : state === 'open' ? 'warning' : 'error'
}

// Closed after everything else; otherwise the order given. sort is stable.
function closedLast<T extends { state: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed'))
}

async function fail($: EngineInterface, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  await update($, status, (): Status => ({ kind: 'error', message }))
}

async function loadEpics($: EngineInterface, src: Source, milestone: number) {
  await update($, selected, () => milestone)
  await showStatus($)
  await update($, status, (): Status => ({ kind: 'loading' }))
  try {
    const label = encodeURIComponent(src.label)
    const raw = (await get(
      $,
      src,
      `/issues?state=all&type=issues&labels=${label}&milestones=${milestone}&limit=50`,
    )) as RawIssue[]
    const all = await allIssues($, src)
    const list: Epic[] = raw
      .map(i => ({
        number: i.number,
        title: i.title,
        state: i.state,
        children: children(i.body ?? '', src.heading).map(
          (n): Child => ({
            number: n,
            title: all.get(n)?.title ?? '(not an issue here)',
            state: all.get(n)?.state ?? 'unknown',
          }),
        ),
      }))
      .sort((a, b) => a.number - b.number)
    await update($, epics, () => list)
    await update($, status, (): Status => ({ kind: 'idle' }))
  } catch (err) {
    await fail($, err)
  }
}

// Reads the milestones, then the epics of the one `wanted` names (by title),
// else the one already selected, else the first open one.
async function refresh($: EngineInterface, src: Source, wanted: string) {
  await update($, status, (): Status => ({ kind: 'loading' }))
  try {
    const raw = (await get($, src, '/milestones?state=all&limit=50')) as RawMilestone[]
    const list: Milestone[] = raw.map(m => ({ id: m.id, title: m.title, state: m.state }))
    await update($, milestones, () => list)
    const current = await read($, selected)
    const pick =
      list.find(m => wanted !== '' && m.title === wanted) ??
      list.find(m => m.id === current) ??
      list.find(m => m.state === 'open') ??
      list[0]
    if (!pick) {
      await update($, epics, () => [])
      await update($, status, (): Status => ({ kind: 'error', message: 'no milestones' }))
      return
    }
    await loadEpics($, src, pick.id)
  } catch (err) {
    await fail($, err)
  }
}

// The repo last read, and the settings it is read with. A reload starts the
// module over with `src` unset while the pane stays open on the session's
// state, so the pane's buttons read the repo again through `using`.
let src: Source | null = null
let label = 'epic'
let heading = 'Children'
let me: string | null = null
let configToken: string | null = null

// Runs `fn` on the repo, reading it first when unknown; a failure shows in the
// part of the pane named by `into`.
async function using($: EngineInterface, into: 'list' | 'detail', fn: (s: Source) => Promise<unknown>) {
  try {
    src ??= await source($, label, heading)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (into === 'list') await update($, status, (): Status => ({ kind: 'error', message }))
    else await update($, detailStatus, (): Status => ({ kind: 'error', message }))
    return
  }
  await fn(src)
}

export const register: Register = (on, options) => {
  label = String(options.label ?? 'epic')
  heading = String(options.childrenHeading ?? 'Children')
  me = String(options.login ?? '').trim() || null
  configToken = String(options.token ?? '').trim() || null
  src = null
  // /fj reads the repo again, so a session that changes directory follows it.

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fj',
      description: 'Show your issues (in progress, next, queue) and the epics of a milestone',
      argumentHint: '[milestone]',
    })

    return next(e)
  })

  on('command.run', { command: 'fj' }, async ($, e) => {
    const wanted = e.args.trim()
    try {
      src = await source($, label, heading)
    } catch (err) {
      src = null
      await $.ui.open({ id: PANE, title: 'Epics' })
      await update($, milestones, () => [])
      await update($, epics, () => [])
      await update($, mine, () => [])
      await fail($, err)
      await update($, assignedStatus, (): Status => ({ kind: 'idle' }))
      return { text: 'Epics pane opened.' }
    }
    await $.ui.open({ id: PANE, title: `Epics · ${src.slug}` })
    await Promise.all([refresh($, src, wanted), loadMine($, src)])

    const from = `(token: ${await tokenSource($)})`
    return { text: wanted ? `Epics of ${wanted} ${from}.` : `Epics pane opened ${from}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    // The mobile app draws no Input: there the settings show without fields.
    const Input = 'Input' in ui ? ui.Input : null
    // The mobile app draws no Select.
    const Select = 'Select' in ui ? ui.Select : null
    const ms = await read($, milestones)
    const sel = await read($, selected)
    const list = await read($, epics)
    const st = await read($, status)
    const open = await read($, expanded)
    const mineList = await read($, mine)
    const mineSt = await read($, assignedStatus)
    const current = await read($, picked)
    const shown = await read($, detail)
    const shownSt = await read($, detailStatus)
    const top = await read($, listTop)
    const shows = await read($, view)

    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    // Every part has a fixed height and every line is one row, so the three
    // always add up to the pane and nothing is pushed out of it.
    // Your issues: in progress, then next, then the queue, as many as a
    // quarter of the pane holds, the last row saying how many more there are.
    const r = ranked(mineList, sel)
    const mineRows = [
      ...r.progress.map(i => ({ i, mark: '⎇', color: 'success', bold: false })),
      ...(r.next ? [{ i: r.next, mark: '▸', color: 'warning', bold: true }] : []),
      ...r.queue.map(i => ({ i, mark: ' ', color: 'text', bold: false })),
    ]
    const mineRoom = Math.max(2, Math.floor(rows * 0.25))
    const shownMine = mineRows.length <= mineRoom ? mineRows : mineRows.slice(0, mineRoom - 1)
    const moreMine = mineRows.length - shownMine.length
    const topRows =
      1 + (mineSt.kind === 'idle' ? Math.max(1, Math.min(mineRows.length, mineRoom)) : 1)
    const detailRows = Math.max(6, Math.floor(rows * 0.4))
    const middleRows = Math.max(4, rows - topRows - detailRows)
    const listRoom = middleRows - 2

    const fit = (text: string, width: number) =>
      text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
    const line = (text: string, props: Record<string, unknown> = {}) => (
      <Text wrap="truncate-end" {...props}>
        {fit(text, columns)}
      </Text>
    )
    const rule = (name: string) => line(`── ${name} `.padEnd(columns, '─'), { dimColor: true })
    const toggle = (n: number) =>
      update($, expanded, list => (list.includes(n) ? list.filter(x => x !== n) : [...list, n]))
    const choose = (n: number) => using($, 'detail', s => pick($, s, n))
    // One issue as a one-row button that selects it: the title cut to what fits
    // in front of `#number`, coloured by state.
    const issueRow = (
      key: string,
      n: number,
      title: string,
      state: string,
      lead: number,
      color?: string,
      bold?: boolean,
    ) => (
      <Button key={key} plain onPress={() => choose(n)}>
        <Text wrap="truncate-end" color={color ?? stateColor(state)} bold={bold} inverse={current === n}>
          {fit(title, columns - lead - ` #${n}`.length)} #{n}
        </Text>
      </Button>
    )

    // The milestone's lines, one row each: an epic, then its children if open.
    type Line = { pick: number | null; el: RenderChildren }
    const lines: Line[] = []
    for (const epic of closedLast(list)) {
      const isOpen = open.includes(epic.number)
      const done = epic.children.filter(c => c.state === 'closed').length
      lines.push({
        pick: epic.number,
        el: (
          <Box key={`epic-${epic.number}`}>
            <Button key={`toggle-${epic.number}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(epic.number)} />
            <Text> </Text>
            {issueRow(
              `pick-${epic.number}`,
              epic.number,
              `${epic.title} (${done}/${epic.children.length})`,
              epic.state,
              2,
            )}
          </Box>
        ),
      })
      if (isOpen && epic.children.length === 0) {
        lines.push({ pick: null, el: line('    No children.', { dimColor: true }) })
      }
      if (isOpen) {
        for (const child of closedLast(epic.children)) {
          lines.push({
            pick: child.number,
            el: (
              <Box key={`child-${epic.number}-${child.number}`}>
                <Text>{'    '}</Text>
                {issueRow(`pick-${epic.number}-${child.number}`, child.number, child.title, child.state, 4)}
              </Box>
            ),
          })
        }
      }
    }
    // Show as many as fit, from the line scrolled to; the last row is then the
    // scroll controls.
    const room = lines.length > listRoom ? listRoom - 1 : listRoom
    const last = Math.max(0, lines.length - room)
    const first = Math.min(Math.max(0, top), last)
    const visible = lines.slice(first, first + room)
    const below = lines.length - first - visible.length
    const step = Math.max(1, Math.floor(room / 2))
    const scroll = (by: number) => update($, listTop, t => Math.min(Math.max(0, Math.min(t, last) + by), last))

    if (shows === 'settings') {
      // What this session offers of fj's settings: /config's rows, which hold
      // every setting but the secret Token. Desktop and terminal may differ.
      const all = await $.config.list()
      const mine = all.filter(r => /^fj(@[^.]*)?\./.test(r.key))
      const from = await tokenSource($)
      return (
        <Box flexDirection="column" height={rows} overflow="hidden">
          {rule('Settings')}
          {line(`Repo: ${src?.slug ?? 'read on the next /fj or Refresh'}`, { dimColor: true })}
          {line(`This session lists ${mine.length} of fj's settings.`, { dimColor: true })}
          {FIELDS.map(field => {
            const row = mine.find(r => r.key.endsWith(`.${field}`))
            if (row && !Input) return line(`${row.label}: ${String(row.value)}`)
            return row && Input ? (
              <Input
                key={`cfg-${field}`}
                label={row.label}
                value={String(row.value)}
                submitLabel="Save"
                onSubmit={(value: string) => saveSetting($, row.key, value.trim())}
              />
            ) : (
              line(`${field}: not offered to this session`, { dimColor: true })
            )
          })}
          {line(`Token: ${from === 'none' ? 'none found' : `from ${from === 'setting' ? 'the Token setting' : 'FORGEJO_TOKEN'}`}`)}
          {line('The Token is secret: set it with /plugin configure fj@egribnau-mods.', { dimColor: true })}
          <Box height={1}>
            <Button key="back" label="Back" hotkey="b" onPress={() => update($, view, () => 'main' as const)} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <Box flexDirection="column" height={topRows} flexShrink={0} overflow="hidden">
          {rule('Assigned to you')}
          {mineSt.kind === 'loading' && line('Loading…', { dimColor: true })}
          {mineSt.kind === 'error' && line(mineSt.message, { color: 'red' })}
          {mineSt.kind === 'idle' && mineRows.length === 0 && line('Nothing assigned to you.', { dimColor: true })}
          {mineSt.kind === 'idle' &&
            shownMine.map(({ i, mark, color, bold }) => (
              <Box key={`mine-row-${i.number}`}>
                <Text color={color}>{mark} </Text>
                {issueRow(`mine-${i.number}`, i.number, i.title, 'open', 2, color, bold)}
              </Box>
            ))}
          {mineSt.kind === 'idle' && moreMine > 0 && line(`  +${moreMine} more`, { dimColor: true })}
        </Box>

        <Box flexDirection="column" height={middleRows} flexShrink={0} overflow="hidden">
          {rule('Milestone')}
          <Box height={1}>
            {Select && ms.length > 0 && (
              <Select
                key="milestone"
                label="Milestone"
                value={sel === null ? undefined : String(sel)}
                options={ms.map(m => ({
                  value: String(m.id),
                  label: m.state === 'open' ? m.title : `${m.title} (closed)`,
                }))}
                onSelect={(value: string) => using($, 'list', s => loadEpics($, s, Number(value)))}
              />
            )}
            <Text> </Text>
            <Button
              key="refresh"
              label="Refresh"
              hotkey="r"
              onPress={() =>
                using($, 'list', s => Promise.all([refresh($, s, ''), loadMine($, s)]))
              }
            />
            <Text> </Text>
            <Button
              key="settings"
              label="Settings"
              hotkey="s"
              onPress={() => update($, view, () => 'settings' as const)}
            />
          </Box>
          {st.kind === 'loading' && line('Loading…', { dimColor: true })}
          {st.kind === 'error' && line(st.message, { color: 'red' })}
          {st.kind === 'idle' && list.length === 0 && line('No epics.', { dimColor: true })}
          {st.kind === 'idle' && visible.map(l => l.el)}
          {st.kind === 'idle' && room < lines.length && (
            <Box height={1}>
              <Button key="up" plain label="↑" hotkey="k" onPress={() => scroll(-step)} />
              <Text> </Text>
              <Button key="down" plain label="↓" hotkey="j" onPress={() => scroll(step)} />
              <Text dimColor>{` ${first} above · ${below} below`}</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" height={detailRows} flexShrink={0} overflow="hidden">
          {rule('Detail')}
          {current === null && line('Select an issue above.', { dimColor: true })}
          {current !== null && shownSt.kind === 'loading' && line(`Loading #${current}…`, { dimColor: true })}
          {current !== null && shownSt.kind === 'error' && line(shownSt.message, { color: 'red' })}
          {current !== null && shownSt.kind === 'idle' && shown && (
            <Box flexDirection="column">
              {line(`${shown.title} #${shown.number}`, { bold: true, color: stateColor(shown.state) })}
              {line([shown.state, shown.milestone ?? 'no milestone', ...shown.labels].join(' · '), { dimColor: true })}
              {line(
                `opened by ${shown.author} ${shown.created} · updated ${shown.updated} · ${shown.comments} comments` +
                  (shown.assignees.length > 0 ? ` · assigned to ${shown.assignees.join(', ')}` : ''),
                { dimColor: true },
              )}
              <Box height={1}>
                {me !== null && shown.assignees.includes(me) ? (
                  <Text dimColor>Assigned to you.</Text>
                ) : (
                  <Button
                    key="assign"
                    label="Assign to me"
                    hotkey="a"
                    onPress={() => using($, 'detail', s => assignMe($, s, shown.number))}
                  />
                )}
              </Box>
              {shown.body.trim() !== '' && (
                <Box height={Math.max(1, detailRows - 5)} overflow="hidden">
                  <Markdown text={shown.body.split('\n').slice(0, Math.max(1, detailRows - 5)).join('\n')} />
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
