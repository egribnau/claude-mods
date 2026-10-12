import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { markOf, type Folding, type Standing } from '../hooks/epics'

// The help page (docs/whats-next/DRAWING.md, The help page): one page in
// every pane, opened from Help in the menu, its hotkey h or /next help, in
// place of the list or detail, and left with Back to just that.

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
const EPICS_PANE = { ...PANE, requestId: 'next-epics', props: { ...PANE.props, title: 'Epics' } } as const
const MILESTONES_PANE = { ...PANE, requestId: 'next-milestones', props: { ...PANE.props, title: 'Milestones' } } as const

const run = (args = '') =>
  ({
    command: 'next',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 170 },
  }) as const

const TOKEN = { options: { token: 'secret', icons: 'text', compact: 'off' } }
const NOW = Date.parse('2026-10-09T12:00:00Z')

const LISTED = {
  number: 29,
  title: 'Docs: config keys',
  state: 'open',
  created_at: '2026-09-18T09:00:00Z',
  html_url: 'https://git.example.org/boats/radar/issues/29',
  body: 'Short.',
  milestone: null,
  labels: [],
  repository: { full_name: 'boats/radar' },
}

const EPIC = { ...LISTED, number: 30, title: 'Token handling', labels: [{ name: 'epic', color: '888888' }] }

const ISSUE = {
  ...LISTED,
  user: { login: 'alice' },
  updated_at: '2026-10-07T12:00:00Z',
  comments: 0,
  due_date: null,
  body: Array.from({ length: 60 }, (_, k) => `Line ${k + 1}.`).join('\n'),
}

function world(on: On) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) },
    })
    const page = Number(url.searchParams.get('page') ?? '1')
    const path = url.pathname
    if (path.endsWith('/version')) return reply(200, { version: '16.0.5' })
    if (path.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (path.endsWith('/api/v1/users/alice/tokens')) {
      return reply(200, [{ name: 'whats-next', token_last_eight: 'secret', scopes: ['write:issue', 'read:repository', 'read:user'] }])
    }
    if (path.endsWith('/issues/search')) return reply(200, page === 1 ? [LISTED] : [])
    if (path.endsWith('/repos/boats/radar/issues')) return reply(200, url.searchParams.get('labels') === 'epic' && page === 1 ? [EPIC] : [])
    if (path.endsWith('/repos/boats/radar')) {
      return reply(200, {
        full_name: 'boats/radar',
        open_issues_count: 2,
        permissions: { push: true },
        internal_tracker: { enable_time_tracker: false, enable_issue_dependencies: false },
      })
    }
    if (path.endsWith('/issues/29')) return reply(200, ISSUE)
    if (path.endsWith('/issues/29/comments') || path.endsWith('/issues/29/timeline')) return reply(200, [])
    return reply(404, { message: 'not found' })
  })
  return clock
}

type Node = { text: string; props: Record<string, unknown> }
type Ui = { findAll: (q: { type: string }) => Promise<Node[]>; find: (q: { key: string }) => Promise<unknown> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const has = (all: string[], want: string) => all.some(t => t.includes(want))
const shown = async (ui: Ui) => (await ui.find({ key: 'help-rule-0' })) !== undefined

async function mounted($: Engine, pane: typeof PANE | typeof EPICS_PANE | typeof MILESTONES_PANE = PANE, columns = 60) {
  await $.command.run(run())
  return $.ui.mount({ ...pane, props: { ...pane.props, bodyColumns: columns }, surface: 'terminal' })
}

test('Help is the last line of the menu in every pane, hotkey h, and opens the help page', TOKEN, async ($, on) => {
  world(on)
  for (const pane of [PANE, EPICS_PANE, MILESTONES_PANE]) {
    const ui = await mounted($, pane)
    await ui.press({ key: 'menu' })
    expect(await texts(ui)).toContain('Help            h')
    await ui.press({ key: 'menu-help' })
    expect(await shown(ui)).toBe(true)
    // Its own menu holds Refresh, no Help.
    await ui.press({ key: 'menu' })
    await expect(ui.find({ key: 'menu-refresh' })).resolves.toBeDefined()
    await expect(ui.find({ key: 'menu-help' })).resolves.toBeUndefined()
    await ui.press({ key: 'back' })
    expect(await shown(ui)).toBe(false)
    // The hotkey with the menu shut: its Button drawn hidden.
    await ui.press({ key: 'help' })
    expect(await shown(ui)).toBe(true)
    await ui.press({ key: 'back' })
  }
})

test('the same page in every pane', TOKEN, async ($, on) => {
  world(on)
  const pages: string[][] = []
  for (const pane of [PANE, EPICS_PANE, MILESTONES_PANE]) {
    const ui = await mounted($, pane)
    await ui.press({ key: 'help' })
    pages.push(await texts(ui))
  }
  expect(pages[1]).toEqual(pages[0])
  expect(pages[2]).toEqual(pages[0])
})

test('Back returns to the list it was opened over', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($)
  const before = await texts(ui)
  await ui.press({ key: 'help' })
  await ui.press({ key: 'back' })
  expect(await texts(ui)).toEqual(before)
})

test('Back returns to the detail it was opened over, scrolled as it was', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($, PANE, 60)
  await ui.press({ key: 'pick-29' })
  await ui.press({ key: 'description-section' })
  await $.ui.scroll({ component: 'Pane', requestId: 'next', offset: 0, by: 5, bodyRows: 40, contentRows: 40, origin: { kind: 'person' } })
  const box = async () => ((await ui.find({ key: 'rows' })) as { props: { marginTop: number } } | undefined)?.props.marginTop
  const at = await box()
  expect(at).toBe(-5)
  await ui.press({ key: 'help' })
  expect(await box()).toBe(-0)
  await ui.press({ key: 'back' })
  expect(has(await texts(ui), '#29 Docs: config keys')).toBe(true)
  expect(await box()).toBe(at)
})

test('/next help opens What\'s next on the help page', TOKEN, async ($, on) => {
  world(on)
  const said = await $.command.run(run('help'))
  expect(said).toEqual(expect.objectContaining({ text: "What's Next's help is open in What's next: what each sign and colour means." }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shown(ui)).toBe(true)
})

test('every mark markOf draws is on the page, in the colour the panes draw it', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($)
  await ui.press({ key: 'help' })
  const all = await ui.findAll({ type: 'Text' })
  const standings: (Standing | null)[] = ['yours', 'available', 'withOthers', 'blocked', null]
  const folds: (Folding | null)[] = [null, 'folded', 'unfolded', 'shown above']
  const glyphs = new Set(standings.flatMap(st => folds.flatMap(f => [false, true].map(c => markOf(st, f, c).glyph))))
  glyphs.delete(' ')
  for (const g of glyphs) expect([g, all.some(t => t.text.includes(g))]).toEqual([g, true])
  // The sign's own Text, inside the one that cuts the gutter.
  const drawn = (text: string, prop: string, value: unknown) => all.some(t => t.text === text && t.props[prop] === value)
  expect(drawn('● ', 'color', 'success')).toBe(true)
  expect(drawn('⊘ ', 'dimColor', true)).toBe(true)
  expect(drawn('✓', 'color', 'inactive')).toBe(true)
  // Under an epic the for-you line names its children (#64).
  expect(all.some(t => t.text.startsWith('children ⊘ 2'))).toBe(true)
})

test('every term of How an issue stands for you (TERMINOLOGY.md) is on the page, with what it means', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($)
  await ui.press({ key: 'help' })
  const all = await texts(ui)
  for (const term of ['yours', 'blocked', 'with others', 'available']) expect([term, has(all, `${term}: `)]).toEqual([term, true])
})

test('the sections in their order, each under a rule', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($)
  await ui.press({ key: 'help' })
  const all = await texts(ui)
  const names = ['How an issue stands for you', 'Rows that fold', 'Under an issue', 'Counts', 'Colours', 'Buttons']
  const at = names.map(n => all.indexOf(n))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
})

test('the due dates are drawn as the panes draw them: amber within 7 days, red once passed', TOKEN, async ($, on) => {
  const clock = world(on)
  await clock.set(NOW)
  const ui = await mounted($)
  await ui.press({ key: 'help' })
  const all = await ui.findAll({ type: 'Text' })
  const drawn = (text: string, prop: string, value: unknown) => all.some(t => t.text === text && t.props[prop] === value)
  expect(drawn('⧗ 12 Oct', 'color', 'warning')).toBe(true)
  expect(drawn('⧗ 6 Oct', 'color', 'error')).toBe(true)
  expect(drawn('⧗ 27 Oct', 'dimColor', true)).toBe(true)
})

test('in a narrow pane the words wrap under themselves, never cut', TOKEN, async ($, on) => {
  world(on)
  const ui = await mounted($, PANE, 40)
  await ui.press({ key: 'help' })
  const all = await texts(ui)
  // 40 columns: 17 for the signs (the widest, `● 2 · ○ 1 · ⊘ 1`, and two
  // spaces), 23 for the words.
  expect(all).toContain('blocked: waits on an')
  expect(all).toContain('open issue')
  expect(all.some(t => t.includes('…') && t.startsWith('blocked'))).toBe(false)
  // The gutter is as wide as the widest sign and two spaces.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  expect([...new Set(boxes.filter(b => b.key === 'sign').map(b => b.props.width))]).toEqual([17])
})
