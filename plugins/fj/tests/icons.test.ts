import { expect, mock, test } from 'claude-code/testing'
import type { ConfigRow, On } from 'claude-code'

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj',
  props: {
    title: 'fj',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const ICON = { refresh: '\u{F0450}', work: '\u{F0674}', open: '\u{F03CC}', back: '\u{F004D}' }

const ISSUE = {
  number: 29,
  title: 'Docs: config keys',
  state: 'open',
  created_at: '2026-09-18T09:00:00Z',
  updated_at: '2026-10-07T12:00:00Z',
  html_url: 'https://git.example.org/boats/radar/issues/29',
  body: '',
  user: { login: 'alice' },
  comments: 0,
  milestone: null,
  due_date: null,
  ref: '',
  labels: [],
  repository: { full_name: 'boats/radar' },
}

function row(value: string): ConfigRow {
  return {
    key: 'fj@egribnau-mods.icons',
    label: 'Icons',
    kind: 'choice',
    value,
    options: ['ask', 'icons', 'text'],
    provider: { plugin: 'fj', tier: 'user' },
    isLocked: false,
  } as unknown as ConfigRow
}

function world(on: On, set: { key: string; value: unknown }[] = [], offered = true) {
  mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const body = url.pathname.endsWith('/version')
      ? { version: '16.0.5' }
      : url.pathname.endsWith('/api/v1/user')
        ? { login: 'alice' }
      : url.pathname.endsWith('/issues/search')
        ? url.searchParams.get('page') === '1'
          ? [ISSUE]
          : []
        : url.pathname.endsWith('/repos/boats/radar/issues')
          ? []
          : url.pathname.endsWith('/issues/29')
            ? ISSUE
            : url.pathname.includes('/issues/29/')
              ? []
              : { full_name: 'boats/radar', open_issues_count: 1 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('config.list', () => ({ value: offered ? [row('ask')] : [] }))
  on('config.set', (_$, e) => {
    set.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const label = async (ui: { find: (q: { key: string }) => Promise<unknown> }, key: string) =>
  ((await ui.find({ key })) as { props: { label?: string } } | undefined)?.props.label

for (const surface of ['terminal', 'desktop'] as const) {
  test(`asks once about icons after setup, showing them, on ${surface}`, { options: { token: 'secret' } }, async ($, on) => {
    world(on)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(all[0]).toBe('Forgejo for Claude is ready!')
    expect(all).toContain('One choice: icons on buttons')
    expect(all).toContain(`[ ${ICON.refresh} ]  [ ${ICON.work} ]  [ ${ICON.open} ]  [ ${ICON.back} ]`)
    expect(all).not.toContain("What's next")
    await expect(ui.find({ key: 'use-icons' })).resolves.toBeDefined()
    await expect(ui.find({ key: 'keep-text' })).resolves.toBeDefined()
  })
}

test('Use icons saves the setting and the buttons become icons', { options: { token: 'secret' } }, async ($, on) => {
  const set: { key: string; value: unknown }[] = []
  world(on, set)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-icons' })

  expect(set).toEqual([{ key: 'fj@egribnau-mods.icons', value: 'icons' }])
  expect((await texts(ui))[0]).toBe("What's next")
  expect(await label(ui, 'refresh')).toBe(ICON.refresh)

  await ui.press({ key: 'pick-29' })
  expect(await label(ui, 'back')).toBe(ICON.back)
  expect(await label(ui, 'work')).toBe(ICON.work)
  expect(await label(ui, 'open')).toBe(ICON.open)
})

test('Keep text saves the setting and the buttons keep their words', { options: { token: 'secret' } }, async ($, on) => {
  const set: { key: string; value: unknown }[] = []
  world(on, set)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'keep-text' })

  expect(set).toEqual([{ key: 'fj@egribnau-mods.icons', value: 'text' }])
  expect(await label(ui, 'refresh')).toBe('Refresh')
})

test('where /config offers no Icons row, the choice holds for the session', { options: { token: 'secret' } }, async ($, on) => {
  const set: { key: string; value: unknown }[] = []
  world(on, set, false)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'use-icons' })

  expect(set).toEqual([])
  expect(await label(ui, 'refresh')).toBe(ICON.refresh)
})

test('once chosen in settings, it is not asked again', { options: { token: 'secret', icons: 'icons' } }, async ($, on) => {
  world(on)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await texts(ui))[0]).toBe("What's next")
  expect(await label(ui, 'refresh')).toBe(ICON.refresh)
})

test('setup screens keep Check again in words', { options: { token: '', icons: 'icons' } }, async ($, on) => {
  world(on)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await label(ui, 'refresh')).toBe('Check again')
})
