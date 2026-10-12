import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { dueFirst } from '../hooks/epics'

const MILESTONES_PANE = {
  plugin: 'whats-next',
  component: 'Pane',
  requestId: 'next-milestones',
  props: {
    title: 'Milestones',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const RUN = {
  command: 'next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const TOKEN = { options: { token: 'secret', icons: 'text', compact: 'off' } }
const NOW = Date.parse('2026-10-09T12:00:00Z')

type World = {
  milestones?: unknown[]
  // The closed milestones, as Forgejo lists them.
  closedMilestones?: unknown[]
  // The repo's open issues, and each issue's dependencies, as Forgejo lists them.
  issues?: unknown[]
  // The issues with the Epic label.
  epics?: unknown[]
  deps?: Record<number, unknown[]>
  // Whether the list of open issues answers 500.
  failIssues?: boolean
  // The commands run, each joined by spaces.
  ran?: string[]
  // Whether the token may write: write:issue and push rights.
  write?: boolean
  // The changes sent; with `refuse`, Forgejo refuses each with that message.
  sent?: { path: string; body: unknown }[]
  refuse?: { status: number; message: string }
}
type Opened = { id: string; title?: string; focus?: true }

// A Forgejo repo that passes setup, has no open issues and no epics, and
// answers `w`'s open milestones.
function world(on: On, w: World, asked: string[] = [], opened: Opened[] = [], closed: string[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    w.ran?.push(cmd)
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, title: e.title, ...(e.focus ? { focus: true as const } : {}) })
    return { value: { isPlaced: true } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const url = new URL(e.url)
    const page = Number(url.searchParams.get('page') ?? '1') - 1
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) },
    })
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5+gitea-1.22.0' })
    if (url.pathname.endsWith('/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/users/alice/tokens')) {
      return reply(200, [{ token_last_eight: 'secret', scopes: w.write ? ['write:issue'] : ['read:issue'] }])
    }
    if (e.init?.method === 'PATCH') {
      const body = JSON.parse(String(e.init.body ?? '{}')) as { state?: string }
      w.sent?.push({ path: url.pathname, body })
      if (w.refuse) return reply(w.refuse.status, { message: w.refuse.message })
      // The milestone moves to the other list, as Forgejo now holds it.
      const id = Number(/\/milestones\/(\d+)$/.exec(url.pathname)?.[1])
      const all = [...(w.milestones ?? []), ...(w.closedMilestones ?? [])] as { id: number; state: string }[]
      const m = all.find(x => x.id === id)
      if (!m) return reply(404, { message: 'not found' })
      const now = { ...m, state: body.state, closed_at: body.state === 'closed' ? '2026-10-09T12:00:00Z' : null }
      const others = (list?: unknown[]) => (list ?? []).filter(x => (x as { id: number }).id !== id)
      w.milestones = body.state === 'closed' ? others(w.milestones) : [...others(w.milestones), now]
      w.closedMilestones = body.state === 'closed' ? [now, ...others(w.closedMilestones)] : others(w.closedMilestones)
      return reply(200, now)
    }
    const mine = (w.issues ?? []).filter(i => (i as { assignees: { login: string }[] }).assignees.some(a => a.login === 'alice'))
    if (url.pathname.endsWith('/repos/issues/search')) return reply(200, page === 0 ? mine : [])
    if (url.pathname.endsWith('/repos/boats/radar/issues')) {
      if (url.searchParams.get('labels')) return reply(200, page === 0 ? (w.epics ?? []) : [])
      if (w.failIssues) return reply(500, { message: 'boom' })
      return reply(200, page === 0 ? (w.issues ?? []) : [])
    }
    const dep = /\/issues\/(\d+)\/dependencies$/.exec(url.pathname)
    if (dep) return reply(200, w.deps?.[Number(dep[1])] ?? [])
    const one = /\/repos\/boats\/radar\/issues\/(\d+)$/.exec(url.pathname)
    if (one) {
      const n = Number(one[1])
      return reply(200, { ...issue(n, `Issue ${n}`), user: { login: 'alice' }, updated_at: '2026-09-01T09:00:00Z', comments: 0 })
    }
    if (url.pathname.endsWith('/repos/boats/radar/milestones')) {
      const shown = url.searchParams.get('state') === 'closed' ? w.closedMilestones : w.milestones
      return reply(200, page === 0 ? (shown ?? []) : [])
    }
    if (url.pathname.endsWith('/repos/boats/radar')) {
      return reply(200, { full_name: 'boats/radar', open_issues_count: 9, permissions: { push: w.write === true } })
    }
    return reply(404, { message: 'not found' })
  })
  return clock
}

type Extra = { milestone?: string; assignees?: string[]; labels?: string[]; state?: 'open' | 'closed' }

function issue(number: number, title: string, extra: Extra = {}) {
  return {
    number,
    title,
    state: extra.state ?? 'open',
    created_at: '2026-10-08T09:00:00Z',
    html_url: `https://git.example.org/boats/radar/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name })),
    assignees: (extra.assignees ?? []).map(login => ({ login })),
    repository: { full_name: 'boats/radar' },
  }
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
type Found = { key: string; text: string; props: Record<string, unknown> }
const nodes = async (ui: Ui) => (await ui.findAll({ type: 'Text' })) as unknown as Found[]

type Btn = { key: string }
const rowKeys = async (ui: Ui) =>
  ((await ui.findAll({ type: 'Button' })) as unknown as Btn[]).map(b => b.key).filter(k => k.startsWith('milestone-'))

// On Issue detail, reached from a row: Back is ← alone, and goes to Milestones.
type Pane = Ui & { find: (q: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined>; press: (q: { key: string }) => Promise<unknown> }
const backToMilestones = async (pane: Pane) => {
  expect(await rowKeys(pane)).toEqual([])
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('←')
  await pane.press({ key: 'back' })
  expect((await rowKeys(pane)).length).toBeGreaterThan(0)
}

const milestone = (title: string, due: string | null, open: number, closed: number, id = 1, description = '') => ({
  id,
  title,
  description,
  due_on: due,
  open_issues: open,
  closed_issues: closed,
  state: 'open',
})

// GitHub is due in 4 days, Jira later, Panes has no due date, v0.3.0 is late.
const REPO: World = {
  milestones: [
    milestone('Panes', null, 3, 1, 4),
    milestone('Jira', '2026-11-30T00:00:00Z', 6, 0, 3),
    milestone('GitHub', '2026-10-13T00:00:00Z', 8, 9, 2, 'GitHub as a third forge.\n\nDone when /next works on GitHub.'),
    milestone('v0.3.0', '2026-10-01T00:00:00Z', 3, 12, 1),
  ],
}

test('dueFirst puts the soonest due first and those without a due date last', () => {
  const rows = [
    { title: 'b', due: null, closed: 0, total: 0 },
    { title: 'c', due: '2026-11-01T00:00:00Z', closed: 0, total: 0 },
    { title: 'a', due: '2026-10-01T00:00:00Z', closed: 0, total: 0 },
  ]
  expect(dueFirst(rows).map(m => m.title)).toEqual(['a', 'c', 'b'])
})

test("the Milestones pane opens as a tab when the repo has an open milestone", TOKEN, async ($, on) => {
  const opened: Opened[] = []
  world(on, REPO, [], opened)
  await $.command.run(RUN)
  expect(opened.filter(p => p.id === 'next-milestones')).toEqual([{ id: 'next-milestones', title: 'Milestones' }])
})

test('without an open milestone there is no Milestones pane', TOKEN, async ($, on) => {
  const opened: Opened[] = []
  world(on, { milestones: [] }, [], opened)
  await $.command.run(RUN)
  expect(opened.some(p => p.id === 'next-milestones')).toBe(false)
})

test('once the last milestone is closed, /next closes the Milestones pane', TOKEN, async ($, on) => {
  const w: World = { ...REPO }
  const closed: string[] = []
  world(on, w, [], [], closed)
  await $.command.run(RUN)
  w.milestones = []
  await $.command.run(RUN)
  expect(closed).toContain('next-milestones')
})

test('Refresh opens the Milestones pane once the first milestone is there', TOKEN, async ($, on) => {
  const w: World = { milestones: [] }
  const opened: Opened[] = []
  world(on, w, [], opened)
  await $.command.run(RUN)
  w.milestones = REPO.milestones
  const next = await $.ui.mount({ ...MILESTONES_PANE, requestId: 'next', surface: 'terminal' })
  await next.press({ key: 'refresh' })
  expect(opened.filter(p => p.id === 'next-milestones')).toEqual([{ id: 'next-milestones', title: 'Milestones' }])
})

test('each open milestone is a folded row, soonest due first, those without a due date last', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  expect(await rowKeys(pane)).toEqual(['milestone-v0.3.0', 'milestone-GitHub', 'milestone-Jira', 'milestone-Panes'])
  expect(t).toContain('⧗ 13 Oct')
  expect(t).toContain('⧗ 30 Nov')
  // How many are open is read from the count; no due date shows nothing.
  expect(t).toContain('  ⧗ 13 Oct')
  expect(t.some(x => /^ {2}.*(\d+ open|due)/.test(x))).toBe(false)
  // Panes has no due date and nothing known for you: no line under it.
  const panes = t.indexOf(`${'Panes'.padEnd(33)} ▰▰▱▱▱▱▱▱   1/4`)
  expect(t[panes + 5]).toBe('─'.repeat(50))
})

test('a milestone row has the bar and closed/total from its own counts', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  // GitHub: 9 of 17 closed, so 4 of 8 cells.
  const i = t.indexOf(`${'GitHub'.padEnd(33)} ▰▰▰▰▱▱▱▱  9/17`)
  expect(t[i - 1]).toBe('⊕ ')
  expect(t.slice(i + 1, i + 5)).toEqual([`${'GitHub'.padEnd(33)} `, '▰▰▰▰', '▱▱▱▱', '  9/17'])
})

test('one line under a milestone, cut at its end: its due date, then what there is for you', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '  ⧗ 13 Oct · ● 1 · ○ 1 · ◌ 1 · ⊘ 1')?.props.wrap).toBe('truncate-end')
})

test('folded, line 2 shows only what is known: yours from the lists, the rest not until every issue not yours is checked', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const before = asked.length
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  // GitHub: What's next checked #33 and #40, not jdoe's #36, so only yours.
  expect(t).toContain('  ⧗ 13 Oct · ● 1')
  expect(t.some(x => /[○◌⊘] \d/.test(x))).toBe(false)
  // Jira: jdoe's #50 alone, never checked: its due date alone.
  expect(t).toContain('  ⧗ 30 Nov')
  expect(t.filter(x => /^ {2}⧗ .* · /.test(x))).toEqual(['  ⧗ 13 Oct · ● 1'])
  expect(asked.length).toBe(before)
})

test('folded, line 2 is whole once What\'s next has checked every issue not yours, and nothing more is asked', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, { ...WORK, issues: (WORK.issues ?? []).filter(i => (i as { number: number }).number !== 36) }, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const before = asked.length
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect(await texts(pane)).toContain('  ⧗ 13 Oct · ● 1 · ○ 1 · ⊘ 1')
  expect(asked.length).toBe(before)
})

test('folded, a milestone whose issues could not be listed says so on its line, after its due date', TOKEN, async ($, on) => {
  const clock = world(on, { ...WORK, failIssues: true })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  expect(t).toContain('  ⧗ 13 Oct · issues unknown')
  expect(t).toContain('  issues unknown')
})

test('a due date is red once passed and amber within 7 days', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '⧗ 1 Oct')?.props.color).toBe('error')
  expect(n.find(x => x.text === '⧗ 13 Oct')?.props.color).toBe('warning')
  expect(n.find(x => x.text === '⧗ 30 Nov')?.props.dimColor).toBe(true)
})

test('the fold mark folds a milestone open and shut', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(await texts(pane)).toContain('  ✓ 9 closed')
  expect(await texts(pane)).toContain('⊖ ')
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(await texts(pane)).not.toContain('  ✓ 9 closed')
})

test('the bottom line counts the open milestones and their open issues', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect(await texts(pane)).toContain('4 milestones · 20 open')
})

test('the Milestones pane has Refresh and no milestone picker', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await expect(pane.find({ key: 'refresh' })).resolves.toBeDefined()
  await expect(pane.find({ key: 'milestone' })).resolves.toBeUndefined()
  await pane.press({ key: 'menu' })
  await expect(pane.find({ key: 'menu-refresh' })).resolves.toBeDefined()
})

test('the Milestones pane asks the forge nothing of its own', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, REPO, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const before = asked.length
  await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect(asked.length).toBe(before)
})

// GitHub's open issues: #30 yours, #33 free, #36 jdoe's, #40 blocked by #33.
// Jira holds #50, jdoe's.
const WORK: World = {
  ...REPO,
  issues: [
    issue(30, 'GitHub token setting', { milestone: 'GitHub', assignees: ['alice'] }),
    issue(33, 'Detect GitHub from the remote', { milestone: 'GitHub' }),
    issue(36, 'GitHub rate limits', { milestone: 'GitHub', assignees: ['jdoe'] }),
    issue(40, 'Blocked by on GitHub', { milestone: 'GitHub' }),
    issue(50, 'Jira login', { milestone: 'Jira', assignees: ['jdoe'] }),
  ],
  deps: { 40: [issue(33, 'Detect GitHub from the remote')] },
}

const DEPS = (asked: string[]) => asked.filter(u => u.endsWith('/dependencies'))

test('unfolded, a milestone lists its open issues as epic children are, then how many are closed', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const t = await texts(pane)
  const rows = t.filter(x => /^ {2}[●○◌⊘] #\d/.test(x))
  expect(rows.map(x => x.slice(2, 6))).toEqual(['● #3', '○ #3', '◌ #3', '⊘ #4'])
  expect(t).toContain('jdoe')
  expect(t.some(x => x.startsWith('⊘ 1 · '))).toBe(true)
  expect(t).toContain('  ✓ 9 closed')
  // The milestone is left out of the facts under each row.
  expect(t).not.toContain('GitHub')
})

test('once unfolded, line 2 under a milestone says all there is for you', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect(await texts(pane)).not.toContain('  ⧗ 13 Oct · ● 1 · ○ 1 · ◌ 1 · ⊘ 1')
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const t = await texts(pane)
  const at = t.indexOf('  ⧗ 13 Oct · ● 1 · ○ 1 · ◌ 1 · ⊘ 1')
  expect(t.slice(at + 1, at + 10)).toEqual(['⧗ 13 Oct', ' · ', '● 1', ' · ', '○ 1', ' · ', '◌ 1', ' · ', '⊘ 1'])
})

test('a row opens Issue detail, and Back returns to Milestones', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-issue-33' })
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('←')
  expect(await rowKeys(pane)).toEqual([])
  await pane.press({ key: 'back' })
  await expect(pane.find({ key: 'ms-issue-33' })).resolves.toBeDefined()
})

test("a milestone's issues are checked for blockers once, when it is first unfolded", TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  // Folded, jdoe's issues are asked nothing.
  expect(DEPS(asked).some(u => /\/issues\/(36|50)\//.test(u))).toBe(false)
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(1)
  const before = asked.length
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(asked.length).toBe(before)
  expect(DEPS(asked).some(u => u.includes('/issues/50/'))).toBe(false)
})

test('folds hold over Refresh, which asks again only for unfolded milestones', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'refresh' })
  expect(await texts(pane)).toContain('  ✓ 9 closed')
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(2)
  expect(DEPS(asked).some(u => u.includes('/issues/50/'))).toBe(false)
})

test("when the open issues could not be listed, an unfolded milestone's issues are unknown", TOKEN, async ($, on) => {
  const clock = world(on, { ...WORK, failIssues: true })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '  issues unknown')?.props.dimColor).toBe(true)
})

// GitHub support (#29) is an epic in GitHub: its children #30, #33 and #36
// are open there, #31 is closed. On Forgejo they are its dependencies.
const GITHUB_EPIC = issue(29, 'GitHub support', { milestone: 'GitHub', labels: ['epic'] })
const EPIC_WORK: World = {
  ...WORK,
  issues: [GITHUB_EPIC, ...(WORK.issues ?? [])],
  epics: [GITHUB_EPIC],
  deps: {
    ...WORK.deps,
    29: [
      issue(30, 'GitHub token setting', { milestone: 'GitHub', assignees: ['alice'] }),
      issue(33, 'Detect GitHub from the remote', { milestone: 'GitHub' }),
      issue(36, 'GitHub rate limits', { milestone: 'GitHub', assignees: ['jdoe'] }),
      issue(31, 'GitHub detail', { milestone: 'GitHub', state: 'closed' }),
    ],
  },
}

test('epics in a milestone come first, folded, with their bar and what there is for you in them; their children only under them', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const t = await texts(pane)
  const at29 = t.indexOf(`#29 ${'GitHub support'.padEnd(27)} ▰▰▱▱▱▱▱▱   1/4`)
  expect(at29).toBeGreaterThan(-1)
  expect(t[at29 - 1]).toBe('⊕ ')
  // #30, #33 and #36 are #29's: not in the list of the milestone's issues.
  expect(t.filter(x => /^ {2}[●○◌⊘] #\d/.test(x)).map(x => x.slice(2, 7))).toEqual(['⊘ #40'])
  const at = t.indexOf('▱▱▱▱▱▱')
  expect(t.slice(at + 1, at + 8)).toEqual(['   1/4', '        ● 1 · ○ 1 · ◌ 1', '● 1', ' · ', '○ 1', ' · ', '◌ 1'])
})

test('an epic in a milestone unfolds on its tree, its mark first so Tab stops on it', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const keys = ((await pane.findAll({ type: 'Button' })) as unknown as Btn[]).map(b => b.key)
  expect(keys.indexOf('fold-29')).toBeLessThan(keys.indexOf('ms-issue-29'))
  await pane.press({ key: 'fold-29' })
  const t = await texts(pane)
  expect(t.filter(x => /^ +[●○◌⊘] #\d/.test(x) || x.includes('✓')).map(x => x.trimEnd())).toEqual([
    '    ● #30 GitHub token setting',
    '    ○ #33 Detect GitHub from the remote',
    `    ◌ #36 ${'GitHub rate limits'.padEnd(35)} jdoe`,
    '    ✓ 1 closed',
    '  ⊘ #40 Blocked by on GitHub',
    '  ✓ 9 closed',
  ])
  expect(t.some(x => x.startsWith('        ● 1'))).toBe(false)
  await pane.press({ key: 'ms-issue-30' })
  await backToMilestones(pane)
})

test('what is unfolded is shared with Epics, and holds over Refresh and Back', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const epics = await $.ui.mount({ ...MILESTONES_PANE, requestId: 'next-epics', surface: 'terminal' })
  await epics.press({ key: 'fold-29' })
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const shown = async () => (await texts(pane)).some(x => x.includes('#30 GitHub token setting'))
  expect(await shown()).toBe(true)
  await pane.press({ key: 'refresh' })
  expect(await shown()).toBe(true)
  await pane.press({ key: 'ms-issue-30' })
  await pane.press({ key: 'back' })
  expect(await shown()).toBe(true)
  await pane.press({ key: 'fold-29' })
  expect(await shown()).toBe(false)
})

test('on Forgejo an epic another epic in the milestone depends on is no child: both at the top', TOKEN, async ($, on) => {
  const SUB = issue(41, 'GitHub Enterprise', { milestone: 'GitHub', labels: ['epic'] })
  const clock = world(on, {
    ...EPIC_WORK,
    issues: [SUB, ...(EPIC_WORK.issues ?? [])],
    epics: [GITHUB_EPIC, SUB],
    deps: { ...EPIC_WORK.deps, 29: [...(EPIC_WORK.deps?.[29] ?? []), SUB], 41: [issue(42, 'GHES version header', { milestone: 'GitHub' })] },
  })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const keys = async () => ((await pane.findAll({ type: 'Button' })) as unknown as Btn[]).map(b => b.key)
  expect(await keys()).toContain('fold-41')
  await pane.press({ key: 'fold-29' })
  // Under #29 only its three issues; #41 stays at the top.
  expect((await keys()).filter(k => k === 'fold-41' || k.startsWith('fold-41@'))).toEqual(['fold-41'])
  expect((await texts(pane)).some(x => x.startsWith('    ') && x.includes('#41'))).toBe(false)
})

test("the line under an epic in a milestone is one line, cut at its end", TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '        ● 1 · ○ 1 · ◌ 1')?.props.wrap).toBe('truncate-end')
})

test("an epic is not blocked by its own children, and opens its detail", TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('  ⊘ #29'))).toBe(false)
  await pane.press({ key: 'ms-issue-29' })
  await backToMilestones(pane)
})

test("an epic's children are asked once, for Milestones and Epics both", TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, EPIC_WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  // The load asked for them already, for Epics, which starts on GitHub.
  const before = asked.filter(u => u.endsWith('/issues/29/dependencies')).length
  expect(before).toBeGreaterThan(0)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(asked.filter(u => u.endsWith('/issues/29/dependencies'))).toHaveLength(before)
})

test('epics are left out of what there is for you in a milestone', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  // #29 would be one more available.
  expect(await texts(pane)).toContain('  ⧗ 13 Oct · ● 1 · ○ 1 · ◌ 1 · ⊘ 1')
})

const shut = (title: string, at: string, open: number, closed: number, id = 9) => ({ ...milestone(title, null, open, closed, id), state: 'closed', closed_at: at })

// Four closed milestones; GitLab, closed last, holds the closed epic #12 and
// one issue still open, #44.
const CLOSED: World = {
  ...REPO,
  closedMilestones: [
    shut('Forgejo dependencies', '2026-10-02T10:00:00Z', 0, 6),
    shut('GitLab', '2026-10-09T10:00:00Z', 1, 11),
    shut('Old', '2026-09-01T10:00:00Z', 0, 2),
    shut("Rename to What's Next", '2026-10-08T10:00:00Z', 0, 3),
  ],
  issues: [issue(44, 'GitLab leftovers', { milestone: 'GitLab' })],
  epics: [issue(12, 'GitLab support', { milestone: 'GitLab', labels: ['epic'], state: 'closed' })],
}

test('a Closed rule after the open milestones, folded, with how many', TOKEN, async ($, on) => {
  const clock = world(on, CLOSED)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  expect(t.some(x => x.startsWith('+ Closed · 3 ─'))).toBe(true)
  expect(await rowKeys(pane)).not.toContain('milestone-GitLab')
})

for (const compact of ['on', 'off'] as const) {
  test(`one empty line before the Closed rule, with Compact ${compact}`, { options: { token: 'secret', icons: 'text', compact } }, async ($, on) => {
    const clock = world(on, CLOSED)
    await clock.set(NOW)
    await $.command.run(RUN)
    const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
    const boxes = (await pane.findAll({ type: 'Box' })) as unknown as { key?: string; props: Record<string, unknown> }[]
    // Without Compact the last milestone's row leaves the empty line; with it, a line of its own.
    expect(boxes.some(b => b.key === 'end-closed' && b.props.height === 1)).toBe(compact === 'on')
  })
}

test('unfolded, Closed lists the last three closed, newest first, each a grey row ending in ✓', TOKEN, async ($, on) => {
  const clock = world(on, CLOSED)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  const n = await nodes(pane)
  const rows = n.filter(x => /^\S.* ✓$/.test(x.text))
  expect(rows.map(x => x.text)).toEqual([
    `${'GitLab'.padEnd(33)} ${'✓'.padStart(14)}`,
    `${"Rename to What's Next".padEnd(33)} ${'✓'.padStart(14)}`,
    `${'Forgejo dependencies'.padEnd(33)} ${'✓'.padStart(14)}`,
  ])
  expect(rows.every(x => x.props.color === 'inactive')).toBe(true)
})

test('a closed milestone unfolded: its epics grey, how many are closed, and issues still open', TOKEN, async ($, on) => {
  const clock = world(on, CLOSED)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'ms-fold-GitLab' })
  const n = await nodes(pane)
  const epic = n.find(x => x.text.startsWith('    #12 GitLab support'))
  expect(epic?.text.endsWith('✓')).toBe(true)
  expect(epic?.props.color).toBe('inactive')
  expect(n.map(x => x.text)).toContain('  ✓ 11 closed')
  expect(n.some(x => x.text.startsWith('  ○ #44 GitLab leftovers'))).toBe(true)
  await pane.press({ key: 'ms-issue-12' })
  await backToMilestones(pane)
})

test('without a closed milestone there is no Closed rule', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect((await texts(pane)).some(x => x.includes('Closed'))).toBe(false)
})

// Milestone detail: the rest of a milestone's row opens it.

test("the rest of a milestone's row opens its detail, in place of the list", TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('←')
  await expect(pane.find({ key: 'refresh' })).resolves.toBeDefined()
  await expect(pane.find({ key: 'menu' })).resolves.toBeDefined()
  expect(await rowKeys(pane)).toEqual([])
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'GitHub')?.props.bold).toBe(true)
})

test('the head of a milestone detail: open says nothing under the title, then its due date under Due, in its colour', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const n = await nodes(pane)
  // No state word: open is the absence of ✓.
  expect(n.some(x => x.text.trim() === 'open')).toBe(false)
  const at = n.findIndex(x => x.text === 'GitHub' && x.props.bold === true)
  expect(at).toBeGreaterThan(-1)
  expect(n.some(x => x.text.includes('⧗'))).toBe(false)
  const key = n.findIndex(x => x.text === 'Due'.padEnd(11))
  expect(key).toBeGreaterThan(at)
  expect(n[key]?.props.dimColor).toBe(true)
  expect(n[key + 1]?.text).toBe('13 Oct, in 4 days')
  expect(n[key + 1]?.props.color).toBe('warning')
})

test("a closed milestone's due date is short and dim", TOKEN, async ($, on) => {
  const due = { ...shut('Done', '2026-10-06T10:00:00Z', 0, 4, 8), due_on: '2026-10-05T00:00:00Z' }
  const clock = world(on, { ...REPO, closedMilestones: [due] })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'milestone-Done' })
  const n = await nodes(pane)
  expect(n.map(x => x.text)).toContain('✓ Done')
  expect(n.map(x => x.text)).toContain('3 days ago')
  const key = n.findIndex(x => x.text === 'Due'.padEnd(11))
  expect(n[key + 1]?.text).toBe('5 Oct')
  expect(n[key + 1]?.props.color).toBeUndefined()
  expect(n[key + 1]?.props.dimColor).toBe(true)
})

test('a milestone detail without a due date says nothing of it', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-Panes' })
  const t = await texts(pane)
  expect(t).toContain('Panes')
  expect(t.some(x => x.includes('Due') || x.includes('due') || x.includes('⧗'))).toBe(false)
})

test("a milestone detail's progress: the bar, closed of all, how many open, and what there is for you", TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const t = await texts(pane)
  expect(t).toContain('▰▰▰▰▱▱▱▱ 9/17 · 8 open')
  const at = t.indexOf('● 1 · ○ 1 · ◌ 1 · ⊘ 1')
  expect(t.slice(at + 1, at + 8)).toEqual(['● 1', ' · ', '○ 1', ' · ', '◌ 1', ' · ', '⊘ 1'])
})

test("a milestone detail's description, wrapped; none says so", TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const t = await texts(pane)
  expect(t).toContain('GitHub as a third forge.')
  expect(t).toContain('Done when /next works on GitHub.')
  await pane.press({ key: 'back' })
  await pane.press({ key: 'milestone-Jira' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'No description.')?.props.dimColor).toBe(true)
})

test('a milestone detail: Issues, its tree, unfolded at first, folds on its rule', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  let t = await texts(pane)
  const head = t.findIndex(x => x.startsWith('− Issues · 8 open ─'))
  expect(head).toBeGreaterThan(-1)
  expect(head).toBeLessThan(t.findIndex(x => x.startsWith('── Description')))
  expect(t.some(x => x.startsWith('#29 GitHub support'))).toBe(true)
  expect(t.some(x => x.startsWith('  ⊘ #40'))).toBe(true)
  await pane.press({ key: 'fold-29' })
  expect((await texts(pane)).some(x => x.startsWith('    ● #30'))).toBe(true)
  await pane.press({ key: 'issues-section' })
  t = await texts(pane)
  expect(t.some(x => x.startsWith('+ Issues · 8 open ─'))).toBe(true)
  expect(t.some(x => x.includes('#29') || x.includes('#40'))).toBe(false)
  // Refresh keeps it shut; every milestone opens with it unfolded, this one again too.
  await pane.press({ key: 'refresh' })
  expect((await texts(pane)).some(x => x.startsWith('+ Issues · 8 open ─'))).toBe(true)
  await pane.press({ key: 'back' })
  await pane.press({ key: 'milestone-Jira' })
  expect((await texts(pane)).some(x => x.startsWith('− Issues · 6 open ─'))).toBe(true)
  await pane.press({ key: 'back' })
  await pane.press({ key: 'milestone-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('− Issues · 8 open ─'))).toBe(true)
})

test('a milestone detail: a description over three lines folds to three and how many more; unfolded, all of it', TOKEN, async ($, on) => {
  const long = ['One.', '', 'Two.', '', 'Three.', '', 'Four.'].join('\n')
  const clock = world(on, { milestones: [milestone('GitHub', '2026-10-13T00:00:00Z', 8, 9, 2, long)] })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  let t = await texts(pane)
  expect(t.some(x => x.startsWith('+ Description ─'))).toBe(true)
  expect(t).toContain('Two.')
  expect(t).not.toContain('Three.')
  expect(((await pane.find({ key: 'description-more' })) as { props: { label: string } } | undefined)?.props.label).toBe('… 4 more lines')
  await pane.press({ key: 'description-section' })
  t = await texts(pane)
  expect(t.some(x => x.startsWith('− Description ─'))).toBe(true)
  expect(t).toContain('Four.')
  await expect(pane.find({ key: 'description-more' })).resolves.toBeUndefined()
  // Back and in again: folded, as it opens every time.
  await pane.press({ key: 'back' })
  await pane.press({ key: 'milestone-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('+ Description ─'))).toBe(true)
})

test("Open in Browser opens the milestone's page on Forgejo", TOKEN, async ($, on) => {
  const ran: string[] = []
  const clock = world(on, { ...REPO, ran })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  expect(await pane.find({ key: 'prompt' })).toBeUndefined()
  expect(await pane.find({ key: 'assign' })).toBeUndefined()
  await pane.press({ key: 'menu' })
  await pane.press({ key: 'menu-open' })
  expect(ran).toContain('open https://git.example.org/boats/radar/milestone/2')
  await pane.press({ key: 'open' })
  expect(ran.filter(x => x === 'open https://git.example.org/boats/radar/milestone/2')).toHaveLength(2)
})

test("opening a milestone's detail asks its issues once, shared with the fold", TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(1)
  const before = asked.length
  await pane.press({ key: 'back' })
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'milestone-GitHub' })
  expect(asked.length).toBe(before)
})

test('Back from a milestone detail returns to the list, its folds as they were', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-Jira' })
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'back' })
  expect(await rowKeys(pane)).toContain('milestone-GitHub')
  await expect(pane.find({ key: 'ms-issue-50' })).resolves.toBeDefined()
  await expect(pane.find({ key: 'ms-issue-33' })).resolves.toBeUndefined()
})

test('Refresh keeps a milestone detail open and asks its issues again', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'refresh' })
  expect(await rowKeys(pane)).toEqual([])
  expect((await texts(pane)).filter(x => x === 'GitHub')).toHaveLength(1)
  expect(await texts(pane)).toContain('● 1')
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(2)
})

test("when the open issues could not be listed, a milestone detail's issues are unknown", TOKEN, async ($, on) => {
  const clock = world(on, { ...WORK, failIssues: true })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'issues unknown')?.props.dimColor).toBe(true)
})

test('a closed milestone opens its detail too: ✓ before its title, n days ago under it, all closed', TOKEN, async ($, on) => {
  const ran: string[] = []
  const clock = world(on, { ...CLOSED, ran })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'milestone-Forgejo dependencies' })
  const t = await texts(pane)
  expect(t).toContain('✓ Forgejo dependencies')
  expect(t).toContain('7 days ago')
  expect(t).toContain('▰▰▰▰▰▰▰▰ 6/6 · all closed')
  await pane.press({ key: 'open' })
  expect(ran).toContain('open https://git.example.org/boats/radar/milestone/9')
})

// One state, one word (#45): every issue closed is all closed, amber while
// the milestone is still open, dim once it is closed.
test('an open milestone with every issue closed says all closed, amber, in its row and its detail', TOKEN, async ($, on) => {
  const clock = world(on, { milestones: [milestone('Done', '2026-10-20T00:00:00Z', 0, 5, 7)] })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  let n = await nodes(pane)
  expect(n.map(x => x.text)).toContain('  ⧗ 20 Oct · all closed')
  expect(n.find(x => x.text === 'all closed')?.props.color).toBe('warning')
  expect(n.some(x => /^ {2}.*0 open/.test(x.text))).toBe(false)
  await pane.press({ key: 'milestone-Done' })
  n = await nodes(pane)
  expect(n.map(x => x.text)).toContain('▰▰▰▰▰▰▰▰ 5/5 · all closed')
  expect(n.find(x => x.text === 'all closed')?.props.color).toBe('warning')
})

test('a closed milestone says all closed dim in its detail: nothing is left to do', TOKEN, async ($, on) => {
  const clock = world(on, CLOSED)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'milestone-Forgejo dependencies' })
  const word = (await nodes(pane)).find(x => x.text === 'all closed')
  expect(word?.props.color).toBeUndefined()
  expect(word?.props.dimColor).toBe(true)
})

// Rules (#45): `── ` and the line dim, the name bold, a count after ` · `; a
// rule that folds starts with its + or −, plain.
test('a rule draws its name bold and the rest dim; a folding rule starts with its mark, plain', TOKEN, async ($, on) => {
  const clock = world(on, CLOSED)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const n = await nodes(pane)
  const at = n.findIndex(x => x.text.startsWith('+ Closed · 3 ─'))
  expect(n[at + 1]?.text).toBe('+ ')
  expect(n[at + 1]?.props.dimColor).toBeFalsy()
  expect(n[at + 2]?.text).toBe('Closed')
  expect(n[at + 2]?.props.bold).toBe(true)
  expect(n[at + 3]?.text).toBe(' · ')
  expect(n[at + 3]?.props.dimColor).toBe(true)
  expect(n[at + 4]?.text).toBe('3')
  expect(n[at + 4]?.props.dimColor).toBe(true)
  expect(n[at + 5]?.props.dimColor).toBe(true)
})

type Btns = { findAll: (q: { type: string }) => Promise<unknown[]> }
const buttons = async (ui: Btns) => ((await ui.findAll({ type: 'Button' })) as { key: string; props: { label?: string } }[])

test('read only: a milestone detail has no Close', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  // The top row, before the sections: the hidden hotkeys, Back, the menu.
  let keys = (await buttons(pane)).map(b => b.key)
  expect(keys.slice(0, keys.indexOf('issues-section'))).toEqual(['open', 'refresh', 'help', 'back', 'menu'])
  await pane.press({ key: 'menu' })
  keys = (await buttons(pane)).map(b => b.key)
  expect(keys.filter(k => k.startsWith('menu-'))).toEqual(['menu-open', 'menu-refresh', 'menu-help'])
})

test('the menu holds Open in Browser, Close, Refresh, and Close closes the milestone at once, open issues and all', TOKEN, async ($, on) => {
  const sent: World['sent'] = []
  const w: World = { ...WORK, milestones: [...(WORK.milestones ?? [])], write: true, sent }
  const clock = world(on, w)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  let keys = (await buttons(pane)).map(b => b.key)
  expect(keys.slice(0, keys.indexOf('issues-section'))).toEqual(['open', 'close', 'refresh', 'help', 'back', 'menu'])
  expect((await buttons(pane)).find(b => b.key === 'close')?.props.label).toBe('Close')
  await pane.press({ key: 'menu' })
  keys = (await buttons(pane)).map(b => b.key)
  expect(keys.filter(k => k.startsWith('menu-'))).toEqual(['menu-open', 'menu-close', 'menu-refresh', 'menu-help'])
  const t = await texts(pane)
  const words = ['Open in Browser', 'Close', 'Refresh'].map(w => t.findIndex(x => x.startsWith(`${w} `)))
  expect(words.every(i => i > -1)).toBe(true)
  expect([...words].sort((a, b) => a - b)).toEqual(words)
  await pane.press({ key: 'menu-close' })
  expect(sent).toEqual([{ path: '/api/v1/repos/boats/radar/milestones/2', body: { state: 'closed' } }])
  // Back on the list, read again: GitHub has left the open milestones for Closed.
  expect(await pane.find({ key: 'back' })).toBeUndefined()
  expect(await rowKeys(pane)).not.toContain('milestone-GitHub')
  await pane.press({ key: 'closed-section' })
  expect(await rowKeys(pane)).toContain('milestone-GitHub')
})

test('Reopen opens a closed milestone again, back among the open ones', TOKEN, async ($, on) => {
  const sent: World['sent'] = []
  const closedOnes = [shut('GitLab', '2026-10-09T10:00:00Z', 1, 11, 7), shut('Old', '2026-09-01T10:00:00Z', 0, 2, 8)]
  const w: World = { ...CLOSED, closedMilestones: closedOnes, write: true, sent }
  const clock = world(on, w)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'milestone-GitLab' })
  expect((await buttons(pane)).find(b => b.key === 'close')?.props.label).toBe('Reopen')
  await pane.press({ key: 'close' })
  expect(sent).toEqual([{ path: '/api/v1/repos/boats/radar/milestones/7', body: { state: 'open' } }])
  expect(await pane.find({ key: 'back' })).toBeUndefined()
  expect(await rowKeys(pane)).toContain('milestone-GitLab')
})

test('a refused Close keeps the detail open and says why, in red under the heading, one text per line', TOKEN, async ($, on) => {
  const why = 'token may not do this, ask an owner of boats/radar for write rights'
  const w: World = { ...REPO, write: true, sent: [], refuse: { status: 403, message: why } }
  const clock = world(on, w)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'close' })
  const n = await nodes(pane)
  const at = n.findIndex(x => x.text.startsWith('Could not close GitHub:'))
  const red = n.slice(at).filter(x => x.props.color === 'error')
  expect(red.length).toBeGreaterThan(1)
  expect(red.map(x => x.text).join(' ')).toBe(`Could not close GitHub: ${why}.`)
  expect(at).toBeLessThan(n.findIndex(x => x.text.startsWith('− Issues')))
  await expect(pane.find({ key: 'back' })).resolves.toBeDefined()
  // Back and in again: the refusal is gone.
  await pane.press({ key: 'back' })
  await pane.press({ key: 'milestone-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('Could not close'))).toBe(false)
})

