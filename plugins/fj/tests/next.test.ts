import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { pickNext, waitingText } from '../hooks/next'
import type { IssueRow } from '../types'

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj',
  props: {
    title: 'fj',
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

type Extra = { milestone?: string; labels?: string[]; assignees?: string[]; repo?: string }

function issue(number: number, created: string, extra: Extra = {}) {
  const repo = extra.repo ?? 'boats/radar'
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    created_at: created,
    html_url: `https://git.example.org/${repo}/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name })),
    assignees: (extra.assignees ?? []).map(login => ({ login })),
    repository: { full_name: repo },
  }
}

type World = {
  // Pages of the search for issues assigned to you, across repos.
  mine?: unknown[][]
  // Pages of the repo's open issues.
  open?: unknown[][]
  // Open dependencies per issue; an issue left out has none. `off` answers
  // 404 for every issue, as when dependencies are turned off.
  deps?: Record<number, number[]> | 'off'
  // The status the repo's open issues answer with; 200 when left out.
  openStatus?: number
}

// A repo that passes setup and answers from `w`.
function world(on: On, w: World, asked: string[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const url = new URL(e.url)
    const page = Number(url.searchParams.get('page')) - 1
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) },
    })
    const dep = /\/issues\/(\d+)\/dependencies$/.exec(url.pathname)
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5+gitea-1.22.0' })
    if (url.pathname.endsWith('/repos/issues/search')) return reply(200, w.mine?.[page] ?? [])
    if (url.pathname.endsWith('/repos/boats/radar/issues')) {
      const status = w.openStatus ?? 200
      return reply(status, status === 200 ? (w.open?.[page] ?? []) : {})
    }
    if (dep) {
      if (w.deps === 'off') return reply(404, { message: 'not found' })
      const by = w.deps?.[Number(dep[1])] ?? []
      return reply(
        200,
        [...by.map(n => ({ number: n, title: `Issue ${n}`, state: 'open' })), { number: 1, title: 'Done', state: 'closed' }],
      )
    }
    if (url.pathname.endsWith('/repos/boats/radar')) return reply(200, { full_name: 'boats/radar', open_issues_count: 9 })
    return reply(404, { message: 'not found' })
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const rule = (name: string) => `── ${name} `.padEnd(50, '─')

// #42 is yours. Of the rest, #33 is oldest but blocked by #37, so #29 is
// next; #60 is someone else's and left out.
const MINE = issue(42, '2026-09-25T09:00:00Z', { milestone: 'v1.2', labels: ['bug'], assignees: ['alice'] })
const REPO: World = {
  mine: [[MINE, issue(3, '2026-01-01T00:00:00Z', { repo: 'boats/other', assignees: ['alice'] })]],
  open: [
    [
      MINE,
      issue(37, '2026-10-02T09:00:00Z', { milestone: 'v1.2', labels: ['prio/high'] }),
      issue(33, '2026-09-11T09:00:00Z'),
      issue(29, '2026-09-18T09:00:00Z', { labels: ['docs'] }),
      issue(60, '2026-09-01T09:00:00Z', { assignees: ['jdoe'] }),
      issue(51, '2026-10-03T09:00:00Z', { milestone: 'v1.2' }),
    ],
  ],
  deps: { 33: [37] },
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows In progress, Next and the Queue on ${surface}`, TOKEN, async ($, on) => {
    const clock = world(on, REPO)
    await clock.set(NOW)

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await texts(ui)).toEqual([
      "What's next",
      rule('In progress (1)'),
      '● #42 Issue 42',
      '● ',
      '#42 ',
      '      ',
      'v1.2 · bug · opened 2w ago',
      rule('Next'),
      '▸ #29 Issue 29',
      '▸ ',
      '#29 ',
      '      ',
      'docs · opened 3w ago',
      rule('Queue (3)'),
      '  #37 Issue 37',
      '  ',
      '#37 ',
      '      ',
      'v1.2 · prio/high · opened 7d ago',
      '  #51 Issue 51',
      '  ',
      '#51 ',
      '      ',
      'v1.2 · opened 6d ago',
      '⊘ #33 Issue 33',
      '⊘ ',
      '#33 ',
      '      ',
      'blocked by #37 · opened 4w ago',
      '─'.repeat(50),
      'git.example.org/',
      'boats/radar',
      '5 open · ',
      '1 yours',
    ])
    expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 1 in progress, next is #29.' }))
  })
}

test('rows carry their section\'s mark, Next is bold and a blocked issue is dimmed', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(all.find(t => t.text === '▸ #29 Issue 29')?.props.bold).toBe(true)
  expect(all.find(t => t.text === '⊘ #33 Issue 33')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '  #37 Issue 37')?.props.dimColor).toBe(false)
  // Each row starts with its section's mark: In progress, Next, blocked.
  expect(all.find(t => t.text === '● ')?.props.color).toBe('success')
  expect(all.find(t => t.text === '▸ ')?.props.color).toBe('warning')
  expect(all.find(t => t.text === '⊘ ')?.props.color).toBe('inactive')
})

type Found = { key: string; props: Record<string, unknown> }
const focused = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) =>
  ((await ui.findAll({ type: 'Button' })) as Found[]).filter(b => b.props.autoFocus).map(b => b.key)

test('the focus starts on Next, so Enter opens it', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await focused(ui)).toEqual(['pick-29'])
})

test('with no Next, the focus starts on nothing', TOKEN, async ($, on) => {
  world(on, { open: [[issue(33, '2026-09-11T09:00:00Z'), issue(37, '2026-10-02T09:00:00Z')]], deps: { 33: [37], 37: [35] } })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await focused(ui)).toEqual([])
})

test('dependencies are checked oldest first, only until Next is found', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, REPO, asked)
  await $.command.run(RUN)

  const checked = asked.map(u => /\/issues\/(\d+)\/dependencies$/.exec(new URL(u).pathname)?.[1]).filter(Boolean)
  expect(checked).toEqual(['33', '29'])
})

test('everything blocked: Nothing ready, and what it waits on', TOKEN, async ($, on) => {
  const clock = world(on, {
    open: [[issue(33, '2026-09-11T09:00:00Z'), issue(34, '2026-09-12T09:00:00Z'), issue(37, '2026-10-02T09:00:00Z')]],
    deps: { 33: [37], 34: [37, 35], 37: [35] },
  })
  await clock.set(NOW)
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('Nothing ready')
  expect(all).toContain('#33, #34, #37 wait on #35, #37')
  expect(all).toContain(rule('Queue (3)'))
  expect(all).toContain('blocked by #37, #35 · opened 3w ago')
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 0 in progress, nothing ready.' }))
})

test('nothing assigned to you: says how to start', TOKEN, async ($, on) => {
  world(on, { open: [[issue(29, '2026-09-18T09:00:00Z')]] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain(rule('In progress (0)'))
  expect(all).toContain('Nothing in progress. Assign yourself an issue to start.')
  expect(all).toContain('▸ #29 Issue 29')
  expect(all.some(t => t.startsWith('── Queue'))).toBe(false)
})

test('only your issues open: no other open issues', TOKEN, async ($, on) => {
  world(on, { mine: [[MINE]], open: [[MINE]] })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('No other open issues.')
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 1 in progress, nothing else open.' }))
})

test('no open issues at all: says so, without sections', TOKEN, async ($, on) => {
  world(on, { open: [[issue(60, '2026-09-01T09:00:00Z', { assignees: ['jdoe'] })]] })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('No open issues in boats/radar.')
  expect(all.some(t => t.startsWith('── '))).toBe(false)
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: no open issues.' }))
})

test('dependencies turned off: the oldest unassigned issue is Next', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, { ...REPO, deps: 'off' }, asked)
  const out = await $.command.run(RUN)

  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 1 in progress, next is #33.' }))
  expect(asked.filter(u => u.endsWith('/dependencies'))).toHaveLength(1)
})

test('reads every page of both lists', TOKEN, async ($, on) => {
  const asked: string[] = []
  const elsewhere = Array.from({ length: 50 }, (_, k) => issue(100 + k, '2026-09-01T00:00:00Z', { repo: 'boats/other' }))
  const taken = Array.from({ length: 50 }, (_, k) => issue(200 + k, '2026-09-01T00:00:00Z', { assignees: ['jdoe'] }))
  world(on, { mine: [elsewhere, [MINE]], open: [taken, [MINE, issue(7, '2026-09-01T00:00:00Z')]] }, asked)

  const out = await $.command.run(RUN)

  const pages = (path: string) => asked.filter(u => new URL(u).pathname.endsWith(path)).map(u => new URL(u).searchParams.get('page'))
  expect(pages('/repos/issues/search')).toEqual(['1', '2'])
  expect(pages('/repos/boats/radar/issues')).toEqual(['1', '2'])
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 1 in progress, next is #7.' }))
})

test('a failed list says why', TOKEN, async ($, on) => {
  world(on, { openStatus: 500 })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('Could not load the issues: open issues: HTTP 500.')
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar, but could not load its issues.' }))
})

test('clicking an issue in the queue opens its detail, and back returns', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'pick-51' })
  const back = (await ui.find({ key: 'back' })) as unknown as { props: Record<string, unknown> }
  expect(back.props.label).toBe("← What's next")
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe("What's next")
})

test('the repo line sits at the bottom of the pane, however long the list', TOKEN, async ($, on) => {
  world(on, { open: [Array.from({ length: 30 }, (_, k) => issue(200 + k, '2026-09-01T00:00:00Z'))] })

  await $.command.run(RUN)
  const rows = 12
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  const boxes = await ui.findAll({ type: 'Box' })
  expect((boxes[0] as unknown as { props: { height?: number } }).props.height).toBe(rows)
  const list = boxes.find(b => b.key === 'list') as unknown as { props: Record<string, unknown> }
  expect(list.props).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }))
  expect((await texts(ui)).slice(-4)).toEqual(['git.example.org/', 'boats/radar', '30 open · ', '0 yours'])
})

// A list taller than the pane is cut at its bottom; the section rules and the
// repo line keep their row instead of being squeezed out.
test('the repo line names the repo and counts the open issues, yours in green', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(all.find(t => t.text === 'git.example.org/')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === 'boats/radar')?.props.bold).toBe(true)
  expect(all.find(t => t.text === '5 open · ')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '1 yours')?.props.color).toBe('success')
})

test('the section rules and the repo line keep their row when the list is too long', TOKEN, async ($, on) => {
  const mine = Array.from({ length: 5 }, (_, k) => issue(100 + k, '2026-09-01T00:00:00Z', { assignees: ['alice'] }))
  const free = Array.from({ length: 30 }, (_, k) => issue(200 + k, '2026-09-02T00:00:00Z'))
  world(on, { mine: [mine], open: [[...mine, ...free]] })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } }, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  for (const key of ['in-progress', 'next', 'queue', 'where-rule', 'where']) {
    expect(boxes.find(b => b.key === key)?.props.flexShrink).toBe(0)
  }
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the title row holds Refresh on ${surface}`, TOKEN, async ($, on) => {
    const asked: string[] = []
    world(on, REPO, asked)

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await texts(ui))[0]).toBe("What's next")
    const button = (await ui.find({ key: 'refresh' })) as unknown as { props: Record<string, unknown> }
    expect(button.props).toEqual(expect.objectContaining({ label: 'Refresh', hotkey: 'r' }))
    const before = asked.length
    await ui.press({ key: 'refresh' })
    expect(asked.length).toBeGreaterThan(before)
  })
}

test('long titles are cut to one line, and numbers of any width line up', TOKEN, async ($, on) => {
  const long = { ...issue(1000, '2026-09-02T00:00:00Z'), title: 'A title far too long to fit on one line of a narrow pane' }
  world(on, { open: [[issue(7, '2026-09-01T00:00:00Z'), long]] })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('▸    #7 Issue 7')
  const long1000 = all.find(t => t.startsWith('  #1000 A title far too'))
  expect(long1000?.endsWith('…')).toBe(true)
  expect(long1000?.length).toBe(30)
})

const row = (number: number): IssueRow => ({
  number,
  title: `Issue ${number}`,
  milestone: null,
  labels: [],
  created: '2026-09-01T00:00:00Z',
  url: '',
  body: '',
})

test('pickNext: the first unblocked issue, the rest unchecked', async () => {
  const checked: number[] = []
  const got = await pickNext([row(1), row(2), row(3), row(4)], async n => {
    checked.push(n)
    return n === 1 ? [9] : []
  })
  expect(got.next?.number).toBe(2)
  expect(got.queue.map(i => i.number)).toEqual([3, 4])
  expect(got.blocked).toEqual([{ issue: row(1), by: [9] }])
  expect(checked).toEqual([1, 2])
})

test('pickNext: nothing to pick from', async () => {
  expect(await pickNext([], async () => [])).toEqual({ next: null, queue: [], blocked: [] })
})

test('waitingText: one issue waits, several wait', () => {
  expect(waitingText([{ issue: row(33), by: [37] }])).toBe('#33 waits on #37')
  expect(waitingText([{ issue: row(33), by: [37] }, { issue: row(34), by: [37] }])).toBe('#33, #34 wait on #37')
})
