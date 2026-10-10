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
      return reply(200, { full_name: 'boats/radar', open_issues_count: 9, permissions: { push: false } })
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
  expect(t).toContain('due 13 Oct')
  expect(t).toContain('due 30 Nov')
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
  const i = t.indexOf(`${'GitHub'.padEnd(33)} ▰▰▰▰▱▱▱▱  9/17`)
  expect(t[i - 1]).toBe('+ ')
  expect(t.slice(i + 1, i + 5)).toEqual([`${'GitHub'.padEnd(33)} `, '▰▰▰▰', '▱▱▱▱', '  9/17'])
})

test('the line under a milestone is one line, cut at its end on a narrow pane', TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const n = await nodes(pane)
  const under = n.find(x => x.text === '  due 13 Oct · 8 open · 1 yours · 1 blocked · 1 up for grabs')
  expect(under?.props.wrap).toBe('truncate-end')
})

test('a due date is red once passed and amber within 7 days', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'due 1 Oct')?.props.color).toBe('error')
  expect(n.find(x => x.text === 'due 13 Oct')?.props.color).toBe('warning')
  expect(n.find(x => x.text === 'due 30 Nov')?.props.dimColor).toBe(true)
})

test('the fold mark folds a milestone open and shut', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect(await texts(pane)).toContain('  ✓ 9 closed')
  expect(await texts(pane)).toContain('− ')
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
  await pane.press({ key: 'ms-fold-GitHub' })
  await pane.press({ key: 'ms-fold-GitHub' })
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
  await pane.press({ key: 'ms-fold-GitHub' })
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

test('epics in a milestone come first, with their bar and what there is for you in them', TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const t = await texts(pane)
  const rows = t.filter(x => /^ {2}[●○⊘ ] #\d/.test(x))
  expect(rows[0]).toBe(`    #29 ${'GitHub support'.padEnd(27)} ▰▰▱▱▱▱▱▱   1/4`)
  expect(rows.slice(1).map(x => x.slice(2, 7))).toEqual(['● #30', '  #33', '○ #36', '⊘ #40'])
  const at = t.indexOf('▱▱▱▱▱▱')
  expect(t.slice(at + 1, at + 6)).toEqual(['   1/4', '        1 yours · 1 up for grabs', '1 yours', ' · ', '1 up for grabs'])
})

test("the line under an epic in a milestone is one line, cut at its end", TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === '        1 yours · 1 up for grabs')?.props.wrap).toBe('truncate-end')
})

test("an epic is not blocked by its own children, and opens its detail", TOKEN, async ($, on) => {
  const clock = world(on, EPIC_WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'ms-fold-GitHub' })
  expect((await texts(pane)).some(x => x.startsWith('  ⊘ #29'))).toBe(false)
  await pane.press({ key: 'ms-issue-29' })
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('← Milestones')
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
  const t = await texts(pane)
  const at = t.indexOf(' · 8 open')
  expect(t.slice(at + 1, at + 7)).toEqual([' · ', '1 yours', ' · ', '1 blocked', ' · ', '1 up for grabs'])
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
  expect(t).toContain('+ Closed · 3 ')
  expect(await rowKeys(pane)).not.toContain('milestone-GitLab')
})

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
  expect(n.some(x => x.text.startsWith('    #44 GitLab leftovers'))).toBe(true)
  await pane.press({ key: 'ms-issue-12' })
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('← Milestones')
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
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('← Milestones')
  await expect(pane.find({ key: 'refresh' })).resolves.toBeDefined()
  expect(await rowKeys(pane)).toEqual([])
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'GitHub')?.props.bold).toBe(true)
})

test('the head of a milestone detail: open, and its due date in its colour', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const n = await nodes(pane)
  expect(n.find(x => x.text === 'open')?.props.dimColor).toBe(true)
  expect(n.find(x => x.text === 'due 13 Oct, in 4 days')?.props.color).toBe('warning')
})

test("a milestone detail's progress: the bar, closed of all, how many open, and what there is for you", TOKEN, async ($, on) => {
  const clock = world(on, WORK)
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  const t = await texts(pane)
  expect(t).toContain(' 9/17 · 8 open')
  const at = t.indexOf('1 yours')
  expect(t.slice(at, at + 5)).toEqual(['1 yours', ' · ', '1 blocked', ' · ', '1 up for grabs'])
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

test("Open in browser opens the milestone's page on Forgejo", TOKEN, async ($, on) => {
  const ran: string[] = []
  const clock = world(on, { ...REPO, ran })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'milestone-GitHub' })
  expect(await pane.find({ key: 'work' })).toBeUndefined()
  expect(await pane.find({ key: 'close' })).toBeUndefined()
  await pane.press({ key: 'open' })
  expect(ran).toContain('open https://git.example.org/boats/radar/milestone/2')
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
  expect((await pane.find({ key: 'back' }))?.props.label).toBe('← Milestones')
  expect(await texts(pane)).toContain('1 yours')
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

test('a closed milestone opens its detail too: closed n days ago, all closed', TOKEN, async ($, on) => {
  const ran: string[] = []
  const clock = world(on, { ...CLOSED, ran })
  await clock.set(NOW)
  await $.command.run(RUN)
  const pane = await $.ui.mount({ ...MILESTONES_PANE, surface: 'terminal' })
  await pane.press({ key: 'closed-section' })
  await pane.press({ key: 'milestone-Forgejo dependencies' })
  const t = await texts(pane)
  expect(t).toContain('closed 7 days ago')
  expect(t).toContain(' 6/6 · all closed')
  await pane.press({ key: 'open' })
  expect(ran).toContain('open https://git.example.org/boats/radar/milestone/9')
})
