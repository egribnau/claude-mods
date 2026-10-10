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
  // The repo's open issues, and each issue's dependencies, as Forgejo lists them.
  issues?: unknown[]
  deps?: Record<number, unknown[]>
  // Whether the list of open issues answers 500.
  failIssues?: boolean
}
type Opened = { id: string; title?: string; focus?: true }

// A Forgejo repo that passes setup, has no open issues and no epics, and
// answers `w`'s open milestones.
function world(on: On, w: World, asked: string[] = [], opened: Opened[] = [], closed: string[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
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
    const mine = (w.issues ?? []).filter(i => (i as { assignees: { login: string }[] }).assignees.some(a => a.login === 'alice'))
    if (url.pathname.endsWith('/repos/issues/search')) return reply(200, page === 0 ? mine : [])
    if (url.pathname.endsWith('/repos/boats/radar/issues')) {
      if (url.searchParams.get('labels')) return reply(200, [])
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
    if (url.pathname.endsWith('/repos/boats/radar/milestones')) return reply(200, page === 0 ? (w.milestones ?? []) : [])
    if (url.pathname.endsWith('/repos/boats/radar')) {
      return reply(200, { full_name: 'boats/radar', open_issues_count: 9, permissions: { push: false } })
    }
    return reply(404, { message: 'not found' })
  })
  return clock
}

type Extra = { milestone?: string; assignees?: string[] }

function issue(number: number, title: string, extra: Extra = {}) {
  return {
    number,
    title,
    state: 'open',
    created_at: '2026-10-08T09:00:00Z',
    html_url: `https://git.example.org/boats/radar/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: [],
    assignees: (extra.assignees ?? []).map(login => ({ login })),
    repository: { full_name: 'boats/radar' },
  }
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
type Found = { key: string; text: string; props: Record<string, unknown> }
const nodes = async (ui: Ui) => (await ui.findAll({ type: 'Text' })) as unknown as Found[]

const milestone = (title: string, due: string | null, open: number, closed: number) => ({
  title,
  due_on: due,
  open_issues: open,
  closed_issues: closed,
  state: 'open',
})

// GitHub is due in 4 days, Jira later, Panes has no due date, v0.3.0 is late.
const REPO: World = {
  milestones: [
    milestone('Panes', null, 3, 1),
    milestone('Jira', '2026-11-30T00:00:00Z', 6, 0),
    milestone('GitHub', '2026-10-13T00:00:00Z', 8, 9),
    milestone('v0.3.0', '2026-10-01T00:00:00Z', 3, 12),
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
  const rows = t.filter(x => /^[+−] \S/.test(x))
  expect(rows.map(x => x.slice(2).trim().split(' ')[0])).toEqual(['v0.3.0', 'GitHub', 'Jira', 'Panes'])
  expect(t).toContain('due 13 Oct, in 4 days')
  expect(t).toContain('due 30 Nov, in 52 days')
  expect(t).toContain('no due date')
  expect(t).toContain(' · 8 open')
})

test('a milestone row has the bar and closed/total from its own counts', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const t = await texts(pane)
  // GitHub: 9 of 17 closed, so 4 of 8 cells.
  const i = t.indexOf(`+ ${'GitHub'.padEnd(33)} ▰▰▰▰▱▱▱▱  9/17`)
  expect(t.slice(i + 1, i + 6)).toEqual(['+ ', `${'GitHub'.padEnd(33)} `, '▰▰▰▰', '▱▱▱▱', '  9/17'])
})

test('a due date is red once passed and amber within 7 days', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'due 1 Oct, 8 days ago')?.props.color).toBe('error')
  expect(n.find(x => x.text === 'due 13 Oct, in 4 days')?.props.color).toBe('warning')
  expect(n.find(x => x.text === 'due 30 Nov, in 52 days')?.props.dimColor).toBe(true)
})

test('the whole row folds a milestone open and shut', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('− GitHub'))).toBe(true)
  await pane.press({ key: 'milestone-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('+ GitHub'))).toBe(true)
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
  await pane.press({ key: 'milestone-GitHub' })
  const t = await texts(pane)
  const rows = t.filter(x => /^ {2}[●○⊘ ] #\d/.test(x))
  expect(rows.map(x => x.slice(2, 6))).toEqual(['● #3', '  #3', '○ #3', '⊘ #4'])
  expect(t).toContain('jdoe')
  expect(t).toContain('blocked by ')
  expect(t).toContain('  ✓ 9 closed')
  // The milestone is left out of the facts under each row.
  expect(t).not.toContain('GitHub')
})

test('once unfolded, the line under a milestone adds what there is for you', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  expect(await texts(pane)).not.toContain('1 yours')
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'milestone-GitHub' })
  const t = await texts(pane)
  const at = t.indexOf(' · 8 open')
  expect(t.slice(at, at + 6)).toEqual([' · 8 open', ' · ', '1 yours', ' · ', '1 blocked', ' · '])
  expect(t[at + 6]).toBe('1 up for grabs')
})

test('a row opens Issue detail, and Back returns to Milestones', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'ms-issue-33' })
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('← Milestones')
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
  await pane.press({ key: 'milestone-GitHub' })
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(1)
  const before = asked.length
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'milestone-GitHub' })
  expect(asked.length).toBe(before)
  expect(DEPS(asked).some(u => u.includes('/issues/50/'))).toBe(false)
})

test('folds hold over Refresh, which asks again only for unfolded milestones', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORK, asked)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  await pane.press({ key: 'refresh' })
  expect((await texts(pane)).some(x => x.startsWith('− GitHub'))).toBe(true)
  expect(DEPS(asked).filter(u => u.includes('/issues/36/'))).toHaveLength(2)
  expect(DEPS(asked).some(u => u.includes('/issues/50/'))).toBe(false)
})

test("when the open issues could not be listed, an unfolded milestone's issues are unknown", TOKEN, async ($, on) => {
  const clock = world(on, { ...WORK, failIssues: true })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '  issues unknown')?.props.dimColor).toBe(true)
})
