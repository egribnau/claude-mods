import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { whatsNext, type Memory } from '../hooks/load'
import type { Tracker } from '../hooks/tracker'
import type { IssueRow } from '../types'

// The issue detail as #62 drew it: the line under the title, the parent
// first among the facts, Description and Comments that fold, the menu, and
// rows the mod scrolls itself between the top row and the bottom line.

type Engine = Parameters<TestBody>[0]

const PANE = {
  plugin: 'whats-next',
  component: 'Pane',
  requestId: 'next',
  props: {
    title: "What's Next",
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
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
const API = 'https://git.example.org/api/v1/repos/boats/radar'

const LISTED = {
  number: 29,
  title: 'Docs: config keys',
  state: 'open',
  created_at: '2026-09-18T09:00:00Z',
  html_url: 'https://git.example.org/boats/radar/issues/29',
  body: 'Short.',
  milestone: { title: 'v0.3.0' },
  labels: [{ name: 'docs' }],
  repository: { full_name: 'boats/radar' },
}

const EPIC = {
  number: 30,
  title: 'Token handling',
  state: 'open',
  created_at: '2026-09-01T09:00:00Z',
  html_url: 'https://git.example.org/boats/radar/issues/30',
  body: '',
  milestone: null,
  labels: [{ name: 'epic', color: '888888' }],
  repository: { full_name: 'boats/radar' },
}

const ISSUE = {
  number: 29,
  title: 'Docs: config keys',
  state: 'open',
  html_url: 'https://git.example.org/boats/radar/issues/29',
  body: 'One.\nTwo.\nThree.\nFour.\nFive.',
  user: { login: 'alice' },
  created_at: '2026-09-18T09:00:00Z',
  updated_at: '2026-10-07T12:00:00Z',
  comments: 3,
  milestone: { title: 'v0.3.0', due_on: '2026-10-31T00:00:00Z' },
  due_date: null,
  labels: [{ name: 'docs', color: 'e8875c' }],
}

type Answers = Record<string, unknown>

const FULL: Answers = {
  '/issues/29': ISSUE,
  '/issues/29/comments': [
    { user: { login: 'alice' }, created_at: '2026-09-20T12:00:00Z', body: 'Which scopes does a read only token need?' },
    { user: { login: 'maria' }, created_at: '2026-10-02T12:00:00Z', body: 'read:issue and read:repository, I think.' },
    { user: { login: 'jdoe' }, created_at: '2026-10-07T12:00:00Z', body: 'a\nb\nc\nd\ne' },
  ],
  '/issues/29/dependencies': [],
  // Epic #30 depends on #29, as an epic holds its children; #31 waits on it.
  '/issues/29/blocks': [
    { ...EPIC, repository: { full_name: 'boats/radar' } },
    { number: 31, title: 'Release notes', state: 'open', labels: [], repository: { full_name: 'boats/radar' } },
  ],
  '/issues/29/timeline': [],
  '/issues/29/times': [],
  '/issues/30': { ...ISSUE, ...EPIC, user: { login: 'alice' }, comments: 0 },
}

function world(on: On, answers: Answers, opened: string[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (e.argv[0] === 'open') opened.push(cmd)
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5' })
    if (url.pathname.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/api/v1/users/alice/tokens')) {
      return reply(200, [{ name: 'whats-next', token_last_eight: 'secret', scopes: ['write:issue', 'read:repository', 'read:user'] }])
    }
    const page = Number(url.searchParams.get('page') ?? '1')
    if (url.pathname.endsWith('/issues/search')) return reply(200, page === 1 ? [LISTED] : [])
    if (url.pathname.endsWith('/repos/boats/radar/issues')) {
      return reply(200, url.searchParams.get('labels') === 'epic' && page === 1 ? [EPIC] : [])
    }
    const path = e.url.startsWith(API) ? url.pathname.slice(new URL(API).pathname.length) : ''
    if (path === '') {
      return reply(200, {
        full_name: 'boats/radar',
        open_issues_count: 9,
        permissions: { push: true },
        internal_tracker: { enable_time_tracker: true, enable_issue_dependencies: true },
      })
    }
    if (!(path in answers)) return reply(404, { message: 'not found' })
    const answer = answers[path]
    const limit = Number(url.searchParams.get('limit'))
    if (Array.isArray(answer) && limit > 0) return reply(200, answer.slice((page - 1) * limit, page * limit))
    return reply(200, answer)
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const has = (all: string[], want: string) => all.some(t => t === want || t.includes(want))

async function opened($: Engine, rows = 40) {
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  await ui.press({ key: 'pick-29' })
  return ui
}

test('under the title one line: the state, then who opened it and when; the milestone is a fact with its due date', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(NOW)
  const ui = await opened($)
  const all = await texts(ui)
  expect(has(all, 'open · ✎ 3w alice')).toBe(true)
  expect(all.some(t => t.includes('comments') && t.includes('v0.3.0'))).toBe(false)
  expect(all).toContain('Milestone  ')
  expect(has(all, 'v0.3.0 · ⧗ 31 Oct')).toBe(true)
})

test('the epic it is a child of comes first, under Epic, and Blocks leaves that epic out', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(NOW)
  const ui = await opened($)
  const all = await texts(ui)
  expect(all.indexOf('Epic       ')).toBeGreaterThan(-1)
  expect(all.indexOf('Epic       ')).toBeLessThan(all.indexOf('Blocks     '))
  expect(has(all, 'Token handling')).toBe(true)
  // Under Blocks only #31: the epic is the Epic line.
  const blocks = (await ui.findAll({ type: 'Button' })).map(b => (b as unknown as { props: { key: string } }).props.key).filter(k => k.startsWith('follow-'))
  expect(blocks).toEqual(['follow-30', 'follow-31'])
  await ui.press({ key: 'follow-30' })
  expect(has(await texts(ui), 'Token handling')).toBe(true)
  await ui.press({ key: 'back' })
  expect(has(await texts(ui), 'Docs: config keys')).toBe(true)
})

test('Description longer than 3 lines folds: its first 3, how many more, and its rule unfolds the rest', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  let all = await texts(ui)
  expect(all.some(t => t.startsWith('+ ') && all.includes('Description'))).toBe(true)
  expect(all).toContain('Three.')
  expect(all).not.toContain('Four.')
  expect(((await ui.find({ key: 'description-more' })) as { props: { label: string } } | undefined)?.props.label).toBe('… 2 more lines')
  await ui.press({ key: 'description-section' })
  all = await texts(ui)
  expect(all).toContain('Five.')
  await expect(ui.find({ key: 'description-more' })).resolves.toBeUndefined()
})

test('… n more lines under Description unfolds it, as under a comment', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  await ui.press({ key: 'description-more' })
  const all = await texts(ui)
  expect(all).toContain('Five.')
  expect(all.some(t => t.startsWith('− ') && all.includes('Description'))).toBe(true)
})

test('Comments: the newest first and unfolded, each older one a line that unfolds it', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(NOW)
  const ui = await opened($)
  let all = await texts(ui)
  expect(all).toContain('Comments')
  expect(has(all, ' · 2d ago')).toBe(true)
  // The newest, jdoe's: 3 lines and how many more.
  expect(all).toContain('c')
  expect(all).not.toContain('d')
  expect(has(all, ' · 7d ago · read:issue and read:repository, I think.')).toBe(true)
  expect(has(all, ' · 2w ago · Which scopes does a read only token need?')).toBe(true)
  await ui.press({ key: 'comment-more-0' })
  expect(await texts(ui)).toContain('e')
  await ui.press({ key: 'comment-1' })
  all = await texts(ui)
  expect(all).toContain('read:issue and read:repository, I think.')
  // Its line unfolds and folds it again.
  await ui.press({ key: 'comment-1' })
  expect(await texts(ui)).not.toContain('read:issue and read:repository, I think.')
  await ui.press({ key: 'comments-section' })
  expect(has(await texts(ui), '2d ago')).toBe(false)
})

test('Refresh keeps what is unfolded; the issue opened again starts folded', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  await ui.press({ key: 'description-section' })
  await ui.press({ key: 'comment-1' })
  await ui.press({ key: 'refresh' })
  let all = await texts(ui)
  expect(all).toContain('Five.')
  expect(all).toContain('read:issue and read:repository, I think.')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'pick-29' })
  all = await texts(ui)
  expect(all).not.toContain('Five.')
  expect(all).not.toContain('read:issue and read:repository, I think.')
})

test('the top row: [ ← ], Prompt and the menu; the menu lists each action with its hotkey and shuts once one is pressed', TOKEN, async ($, on) => {
  const ran: string[] = []
  world(on, FULL, ran)
  const ui = await opened($)
  const label = async (key: string) => ((await ui.find({ key })) as unknown as { props: { label: string } } | undefined)?.props.label
  expect(await label('back')).toBe('←')
  expect(await label('prompt')).toBe('Prompt')
  expect(await label('menu')).toBe('☰')
  await expect(ui.find({ key: 'menu-open' })).resolves.toBeUndefined()
  await ui.press({ key: 'menu' })
  const all = await texts(ui)
  for (const want of ['Assign Me       a', 'Close           c', 'Open in Browser o', 'Refresh         r']) expect(all).toContain(want)
  await ui.press({ key: 'menu-open' })
  expect(ran).toEqual(['open https://git.example.org/boats/radar/issues/29'])
  await expect(ui.find({ key: 'menu-open' })).resolves.toBeUndefined()
  // The hotkeys work with the menu shut: their Buttons are drawn hidden.
  await ui.press({ key: 'open' })
  expect(ran).toHaveLength(2)
})

test('the lists end their top row in the menu, Refresh its one line', TOKEN, async ($, on) => {
  world(on, FULL)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'menu' })
  expect(await texts(ui)).toContain('Refresh         r')
  await ui.press({ key: 'menu-refresh' })
  await expect(ui.find({ key: 'menu-refresh' })).resolves.toBeUndefined()
})

// The rows Box the detail moves, and where it stands.
async function rowsTop(ui: { find: (q: { key: string }) => Promise<unknown> }) {
  const box = (await ui.find({ key: 'rows' })) as { props: { marginTop: number } } | undefined
  return box?.props.marginTop
}

const scroll = (by: number) =>
  ({ component: 'Pane', requestId: 'next', offset: 0, by, bodyRows: 12, contentRows: 12, origin: { kind: 'person' } }) as const

test('a detail scrolls its own rows, within them; the top row and the bottom line stay', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($, 12)
  expect(await rowsTop(ui)).toBe(-0)
  await $.ui.scroll(scroll(3))
  expect(await rowsTop(ui)).toBe(-3)
  await $.ui.scroll(scroll(-10))
  expect(await rowsTop(ui)).toBe(-0)
  await $.ui.scroll(scroll(500))
  const end = await rowsTop(ui)
  expect(end).toBeLessThan(-3)
  // No further than its last row at the bottom.
  await $.ui.scroll(scroll(1))
  expect(await rowsTop(ui)).toBe(end)
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
  await expect(ui.find({ key: 'where-rule' })).resolves.toBeDefined()
})

test('the focus on a control out of view scrolls it into view; Tab passes over the hidden hotkeys', TOKEN, async ($, on) => {
  world(on, FULL)
  // Where the ring lands, as the engine beneath would put it.
  const landed: (string | undefined)[] = []
  on('ui.focus', (_$, e) => {
    landed.push(e.element)
    return {}
  })
  const ui = await opened($, 12)
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'next', plugin: 'whats-next', element, origin: { kind: 'person' } })
  await focus('comment-2')
  expect(await rowsTop(ui)).toBeLessThan(0)
  await focus('back')
  await focus('description-section')
  const at = await rowsTop(ui)
  await focus('comment-2')
  expect(await rowsTop(ui)).toBeLessThan(at ?? 0)
  // Back to the top: the first fact scrolls back into view.
  await focus('follow-30')
  expect(await rowsTop(ui)).toBeGreaterThanOrEqual(-6)
  // A hidden hotkey's Button: on to Back, the first control; from Back, no further.
  landed.length = 0
  await focus('refresh')
  await focus('back')
  await focus('open')
  expect(landed).toEqual(['back', 'back'])
})

test('↦ leaves out the epic that waits on an issue: it is that issue’s epic', async () => {
  const row = (number: number): IssueRow => ({
    number,
    title: `Issue ${number}`,
    milestone: null,
    labels: [],
    created: '2026-10-01T00:00:00Z',
    due: null,
    url: `fake:${number}`,
    body: '',
    updated: '2026-10-01T00:00:00Z',
  })
  const known: Memory = {
    milestones: [],
    closedMilestones: [],
    mine: [],
    free: [row(29), row(31)],
    taken: [],
    listed: true,
    // Epic #30 and issue #31 both wait on #29.
    blockers: new Map([
      [30, [29]],
      [31, [29]],
    ]),
    epics: [{ number: 30, title: 'Epic', state: 'open', milestone: null, due: null }],
    children: new Map(),
    lastClosed: new Map(),
    parents: new Map(),
    members: new Map(),
  }
  const next = await whatsNext({ nested: false } as unknown as Tracker, known, 'all', false)
  expect(next.unblocks[29]).toBe(1)
})

test('the menu opens over the rows beneath, which stay where they are', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($, 12)
  const before = await texts(ui)
  await ui.press({ key: 'menu' })
  const menu = (await ui.find({ key: 'menu-lines' })) as { props: Record<string, unknown> } | undefined
  expect(menu?.props.position).toBe('absolute')
  // The rows box is no placed box: it moves by its margin.
  expect(((await ui.find({ key: 'rows' })) as { props: Record<string, unknown> }).props.position).toBeUndefined()
  expect(menu?.props.top).toBe(1)
  // The detail's rows are drawn as before, the menu's lines after them.
  const after = await texts(ui)
  expect(after.slice(0, before.length)).toEqual(before)
  expect(await rowsTop(ui)).toBe(-0)
})

test('the focus on the last control scrolls the detail to its end, so the text under it is reached; on the first, to its top', TOKEN, async ($, on) => {
  world(on, {
    ...FULL,
    // One comment, long, with nothing to press after its own line.
    '/issues/29/comments': [{ user: { login: 'jdoe' }, created_at: '2026-10-07T12:00:00Z', body: Array.from({ length: 30 }, (_, k) => `line ${k}`).join('\n') }],
  })
  on('ui.focus', () => ({}))
  const ui = await opened($, 12)
  await ui.press({ key: 'comment-more-0' })
  await $.ui.scroll(scroll(500))
  const end = await rowsTop(ui)
  await $.ui.scroll(scroll(-500))
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'next', plugin: 'whats-next', element, origin: { kind: 'person' } })
  await focus('comment-0')
  expect(await rowsTop(ui)).toBe(end)
  await focus('follow-30')
  expect(await rowsTop(ui)).toBe(-0)
})

test('4 lines show whole, Description and a comment alike: … 1 more line would take the 4th line’s row', TOKEN, async ($, on) => {
  world(on, {
    ...FULL,
    '/issues/29': { ...ISSUE, body: 'One.\nTwo.\nThree.\nFour.' },
    '/issues/29/comments': [{ user: { login: 'jdoe' }, created_at: '2026-10-07T12:00:00Z', body: 'a\nb\nc\nd' }],
  })
  const ui = await opened($)
  const all = await texts(ui)
  expect(all).toContain('Four.')
  expect(all).toContain('d')
  expect(all.some(t => t.startsWith('── Description'))).toBe(true)
  await expect(ui.find({ key: 'description-more' })).resolves.toBeUndefined()
  await expect(ui.find({ key: 'comment-more-0' })).resolves.toBeUndefined()
})
