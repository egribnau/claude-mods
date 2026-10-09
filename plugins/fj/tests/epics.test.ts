import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, groupsFor, openChildren, pickerOptions, summary, tally } from '../hooks/epics'
import type { EpicChild } from '../types'

const EPICS_PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj-epics',
  props: {
    title: 'Epics',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const TOKEN = { options: { token: 'secret', icons: 'text' } }
const NOW = Date.parse('2026-10-09T12:00:00Z')

type Extra = { milestone?: string; labels?: string[]; assignees?: string[]; state?: 'open' | 'closed' }

function issue(number: number, title: string, extra: Extra = {}) {
  return {
    number,
    title,
    state: extra.state ?? 'open',
    created_at: '2026-09-01T09:00:00Z',
    html_url: `https://git.example.org/boats/radar/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name })),
    assignees: (extra.assignees ?? []).map(login => ({ login })),
    repository: { full_name: 'boats/radar' },
  }
}
const epic = (number: number, title: string, extra: Extra = {}) => issue(number, title, { ...extra, labels: ['epic'] })

type World = {
  epics?: unknown[]
  milestones?: unknown[]
  // Each issue's dependencies, as Forgejo lists them.
  deps?: Record<number, unknown[]>
  // The label the Epic label setting names; Forgejo filters by it.
  label?: string
}

// A repo that passes setup, has no other open issues, and answers `w`.
function world(on: On, w: World, asked: string[] = [], opened: { id: string; title?: string }[] = [], closed: string[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
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
    const dep = /\/issues\/(\d+)\/dependencies$/.exec(url.pathname)
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5+gitea-1.22.0' })
    if (url.pathname.endsWith('/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/repos/issues/search')) return reply(200, [])
    if (url.pathname.endsWith('/repos/boats/radar/issues')) {
      const wanted = url.searchParams.get('labels')
      return reply(200, wanted === (w.label ?? 'epic') && page === 0 ? (w.epics ?? []) : [])
    }
    if (url.pathname.endsWith('/repos/boats/radar/milestones')) return reply(200, page === 0 ? (w.milestones ?? []) : [])
    if (dep) return reply(200, w.deps?.[Number(dep[1])] ?? [])
    if (url.pathname.endsWith('/repos/boats/radar')) return reply(200, { full_name: 'boats/radar', open_issues_count: 9 })
    return reply(404, { message: 'not found' })
  })
  return clock
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

// v1.2, due first, holds Auth cleanup (#12), Rate limits (#20), Docs pass
// (#25) and the closed Project setup (#3); v1.3 holds Scripting, and Ideas
// has no milestone.
const REPO: World = {
  milestones: [milestone('v1.3', '2026-11-30T00:00:00Z', 6, 0), milestone('v1.2', '2026-10-31T00:00:00Z', 8, 9)],
  epics: [
    epic(20, 'Rate limits', { milestone: 'v1.2' }),
    epic(12, 'Auth cleanup', { milestone: 'v1.2' }),
    epic(25, 'Docs pass', { milestone: 'v1.2' }),
    epic(3, 'Project setup', { milestone: 'v1.2', state: 'closed' }),
    epic(60, 'Scripting', { milestone: 'v1.3' }),
    epic(71, 'Ideas'),
  ],
  deps: {
    20: [
      issue(37, 'Token refresh on 401', { assignees: ['alice'] }),
      issue(51, 'Rate limit settings page'),
      issue(44, 'Session store migration', { assignees: ['jdoe'] }),
      issue(33, 'Retry on 502'),
      issue(10, 'Old limits', { state: 'closed' }),
    ],
    33: [issue(37, 'Token refresh on 401', { assignees: ['alice'] })],
    12: [
      issue(42, 'Fix login redirect', { assignees: ['alice'] }),
      issue(43, 'Logout everywhere', { assignees: ['alice', 'jdoe'] }),
      issue(45, 'Drop cookie auth'),
      issue(46, 'Audit log export'),
      issue(47, 'Password rules'),
      issue(48, 'One', { state: 'closed' }),
      issue(49, 'Two', { state: 'closed' }),
      issue(50, 'Three', { state: 'closed' }),
    ],
    45: [issue(99, 'Elsewhere')],
    25: [1, 2, 4, 5, 6].map(n => issue(n, `Doc ${n}`, { state: 'closed' })),
  },
}

const rule = (name: string) => `── ${name} `.padEnd(50, '─')

test("the Epics pane opens next to What's next when the repo has an open epic", TOKEN, async ($, on) => {
  const opened: { id: string; title?: string }[] = []
  world(on, REPO, [], opened)
  await $.command.run(RUN)
  expect(opened.at(-1)).toEqual({ id: 'fj-epics', title: 'Epics' })
  expect(opened.filter(p => p.id === 'fj').at(-1)?.title).toBe("What's next")
})

test('with no open epic there is no Epics pane', TOKEN, async ($, on) => {
  const opened: { id: string; title?: string }[] = []
  world(on, { epics: [epic(3, 'Project setup', { state: 'closed' })] }, [], opened)
  await $.command.run(RUN)
  expect(opened.some(p => p.id === 'fj-epics')).toBe(false)
})

test('once the last epic is closed, /fj closes the Epics pane', TOKEN, async ($, on) => {
  const closed: string[] = []
  const w: World = { ...REPO }
  world(on, w, [], [], closed)
  await $.command.run(RUN)
  w.epics = [epic(3, 'Project setup', { state: 'closed' })]
  await $.command.run(RUN)
  expect(closed).toEqual(['fj-epics'])
})

test('epics are found by the Epic label setting', { options: { ...TOKEN.options, label: 'theme' } }, async ($, on) => {
  const opened: { id: string; title?: string }[] = []
  world(on, { ...REPO, label: 'theme', epics: REPO.epics?.map(e => ({ ...(e as object), labels: [{ name: 'theme' }] })) }, [], opened)
  await $.command.run(RUN)
  expect(opened.at(-1)?.id).toBe('fj-epics')
})

test('starts on the open milestone due first, its epics folded', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })

  expect(await texts(ui)).toEqual([
    'Epics',
    '── ',
    'v1.2',
    ' · due 31 Oct · 9/17 closed ',
    '─'.repeat(50 - '── v1.2 · due 31 Oct · 9/17 closed '.length),
    '+ ',
    `#12 ${'Auth cleanup'.padEnd(29)} ▰▰▰▱▱▱▱▱   3/8`,
    '#12 ',
    `${'Auth cleanup'.padEnd(29)} `,
    '▰▰▰',
    '▱▱▱▱▱',
    '   3/8',
    '      ',
    '2 yours',
    ' · ',
    '1 blocked',
    ' · ',
    '2 up for grabs',
    '+ ',
    `#20 ${'Rate limits'.padEnd(29)} ▰▰▱▱▱▱▱▱   1/5`,
    '#20 ',
    `${'Rate limits'.padEnd(29)} `,
    '▰▰',
    '▱▱▱▱▱▱',
    '   1/5',
    '      ',
    '1 yours',
    ' · ',
    '1 blocked',
    ' · ',
    '1 up for grabs',
    '+ ',
    `#25 ${'Docs pass'.padEnd(29)} ▰▰▰▰▰▰▰▰   5/5`,
    '#25 ',
    `${'Docs pass'.padEnd(29)} `,
    '▰▰▰▰▰▰▰▰',
    '   5/5',
    '      ',
    'all children closed',
    `   #3 ${'Project setup'.padEnd(29)} ${'✓ closed'.padStart(14)}`,
    '─'.repeat(50),
    'git.example.org/',
    'boats/radar',
    '3 epics · ',
    '3 yours',
  ])
  const all = await nodes(ui)
  expect(all.find(t => t.text === 'v1.2')?.props.bold).toBe(true)
  expect(all.find(t => t.text === 'all children closed')?.props.color).toBe('warning')
  expect(all.find(t => t.text.startsWith('   #3 '))?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '3 yours')?.props.color).toBe('success')
})

test('the fold mark folds an epic open: its children with their marks, the closed ones counted', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })

  await ui.press({ key: 'fold-20' })
  const all = await texts(ui)
  const at = all.indexOf(`#20 ${'Rate limits'.padEnd(29)} ▰▰▱▱▱▱▱▱   1/5`)
  expect(all[at - 1]).toBe('− ')
  expect(at).toBeGreaterThan(-1)
  const rows = all.filter(t => /^ {2}. #\d+ /.test(t) || t.startsWith('  ✓'))
  expect(rows).toEqual([
    '  ● #37 Token refresh on 401',
    '    #51 Rate limit settings page',
    `    #44 ${'Session store migration'.padEnd(37)} jdoe`,
    '  ⊘ #33 Retry on 502',
    '  ✓ 1 closed',
  ])
  const found = await nodes(ui)
  expect(found.find(t => t.text === '● ')?.props.color).toBe('success')
  expect(found.find(t => t.text.startsWith('  ⊘'))?.props.dimColor).toBe(true)

  await ui.press({ key: 'fold-20' })
  expect((await texts(ui)).some(t => t.includes('#37'))).toBe(false)
})

test('clicking an epic opens its detail, closed ones too, and back returns to Epics', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })

  await ui.press({ key: 'epic-12' })
  const back = (await ui.find({ key: 'back' })) as unknown as { props: Record<string, unknown> }
  expect(back.props.label).toBe('← Epics')
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe('Epics')
  await ui.press({ key: 'epic-3' })
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
})

test('the fold mark comes before its epic, so Tab stops on it first', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  const keys = ((await ui.findAll({ type: 'Button' })) as unknown as { key: string }[]).map(b => b.key)
  expect(keys.indexOf('fold-12')).toBeGreaterThan(-1)
  expect(keys.indexOf('fold-12')).toBeLessThan(keys.indexOf('epic-12'))
  expect(keys).not.toContain('fold-3')
})

test('clicking a child opens its detail, and back returns to Epics', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })

  await ui.press({ key: 'fold-20' })
  await ui.press({ key: 'child-51' })
  const back = (await ui.find({ key: 'back' })) as unknown as { props: Record<string, unknown> }
  expect(back.props.label).toBe('← Epics')
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe('Epics')
})

test("an issue opened in Epics leaves What's next as it was", TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const epics = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  await epics.press({ key: 'fold-20' })
  await epics.press({ key: 'child-51' })

  const next = await $.ui.mount({ ...EPICS_PANE, requestId: 'fj', surface: 'terminal' })
  expect((await texts(next))[0]).toBe("What's next")
})

test('no open milestone with epics: the epics without a milestone', TOKEN, async ($, on) => {
  world(on, { milestones: [milestone('v2', null, 1, 0)], epics: [epic(71, 'Ideas')] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  const all = await texts(ui)
  expect(all.slice(1, 5)).toEqual(['── ', 'No milestone', ' ', '─'.repeat(50 - '── No milestone '.length)])
  expect(all).toContain('no children')
})

test('the rule and the repo line keep their row when the epics are too many', TOKEN, async ($, on) => {
  const many = Array.from({ length: 30 }, (_, k) => epic(100 + k, `Epic ${k}`, { milestone: 'v1.2' }))
  world(on, { milestones: REPO.milestones, epics: many })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, props: { ...EPICS_PANE.props, scroll: { offset: 0, bodyRows: 12 } }, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  for (const key of ['group-0', 'where-rule', 'where']) expect(boxes.find(b => b.key === key)?.props.flexShrink).toBe(0)
})

test('Refresh in the Epics pane loads the epics again', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, REPO, asked)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  const before = asked.filter(u => u.includes('labels=epic')).length
  await ui.press({ key: 'refresh' })
  expect(asked.filter(u => u.includes('labels=epic')).length).toBeGreaterThan(before)
})

type Btn = { key: string; props: Record<string, unknown> }
const label = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
  ((await ui.find({ key: 'milestone' })) as Btn | undefined)?.props.label
const choices = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) =>
  ((await ui.findAll({ type: 'Button' })) as Btn[]).map(b => b.key).filter(k => k.startsWith('pick-'))

test('the picker shows what is picked, and opens on the open milestones with epics, No milestone and All', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  expect(await label(ui)).toBe('v1.2 ▾')
  expect(await choices(ui)).toEqual([])

  await ui.press({ key: 'milestone' })
  expect(await choices(ui)).toEqual(['pick-m:v1.2', 'pick-m:v1.3', 'pick-none', 'pick-all'])
  const all = await texts(ui)
  expect(all).toContain(`${'v1.2'.padEnd(14)}31 Oct`)
  expect(all).toContain('All'.padEnd(20))
  // Pressed again, it closes.
  await ui.press({ key: 'milestone' })
  expect(await choices(ui)).toEqual([])
})

test('picking another milestone shows its epics', TOKEN, async ($, on) => {
  const clock = world(on, REPO)
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'pick-m:v1.3' })
  expect(await choices(ui)).toEqual([])
  expect(await label(ui)).toBe('v1.3 ▾')
  const all = await texts(ui)
  expect(all.slice(1, 4)).toEqual(['── ', 'v1.3', ' · due 30 Nov · 0/6 closed '])
  expect(all.some(t => t.startsWith('#60 Scripting'))).toBe(true)
  expect(all.some(t => t.includes('#12'))).toBe(false)
})

test('All shows a group per milestone, No milestone last, and counts them all', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'pick-all' })
  const all = await texts(ui)
  const names = all.filter((t, k) => all[k - 1] === '── ')
  expect(names).toEqual(['v1.2', 'v1.3', 'No milestone'])
  expect(all.slice(-2)).toEqual(['5 epics · ', '3 yours'])
  const found = await nodes(ui)
  expect(found.filter(t => names.includes(t.text)).every(t => t.props.bold === true)).toBe(true)
  // An extra empty line sets each group after the first apart from the last epic above it.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Btn[]
  expect(['group-0', 'group-1', 'group-2'].map(k => boxes.find(b => b.key === k)?.props.marginTop ?? 0)).toEqual([0, 1, 1])
})

test('the pick holds over a Refresh', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'pick-m:v1.3' })
  await ui.press({ key: 'refresh' })
  expect(await label(ui)).toBe('v1.3 ▾')
  expect((await texts(ui))[2]).toBe('v1.3')
})

const child = (number: number, extra: Partial<EpicChild> = {}): EpicChild => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  assignees: [],
  mine: false,
  blocked: false,
  ...extra,
})

test('openChildren: yours, up for grabs, others, blocked; closed ones left out', () => {
  const got = openChildren([
    child(5, { blocked: true }),
    child(4, { assignees: ['jdoe'] }),
    child(3),
    child(2, { mine: true, assignees: ['alice'], blocked: true }),
    child(1, { state: 'closed' }),
  ])
  expect(got.map(c => c.number)).toEqual([2, 3, 4, 5])
})

test('tally and summary', () => {
  const kids = [child(1, { mine: true }), child(2, { blocked: true }), child(3), child(4, { state: 'closed' })]
  expect(tally(kids)).toEqual({ closed: 1, total: 4, mine: 1, free: 1, taken: 0, blocked: 1 })
  expect(summary({ number: 9, title: 'E', state: 'open', children: kids }).map(p => p.text)).toEqual([
    '1 yours',
    '1 blocked',
    '1 up for grabs',
  ])
  expect(summary({ number: 9, title: 'E', state: 'open', children: [child(1, { assignees: ['jdoe'] })] })).toEqual([
    { text: '1 with others' },
  ])
  expect(summary({ number: 9, title: 'E', state: 'open', children: null })).toEqual([{ text: 'children unknown' }])
})

test('bar: closed children as filled cells', () => {
  expect(bar(3, 8)).toEqual({ filled: '▰▰▰', empty: '▱▱▱▱▱' })
  expect(bar(0, 0)).toEqual({ filled: '', empty: '▱▱▱▱▱▱▱▱' })
})

const MS = [
  { title: 'later', due: '2026-12-01T00:00:00Z', closed: 0, total: 1 },
  { title: 'undated', due: null, closed: 0, total: 1 },
  { title: 'soon', due: '2026-10-10T00:00:00Z', closed: 0, total: 1 },
]

test('pickerOptions: open milestones with an epic, due first, then No milestone and All', () => {
  expect(pickerOptions(MS, [{ milestone: 'undated' }, { milestone: 'later' }, { milestone: null }])).toEqual([
    { value: 'm:later', label: 'later', due: '2026-12-01T00:00:00Z' },
    { value: 'm:undated', label: 'undated', due: null },
    { value: 'none', label: 'No milestone' },
    { value: 'all', label: 'All' },
  ])
  expect(pickerOptions(MS, [{ milestone: 'gone' }])).toEqual([{ value: 'all', label: 'All' }])
})

test('groupsFor: one milestone, the epics without one, or all of them in picker order', () => {
  const epics = [{ milestone: 'later' }, { milestone: 'soon' }, { milestone: null }, { milestone: 'closed one' }]
  expect(groupsFor('m:soon', MS, epics).map(g => g.milestone?.title ?? null)).toEqual(['soon'])
  expect(groupsFor('none', MS, epics).map(g => g.epics.length)).toEqual([1])
  expect(groupsFor('all', MS, epics).map(g => g.milestone?.title ?? null)).toEqual(['soon', 'later', null])
})
