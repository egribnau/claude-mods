import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { readable } from '../hooks/issue'
import { order, pickNext, waitingText, type OrderBy, type Scoped } from '../hooks/next'
import type { IssueRow } from '../types'

const PANE = {
  plugin: 'whats-next',
  component: 'Pane',
  requestId: 'next',
  props: {
    title: "What's Next",
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

type Extra = { milestone?: string; labels?: string[]; assignees?: string[]; repo?: string; colors?: Record<string, string>; due?: string }

function issue(number: number, created: string, extra: Extra = {}) {
  const repo = extra.repo ?? 'boats/radar'
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    created_at: created,
    due_date: extra.due ?? null,
    html_url: `https://git.example.org/${repo}/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name, color: extra.colors?.[name] ?? '' })),
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
  // The repo's open milestones; left out, the list is refused.
  milestones?: unknown[]
  // Your closed issues, as the repo's closed list answers them, and the
  // issues that depend on each issue (an epic depends on its children).
  closed?: unknown[]
  blocks?: Record<number, unknown[]>
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
    const blocks = /\/issues\/(\d+)\/blocks$/.exec(url.pathname)
    if (blocks) return reply(200, w.blocks?.[Number(blocks[1])] ?? [])
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5+gitea-1.22.0' })
    if (url.pathname.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/repos/issues/search')) return reply(200, w.mine?.[page] ?? [])
    if (url.pathname.endsWith('/repos/boats/radar/issues') && url.searchParams.get('state') === 'closed') {
      const ms = url.searchParams.get('milestones')
      return reply(200, (w.closed ?? []).filter(i => ms === null || (i as { milestone: { title: string } | null }).milestone?.title === ms))
    }
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
    if (url.pathname.endsWith('/repos/boats/radar/milestones') && w.milestones) return reply(200, page === 0 ? w.milestones : [])
    if (url.pathname.endsWith('/repos/boats/radar')) return reply(200, { full_name: 'boats/radar', open_issues_count: 9 })
    return reply(404, { message: 'not found' })
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const rule = (name: string) => `── ${name} `.padEnd(50, '─')
// A rule's text, then its parts: `── `, the name, ` · ` and each part after
// it, and the line.
const ruleTexts = (name: string, ...after: string[]) => {
  const full = rule([name, ...after].join(' · '))
  const used = 3 + name.length + after.reduce((n, x) => n + 3 + x.length, 0) + 1
  return [full, '── ', name, ...after.flatMap(x => [' · ', x]), ` ${'─'.repeat(Math.max(0, 50 - used))}`]
}

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
      ...ruleTexts('In progress', '1'),
      '● #42 Issue 42',
      '● ',
      '#42 ',
      '      ',
      'v1.2 · bug · ✎ 2w',
      'v1.2',
      ' · ',
      'bug',
      ' · ',
      '✎ 2w',
      // You work in v1.2 (#42 is yours there): its issues come first.
      ...ruleTexts('Next', 'in v1.2'),
      '○ #37 Issue 37',
      '○ ',
      '#37 ',
      '      ',
      '↦ 1 · v1.2 · prio/high · ✎ 7d',
      '↦ 1',
      ' · ',
      'v1.2',
      ' · ',
      'prio/high',
      ' · ',
      '✎ 7d',
      ...ruleTexts('Queue', 'in v1.2'),
      '○ #51 Issue 51',
      '○ ',
      '#51 ',
      '      ',
      'v1.2 · ✎ 6d',
      'v1.2',
      ' · ',
      '✎ 6d',
      ...ruleTexts('Queue'),
      '○ #29 Issue 29',
      '○ ',
      '#29 ',
      '      ',
      'docs · ✎ 3w',
      'docs',
      ' · ',
      '✎ 3w',
      '⊘ #33 Issue 33',
      '⊘ ',
      '#33 ',
      'Issue 33',
      '      ',
      '⊘ 1 · ✎ 4w',
      '⊘ 1',
      ' · ',
      '✎ 4w',
      '─'.repeat(50),
      '5 open · 1 yours',
      '5 open',
      ' · ',
      '1 yours',
    ])
    expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #37, in v1.2." }))
  })
}

test('the mark says how a row stands for you; Next is bold; a blocked row dims its mark and title, not its number', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(all.find(t => t.text === '○ #37 Issue 37')?.props.bold).toBe(true)
  // Yours is green; available, Next and the Queue, is ○ plain; blocked is dim, never grey.
  expect(all.find(t => t.text === '● ')?.props.color).toBe('success')
  const marks = all.filter(t => t.text === '○ ')
  expect(marks.length).toBe(3)
  expect(marks.every(t => t.props.color === undefined && t.props.dimColor === undefined)).toBe(true)
  expect(all.find(t => t.text === '⊘ ')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '⊘ ')?.props.color).toBeUndefined()
  expect(all.find(t => t.text === '#33 ')?.props.color).toBe('suggestion')
  expect(all.find(t => t.text === 'Issue 33')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '○ #29 Issue 29')?.props.dimColor).toBeUndefined()
  // What blocks it: a count, dim, as unblocks; which ones, the detail.
  expect(all.find(t => t.text === '⊘ 1')?.props.dimColor).toBe(true)
  expect(all.some(t => t.text === '#37')).toBe(false)
})

type Found = { key: string; props: Record<string, unknown> }
const focused = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) =>
  ((await ui.findAll({ type: 'Button' })) as Found[]).filter(b => b.props.autoFocus).map(b => b.key)

test('nothing has the focus at first, not even Next: Tab or an arrow moves it', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await focused(ui)).toEqual([])
})

test('with no Next, the focus starts on nothing', TOKEN, async ($, on) => {
  world(on, { open: [[issue(33, '2026-09-11T09:00:00Z'), issue(37, '2026-10-02T09:00:00Z')]], deps: { 33: [37], 37: [35] } })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await focused(ui)).toEqual([])
})

test('dependencies are checked in the order of where you work, past Next through the Queue', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, REPO, asked)
  await $.command.run(RUN)

  // v1.2 first, where your #42 is; then the rest, oldest first.
  const checked = asked.map(u => /\/issues\/(\d+)\/dependencies$/.exec(new URL(u).pathname)?.[1]).filter(Boolean)
  expect(checked).toEqual(['37', '51', '33', '29'])
})

test('the Queue holds 10 checked issues, a blocked one at the bottom, the rest counted', TOKEN, async ($, on) => {
  const asked: string[] = []
  const day = (k: number) => `2026-09-${String(k).padStart(2, '0')}T09:00:00Z`
  // #1 to #25, oldest first; #3, after Next, waits on #99.
  world(on, { open: [Array.from({ length: 25 }, (_, k) => issue(k + 1, day(k + 1)))], deps: { 3: [99] } }, asked)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('○  #1 Issue 1')
  // The Queue's rule has no count: what the limit leaves out is the line under it.
  expect(all).toContain(rule('Queue'))
  expect(all.some(t => /Queue · \d+/.test(t))).toBe(false)
  // Next, #1, has no mark of its own either: the Queue follows it.
  const free = all.filter(t => /^○ {1,2}#\d+ Issue \d+$/.test(t)).map(t => Number(/#(\d+)/.exec(t)?.[1]))
  expect(free).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(all).toContain('  and 13 more')
  expect(all.indexOf('⊘  #3 Issue 3')).toBeGreaterThan(all.indexOf('  and 13 more'))
  expect(all).toContain('25 open · 0 yours')
  // Next and the 11 issues past it are checked; #13 to #25 are not.
  const checked = asked.map(u => /\/issues\/(\d+)\/dependencies$/.exec(new URL(u).pathname)?.[1]).filter(Boolean)
  expect(checked).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
})

test('a second line too long for the pane is cut at its end, its indent kept', TOKEN, async ($, on) => {
  world(on, {
    open: [[issue(15, '2026-09-01T09:00:00Z'), issue(26, '2026-09-02T09:00:00Z', { labels: ['documentation', 'enhancement', 'good first issue', 'help wanted'] })]],
    deps: { 26: [20, 21, 22, 23, 24, 25] },
  })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await texts(ui)).some(t => t.startsWith('⊘ 6 · documentation, enhancement'))).toBe(true)
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  const indents = boxes.filter(b => b.key === 'indent')
  expect(indents.length).toBeGreaterThan(0)
  for (const b of indents) expect(b.props.flexShrink).toBe(0)
})

test('everything blocked: Nothing available, and what it waits on', TOKEN, async ($, on) => {
  const clock = world(on, {
    open: [[issue(33, '2026-09-11T09:00:00Z'), issue(34, '2026-09-12T09:00:00Z'), issue(37, '2026-10-02T09:00:00Z')]],
    deps: { 33: [37], 34: [37, 35], 37: [35] },
  })
  await clock.set(NOW)
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('Nothing available')
  expect(all).toContain('#33, #34, #37 wait on #35, #37')
  expect(all).toContain(rule('Queue'))
  expect(all).toContain('⊘ 2 · ✎ 3w')
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 0 in progress, nothing available." }))
})

test('nothing assigned to you: says how to start', TOKEN, async ($, on) => {
  world(on, { open: [[issue(29, '2026-09-18T09:00:00Z')]] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain(rule('In progress · 0'))
  expect(all).toContain('Nothing in progress. Assign yourself an issue to start.')
  expect(all).toContain('○ #29 Issue 29')
  expect(all.some(t => t.startsWith('── Queue'))).toBe(false)
})

test('only your issues open: no other open issues', TOKEN, async ($, on) => {
  world(on, { mine: [[MINE]], open: [[MINE]] })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('No other open issues.')
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, nothing else open." }))
})

test('no open issues at all: says so, without sections', TOKEN, async ($, on) => {
  world(on, { open: [[issue(60, '2026-09-01T09:00:00Z', { assignees: ['jdoe'] })]] })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('No open issues in boats/radar.')
  expect(all.some(t => t.startsWith('── '))).toBe(false)
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: no open issues." }))
})

test('dependencies that answer nothing: the first in order is Next, and no other is asked', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, { ...REPO, deps: 'off' }, asked)
  const out = await $.command.run(RUN)

  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #37, in v1.2." }))
  expect(asked.filter(u => u.endsWith('/dependencies'))).toHaveLength(1)
})

test('reads every page of both lists', TOKEN, async ($, on) => {
  const asked: string[] = []
  const elsewhere = Array.from({ length: 50 }, (_, k) => issue(100 + k, '2026-09-01T00:00:00Z', { repo: 'boats/other' }))
  const taken = Array.from({ length: 50 }, (_, k) => issue(200 + k, '2026-09-01T00:00:00Z', { assignees: ['jdoe'] }))
  world(on, { mine: [elsewhere, [MINE]], open: [taken, [MINE, issue(7, '2026-09-01T00:00:00Z')]] }, asked)

  const out = await $.command.run(RUN)

  // The epics are asked for on the same path, by label, and your last
  // closed issue by state; they are not counted here.
  const pages = (path: string) =>
    asked
      .filter(u => new URL(u).pathname.endsWith(path) && !new URL(u).searchParams.has('labels') && new URL(u).searchParams.get('state') !== 'closed')
      .map(u => new URL(u).searchParams.get('page'))
  expect(pages('/repos/issues/search')).toEqual(['1', '2'])
  expect(pages('/repos/boats/radar/issues')).toEqual(['1', '2'])
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #7." }))
})

test('a failed list says why', TOKEN, async ($, on) => {
  world(on, { openStatus: 500 })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('Could not load the issues: open issues: HTTP 500.')
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar, but could not load its issues." }))
})

test('clicking an issue in the queue opens its detail, and back returns', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'pick-51' })
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe("What's next")
  await expect(ui.find({ key: 'pick-51' })).resolves.toBeDefined()
})

test('the bottom line sits at the bottom of the pane, however long the list', TOKEN, async ($, on) => {
  world(on, { open: [Array.from({ length: 30 }, (_, k) => issue(200 + k, '2026-09-01T00:00:00Z'))] })

  await $.command.run(RUN)
  const rows = 12
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  const boxes = await ui.findAll({ type: 'Box' })
  expect((boxes[0] as unknown as { props: { height?: number } }).props.height).toBe(rows)
  const list = boxes.find(b => b.key === 'list') as unknown as { props: Record<string, unknown> }
  expect(list.props).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }))
  expect((await texts(ui)).slice(-4)).toEqual(['30 open · 0 yours', '30 open', ' · ', '0 yours'])
})

// A list taller than the pane is cut at its bottom; the section rules and the
// repo line keep their row instead of being squeezed out.
test('the bottom line counts the open issues, yours in green, and leaves the repo out', TOKEN, async ($, on) => {
  world(on, REPO)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(all.some(t => t.text.includes('git.example.org') || t.text === 'boats/radar')).toBe(false)
  expect(all.find(t => t.text === '5 open')?.props.dimColor).toBe(true)
  expect(all.find(t => t.text === '1 yours')?.props.color).toBe('success')
})

test('the section rules and the bottom line keep their row when the list is too long', TOKEN, async ($, on) => {
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

// The manifest as $.fs.read finds it under the plugin's folder; `read`
// collects the paths asked for.
function manifest(on: On, version: string, read: string[] = []) {
  on('fs.read', (_$, e) => {
    read.push(e.path)
    return e.path.endsWith('/.claude-plugin/plugin.json') ? { value: JSON.stringify({ name: 'whats-next', version }) } : { deny: 'not here' }
  })
}

type Node = { key: string; type: string; text?: string; props: Record<string, unknown>; children?: Node[] }

test("the bottom line ends in What's Next's version from its manifest, dim, read once", TOKEN, async ($, on) => {
  const read: string[] = []
  world(on, REPO)
  manifest(on, '9.8.7', read)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })

  const found = (await ui.findAll({ type: 'Text' })) as unknown as Node[]
  const v = found.find(t => t.text === '  v9.8.7')
  expect(v?.props.dimColor).toBe(true)
  const all = found.map(t => t.text)
  expect(all.indexOf('  v9.8.7')).toBeGreaterThan(all.findIndex(t => t?.endsWith(' yours')))
  expect(read.filter(p => p.endsWith('plugin.json'))).toHaveLength(1)
})

test('on a narrow pane the counts are cut and the version keeps its place', TOKEN, async ($, on) => {
  world(on, REPO)
  manifest(on, '9.8.7')
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 20 }, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Node[]
  expect(boxes.find(b => b.key === 'ours')?.props.flexShrink).toBe(0)
  const texts = (await ui.findAll({ type: 'Text' })) as unknown as Node[]
  // The counts are one text, cut once at its end.
  expect(texts.find(t => t.text === '5 open · 1 yours')?.props.wrap).toBe('truncate-end')
})

test('a manifest that cannot be read leaves the version out', TOKEN, async ($, on) => {
  world(on, REPO)
  on('fs.read', () => ({ deny: 'no such file' }))
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await expect(ui.find({ key: 'ours' })).resolves.toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the title row holds the menu, with Refresh in it and on r, on ${surface}`, TOKEN, async ($, on) => {
    const asked: string[] = []
    world(on, REPO, asked)

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await texts(ui))[0]).toBe("What's next")
    const menu = (await ui.find({ key: 'menu' })) as unknown as { props: Record<string, unknown> }
    expect(menu.props.label).toBe('☰')
    // Refresh hidden, for its hotkey.
    const button = (await ui.find({ key: 'refresh' })) as unknown as { props: Record<string, unknown> }
    expect(button.props).toEqual(expect.objectContaining({ label: 'Refresh', hotkey: 'r' }))
    const before = asked.length
    await ui.press({ key: 'refresh' })
    expect(asked.length).toBeGreaterThan(before)

    // The menu open: Refresh a line in it, which refreshes and shuts the menu.
    await expect(ui.find({ key: 'menu-refresh' })).resolves.toBeUndefined()
    await ui.press({ key: 'menu' })
    expect((await texts(ui)).some(t => t.startsWith('Refresh') && t.trimEnd().endsWith(' r'))).toBe(true)
    const again = asked.length
    await ui.press({ key: 'menu-refresh' })
    expect(asked.length).toBeGreaterThan(again)
    await expect(ui.find({ key: 'menu-refresh' })).resolves.toBeUndefined()
  })
}

test('long titles are cut to one line, and numbers of any width line up', TOKEN, async ($, on) => {
  const long = { ...issue(1000, '2026-09-02T00:00:00Z'), title: 'A title far too long to fit on one line of a narrow pane' }
  world(on, { open: [[issue(7, '2026-09-01T00:00:00Z'), long]] })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('○    #7 Issue 7')
  const long1000 = all.find(t => t.startsWith('○ #1000 A title far too'))
  expect(long1000?.endsWith('…')).toBe(true)
  expect(long1000?.length).toBe(30)
})

const MILESTONES = [
  { title: 'v1.3', due_on: '2026-11-30T00:00:00Z', open_issues: 4, closed_issues: 0 },
  { title: 'v1.2', due_on: '2026-10-31T00:00:00Z', open_issues: 3, closed_issues: 9 },
]
type Btn = { key: string; props: Record<string, unknown> }
const pickerLabel = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
  ((await ui.find({ key: 'milestone' })) as Btn | undefined)?.props.label

test('starts where you work, and every section keeps to it', TOKEN, async ($, on) => {
  const clock = world(on, { ...REPO, milestones: MILESTONES })
  await clock.set(NOW)
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(await pickerLabel(ui)).toBe('v1.2 ▾')
  expect(all).toContain(rule('In progress · 1'))
  expect(all).toContain(rule('Next'))
  expect(all).toContain(rule('Queue'))
  expect(all).toContain('○ #37 Issue 37')
  expect(all.some(t => t.includes('#29') || t.includes('#33'))).toBe(false)
  expect(all.slice(-4)).toEqual(['3 open · 1 yours', '3 open', ' · ', '1 yours'])
  // The milestone picked is not repeated under every issue.
  expect(all).toContain('bug · ✎ 2w')
  expect(all.some(t => t.startsWith('v1.2 · '))).toBe(false)
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #37 (v1.2)." }))
})

test('picking No milestone shows the issues without one, and All shows every one', TOKEN, async ($, on) => {
  world(on, { ...REPO, milestones: MILESTONES })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-none' })
  let all = await texts(ui)
  expect(await pickerLabel(ui)).toBe('None ▾')
  expect(all).toContain(rule('In progress · 0'))
  expect(all).toContain('○ #29 Issue 29')
  expect(all).toContain('⊘ #33 Issue 33')

  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-all' })
  all = await texts(ui)
  expect(all).toContain(rule('In progress · 1'))
  expect(all).toContain(rule('Queue'))
})

for (const rows of [60, 12]) {
  test(`the picker stays in the title row on All and No milestone, ${rows} rows high`, TOKEN, async ($, on) => {
    const many = Array.from({ length: 30 }, (_, k) => issue(300 + k, '2026-09-20T00:00:00Z'))
    world(on, { ...REPO, open: [[...(REPO.open?.[0] ?? []), ...many]], milestones: MILESTONES })
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
    for (const [pick, label] of [['none', 'None ▾'], ['all', 'All ▾'], ['m:v1.2', 'v1.2 ▾']] as const) {
      await ui.press({ key: 'milestone' })
      await ui.press({ key: `milestone-${pick}` })
      expect(await pickerLabel(ui)).toBe(label)
      // The title row and the picker's list sit in one block that keeps its rows.
      const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Btn[]
      expect(boxes.find(b => b.key === 'top')?.props.flexShrink).toBe(0)
    }
  })
}

test('a milestone with nothing open in it says so', TOKEN, async ($, on) => {
  world(on, { open: [[issue(29, '2026-09-18T09:00:00Z', { milestone: 'v1.2' })]], milestones: MILESTONES })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // v1.3 has no open issue, so the picker does not offer it and v1.2 is first.
  expect(await pickerLabel(ui)).toBe('v1.2 ▾')
  await ui.press({ key: 'milestone' })
  const keys = ((await ui.findAll({ type: 'Button' })) as unknown as Btn[]).map(b => b.key).filter(k => k.startsWith('milestone-'))
  expect(keys).toEqual(['milestone-m:v1.2', 'milestone-all'])
})

test('switching milestones asks Forgejo only for dependencies it has not checked', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, { ...REPO, milestones: MILESTONES }, asked)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const pick of ['none', 'm:v1.2', 'none']) {
    await ui.press({ key: 'milestone' })
    await ui.press({ key: `milestone-${pick}` })
  }
  const deps = asked.map(u => /\/issues\/(\d+)\/dependencies$/.exec(new URL(u).pathname)?.[1]).filter(Boolean)
  expect(deps).toEqual(['37', '51', '33', '29'])
  expect(asked.filter(u => new URL(u).pathname.endsWith('/milestones') && new URL(u).searchParams.get('state') === 'open')).toHaveLength(1)
})

test('labels under an issue are text in their own colour, the rest of the line dim', TOKEN, async ($, on) => {
  world(on, { open: [[issue(29, '2026-09-18T09:00:00Z', { milestone: 'v1.2', labels: ['bug', 'docs'], colors: { bug: 'e57373' } })]] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(found.some(t => t.text.startsWith('v1.2 · bug, docs · ✎ '))).toBe(true)
  expect(found.find(t => t.text === 'bug')?.props.color).toBe('#e57373')
  // A label without a colour stays dim, as does the rest of the line.
  expect(found.find(t => t.text === 'docs')?.props.dimColor).toBe(true)
  expect(found.find(t => t.text === 'v1.2')?.props.dimColor).toBe(true)
})

// The facts line's recipe (DRAWING-issue.md, The facts line).
test('the facts line: what blocks it, what it unblocks, its due date, milestone, labels and age, in that order; a blocked row keeps them all', TOKEN, async ($, on) => {
  const clock = world(on, {
    open: [
      [
        issue(33, '2026-09-11T09:00:00Z', { milestone: 'v1.2', labels: ['docs'], due: '2026-10-02T00:00:00Z' }),
        issue(29, '2026-09-18T09:00:00Z', { milestone: 'v1.2', labels: ['bug'], due: '2026-10-14T00:00:00Z' }),
        issue(37, '2026-10-02T09:00:00Z', { due: '2026-11-30T00:00:00Z' }),
        issue(40, '2026-10-03T09:00:00Z'),
      ],
    ],
    deps: { 33: [37] },
  })
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  const all = found.map(t => t.text)
  expect(all).toContain('⊘ 1 · ⧗ 2 Oct · v1.2 · docs · ✎ 4w')
  expect(all).toContain('⧗ 14 Oct · v1.2 · bug · ✎ 3w')
  // #33 waits on #37: ↦ 1, dim, before its due date.
  expect(all).toContain('↦ 1 · ⧗ 30 Nov · ✎ 7d')
  expect(found.find(t => t.text === '↦ 1')?.props.dimColor).toBe(true)
  // No due date: nothing, and the line starts with what comes next.
  expect(all).toContain('✎ 6d')
  expect(all.some(t => t.includes('due') || t.includes('opened'))).toBe(false)
  // The due date in its colour: red once passed, amber within 7 days, dim otherwise.
  expect(found.find(t => t.text === '⧗ 2 Oct')?.props.color).toBe('error')
  expect(found.find(t => t.text === '⧗ 14 Oct')?.props.color).toBe('warning')
  expect(found.find(t => t.text === '⧗ 30 Nov')?.props.dimColor).toBe(true)
  // ⊘ and the count dim, as ↦; the age dim.
  expect(found.find(t => t.text === '⊘ 1')?.props.dimColor).toBe(true)
  expect(found.some(t => t.text === '#37')).toBe(false)
  expect(found.find(t => t.text === '✎ 4w')?.props.dimColor).toBe(true)
})

test('readable: a light colour stays, a dark one is lightened, keeping its hue', () => {
  expect(readable('e57373')).toBe('#e57373')
  const lighter = readable('1d4ed8') ?? ''
  const [r, g, b] = [1, 3, 5].map(k => Number.parseInt(lighter.slice(k, k + 2), 16))
  expect(0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0)).toBeGreaterThanOrEqual(110)
  expect((b ?? 0) > (r ?? 0)).toBe(true)
  expect(readable('')).toBeUndefined()
})

const row = (number: number): IssueRow => ({
  number,
  title: `Issue ${number}`,
  milestone: null,
  labels: [],
  created: '2026-09-01T00:00:00Z',
  due: null,
  url: '',
  body: '',
  updated: '2026-09-01T00:00:00Z',
})

test('pickNext: the first unblocked issue, then the Queue checked too', async () => {
  const checked: number[] = []
  const got = await pickNext([row(1), row(2), row(3), row(4), row(5)], async n => {
    checked.push(n)
    return n === 1 ? [9] : n === 4 ? [7] : []
  })
  expect(got.next?.number).toBe(2)
  expect(got.queue.map(i => i.number)).toEqual([3, 5])
  expect(got.blocked).toEqual([
    { issue: row(1), by: [9] },
    { issue: row(4), by: [7] },
  ])
  expect(got.more).toBe(0)
  expect(checked).toEqual([1, 2, 3, 4, 5])
})

test('pickNext: the Queue stops at its limit, the rest counted and not checked', async () => {
  const checked: number[] = []
  const free = Array.from({ length: 30 }, (_, k) => row(k + 1))
  const got = await pickNext(free, async n => {
    checked.push(n)
    return []
  })
  expect(got.next?.number).toBe(1)
  expect(got.queue.map(i => i.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  expect(got.more).toBe(19)
  expect(checked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('pickNext: a blocked one past Next makes room for the next free one; at most twice the limit are checked', async () => {
  const checked: number[] = []
  const free = Array.from({ length: 40 }, (_, k) => row(k + 1))
  const got = await pickNext(free, async n => {
    checked.push(n)
    return n % 4 === 0 ? [99] : []
  })
  // #4, #8 and #12 are blocked, so the tenth free one is #14.
  expect(got.queue.map(i => i.number)).toEqual([2, 3, 5, 6, 7, 9, 10, 11, 13, 14])
  expect(got.blocked.map(b => b.issue.number)).toEqual([4, 8, 12])
  expect(checked).toHaveLength(14)
  expect(got.more).toBe(26)

  // All blocked past Next: #2 to #21 are checked, the rest counted.

  const stuck = await pickNext(free, async n => (n === 1 ? [] : [99]))
  expect(stuck.queue).toEqual([])
  expect(stuck.blocked).toHaveLength(20)
  expect(stuck.more).toBe(19)
})

test('pickNext: nothing to pick from', async () => {
  expect(await pickNext([], async () => [])).toEqual({ next: null, queue: [], blocked: [], more: 0 })
})

test('waitingText: one issue waits, several wait', () => {
  expect(waitingText([{ issue: row(33), by: [37] }])).toBe('#33 waits on #37')
  expect(waitingText([{ issue: row(33), by: [37] }, { issue: row(34), by: [37] }])).toBe('#33, #34 wait on #37')
})

// Issues for the order: `created` days into September, a due date, a
// milestone, how many wait on it.
const keyed = (number: number, o: { day?: number; due?: string; milestone?: string; unblocks?: number } = {}): IssueRow => ({
  ...row(number),
  created: `2026-09-${String(o.day ?? 1).padStart(2, '0')}T00:00:00Z`,
  due: o.due ?? null,
  milestone: o.milestone ?? null,
  ...(o.unblocks !== undefined && { unblocks: o.unblocks }),
})
const by = (o: Partial<OrderBy> = {}): OrderBy => ({
  scopes: [],
  milestoneDue: () => null,
  unblocks: i => i.unblocks ?? 0,
  now: NOW,
  ...o,
})
const numbers = (l: { issue: IssueRow }[]) => l.map(o => o.issue.number)

test('order: due soon first, earliest first; a due date past 7 days counts as none', () => {
  const got = order(
    [keyed(1), keyed(2, { due: '2026-10-14T00:00:00Z' }), keyed(3, { due: '2026-10-01T00:00:00Z' }), keyed(4, { due: '2026-12-01T00:00:00Z' })],
    by(),
  )
  // #3 passed, #2 within 7 days; #4 is months off, so as #1: oldest first.
  expect(numbers(got)).toEqual([3, 2, 1, 4])
})

test("order: an issue without a due date takes its milestone's", () => {
  const got = order([keyed(1), keyed(2, { milestone: 'v1.2' })], by({ milestoneDue: t => (t === 'v1.2' ? '2026-10-12T00:00:00Z' : null) }))
  expect(numbers(got)).toEqual([2, 1])
})

test('order: the most unblocked first, then the oldest, then the lowest number', () => {
  const got = order([keyed(5, { day: 3 }), keyed(4, { day: 3 }), keyed(1, { day: 1 }), keyed(9, { day: 9, unblocks: 1 }), keyed(8, { day: 8, unblocks: 3 })], by())
  expect(numbers(got)).toEqual([8, 9, 1, 4, 5])
})

test('order: the scope comes first, then due soon, then unblocks, then age; each issue says its scope', () => {
  const epic: Scoped = { scope: { kind: 'epic', number: 30 }, holds: i => [6, 7].includes(i.number) }
  const ms: Scoped = { scope: { kind: 'milestone', title: 'v1.2' }, holds: i => i.milestone === 'v1.2' }
  const got = order(
    [
      keyed(1, { due: '2026-10-10T00:00:00Z' }),
      keyed(2, { milestone: 'v1.2', unblocks: 2 }),
      keyed(3, { milestone: 'v1.2', day: 2, due: '2026-10-11T00:00:00Z' }),
      keyed(6, { day: 5 }),
      keyed(7, { day: 6, unblocks: 1 }),
    ],
    by({ scopes: [epic, ms] }),
  )
  // The epic: #7 unblocks one; v1.2: #3 due soon beats #2 unblocking two; the rest.
  expect(numbers(got)).toEqual([7, 6, 3, 2, 1])
  expect(got.map(o => o.scope)).toEqual([epic.scope, epic.scope, ms.scope, ms.scope, null])
})

test('order: an issue two scopes hold is taken by the first', () => {
  const inner: Scoped = { scope: { kind: 'epic', number: 30 }, holds: i => i.number === 2 }
  const outer: Scoped = { scope: { kind: 'epic', number: 12 }, holds: i => [1, 2].includes(i.number) }
  const got = order([keyed(1), keyed(2, { day: 9 })], by({ scopes: [inner, outer] }))
  expect(got).toEqual([
    { issue: keyed(2, { day: 9 }), scope: inner.scope },
    { issue: keyed(1), scope: outer.scope },
  ])
})

// Where you work (docs/whats-next/ORDERING.md), on Forgejo. You closed #41
// two hours ago; epic #30, open, depends on it and on #43 and #44.
const closedIssue = (n: number, closedAt: string, extra: Extra = {}) => ({
  ...issue(n, '2026-09-01T09:00:00Z', { ...extra, assignees: ['alice'] }),
  state: 'closed',
  closed_at: closedAt,
})
const EPIC = { ...issue(30, '2026-08-01T09:00:00Z', { labels: ['epic'] }), state: 'open' }
const WORKED: World = {
  open: [
    [
      issue(50, '2026-08-20T09:00:00Z'),
      issue(29, '2026-09-18T09:00:00Z'),
      issue(43, '2026-09-25T09:00:00Z'),
      issue(44, '2026-09-26T09:00:00Z'),
    ],
  ],
  closed: [closedIssue(40, '2026-10-01T09:00:00Z'), closedIssue(41, '2026-10-09T10:00:00Z')],
  blocks: { 41: [EPIC] },
  deps: { 30: [41, 43, 44] },
}

test('Next follows on in the epic of the issue you closed last; the Queue says each scope; Last closed sits above the bottom line', TOKEN, async ($, on) => {
  const asked: string[] = []
  const clock = world(on, WORKED, asked)
  await clock.set(NOW)
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  const all = found.map(t => t.text)

  // #41 has no milestone: the milestone filter starts on No milestone.
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 0 in progress, next is #43, in epic #30 (no milestone)." }))
  expect(all).toContain(rule('Next · in epic #30'))
  expect(all).toContain(rule('Queue · in epic #30'))
  expect(all).toContain(rule('Queue'))
  const order = all.filter(t => /^○ #\d+ Issue \d+$/.test(t)).map(t => Number(/#(\d+)/.exec(t)?.[1]))
  expect(order).toEqual([43, 44, 50, 29])
  expect(all.indexOf(rule('Queue · in epic #30'))).toBeLessThan(all.indexOf('○ #44 Issue 44'))
  expect(all.indexOf(rule('Queue'))).toBeGreaterThan(all.indexOf('○ #44 Issue 44'))
  // The epic's number blue, the words dim.
  expect(found.find(t => t.text === '#30')?.props.color).toBe('suggestion')
  expect(found.find(t => t.text === 'in epic ')?.props.dimColor).toBe(true)

  // Last closed: its rule, then one grey row, ✓ in the mark column, under the list.
  expect(all).toContain(rule('Last closed · 2h ago · in epic #30'))
  const last = found.find(t => t.text === '✓ #41 Issue 41')
  expect(last?.props.color).toBe('inactive')
  expect(all.indexOf('✓ #41 Issue 41')).toBeGreaterThan(all.indexOf('○ #29 Issue 29'))
  expect(all.indexOf('✓ #41 Issue 41')).toBeLessThan(all.indexOf('─'.repeat(50)))
  expect(await ui.find({ key: 'last-closed-open' })).toBeTruthy()

  // Asked: your closed issues, assigned to you; the epic that depends on
  // #41; the epic's children. Once each.
  const closedAsked = asked.filter(u => new URL(u).pathname.endsWith('/issues') && new URL(u).searchParams.get('state') === 'closed')
  expect(closedAsked).toHaveLength(1)
  expect(new URL(closedAsked[0] ?? '').searchParams.get('assigned_by')).toBe('alice')
  expect(asked.filter(u => u.includes('/issues/41/blocks'))).toHaveLength(1)
  expect(asked.filter(u => new URL(u).pathname.endsWith('/issues/30/dependencies'))).toHaveLength(1)
})

test('nothing closed by you: no Last closed, and the rules name no scope', TOKEN, async ($, on) => {
  world(on, { ...WORKED, closed: [] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)
  expect(all.some(t => t.includes('Last closed'))).toBe(false)
  expect(all).toContain(rule('Next'))
  expect(all.some(t => t.includes('in epic'))).toBe(false)
})

test('the milestone filter starts where you work, and /next brings it back there after a choice', TOKEN, async ($, on) => {
  world(on, {
    ...WORKED,
    open: [[issue(29, '2026-09-18T09:00:00Z', { milestone: 'v1.2' }), issue(43, '2026-09-25T09:00:00Z', { milestone: 'v1.3' })]],
    closed: [closedIssue(41, '2026-10-09T10:00:00Z', { milestone: 'v1.3' })],
    milestones: MILESTONES,
  })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // v1.2 is due first, but you closed #41 in v1.3.
  expect(await pickerLabel(ui)).toBe('v1.3 ▾')
  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-all' })
  expect(await pickerLabel(ui)).toBe('All ▾')
  await $.command.run(RUN)
  expect(await pickerLabel(ui)).toBe('v1.3 ▾')
})

test('with Compact on, rows have no empty line between them, but each section still ends in one', { options: { token: 'secret', icons: 'text', compact: 'on' } }, async ($, on) => {
  world(on, { ...WORKED, blocks: { 41: [EPIC], 42: [EPIC] }, mine: [[issue(42, '2026-09-25T09:00:00Z', { assignees: ['alice'] })]], open: [[issue(42, '2026-09-25T09:00:00Z', { assignees: ['alice'] }), ...(WORKED.open?.[0] ?? [])]] })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  const ends = boxes.filter(b => (b.key ?? '').startsWith('end-'))
  // Before Next, before the Queue's first part and before its second: once each.
  expect(ends).toHaveLength(3)
  expect(ends.every(b => b.props.height === 1)).toBe(true)
  expect(boxes.filter(b => (b.key ?? '').startsWith('issue-')).every(b => (b.props.marginBottom ?? 0) === 0)).toBe(true)
})

test('with Compact off, no extra empty line: the rows leave one already', TOKEN, async ($, on) => {
  world(on, WORKED)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string }[]
  expect(boxes.some(b => (b.key ?? '').startsWith('end-'))).toBe(false)
})
