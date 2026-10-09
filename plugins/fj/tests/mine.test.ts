import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const TOKEN = { options: { token: 'secret', icons: 'text' } }
const NOW = Date.parse('2026-10-09T12:00:00Z')

function issue(number: number, repo: string, created: string, extra: { milestone?: string; labels?: string[] } = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    created_at: created,
    html_url: `https://git.example.org/${repo}/issues/${number}`,
    body: '',
    milestone: extra.milestone ? { title: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name })),
    repository: { full_name: repo },
  }
}

// A repo that passes setup, whose search answers `pages` in turn.
function world(on: On, pages: unknown[][], asked: string[] = []) {
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
    const body = url.pathname.endsWith('/version')
      ? { version: '16.0.5+gitea-1.22.0' }
      : url.pathname.endsWith('/issues/search')
        ? (pages[Number(url.searchParams.get('page')) - 1] ?? [])
        : { full_name: 'boats/radar', open_issues_count: 9 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lists my open issues in this repo, oldest first, on ${surface}`, TOKEN, async ($, on) => {
    const clock = world(on, [
      [
        issue(37, 'boats/radar', '2026-10-02T09:00:00Z', { milestone: 'v1.2', labels: ['prio/high', 'auth'] }),
        issue(3, 'boats/other', '2026-01-01T00:00:00Z'),
        issue(29, 'boats/radar', '2026-09-18T09:00:00Z', { labels: ['docs'] }),
        issue(51, 'boats/radar', '2026-10-09T09:00:00Z', { milestone: 'v1.2' }),
      ],
    ])
    await clock.set(NOW)

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await texts(ui)).toEqual([
      'My issues (3)',
      '#29 Issue 29',
      '#29 ',
      '    ',
      'no milestone · docs · opened 3w ago',
      '#37 Issue 37',
      '#37 ',
      '    ',
      'v1.2 · prio/high, auth · opened 7d ago',
      '#51 Issue 51',
      '#51 ',
      '    ',
      'v1.2 · opened 3h ago',
      'git.example.org/boats/radar',
    ])
    expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 3 issues assigned to you.' }))
  })
}

test('reads every page of the search', TOKEN, async ($, on) => {
  const asked: string[] = []
  const first = Array.from({ length: 50 }, (_, k) => issue(100 + k, 'boats/other', '2026-09-01T00:00:00Z'))
  world(on, [first, [issue(7, 'boats/radar', '2026-09-01T00:00:00Z')]], asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(asked.filter(u => u.includes('/issues/search')).map(u => new URL(u).searchParams.get('page'))).toEqual(['1', '2'])
  expect(await texts(ui)).toContain('My issues (1)')
})

test('none assigned: says so', TOKEN, async ($, on) => {
  world(on, [[issue(3, 'boats/other', '2026-01-01T00:00:00Z')]])

  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('No open issues assigned to you in boats/radar.')
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 0 issues assigned to you.' }))
})

test('the repo line sits at the bottom of the pane, however long the list', TOKEN, async ($, on) => {
  world(on, [Array.from({ length: 30 }, (_, k) => issue(200 + k, 'boats/radar', '2026-09-01T00:00:00Z'))])

  await $.command.run(RUN)
  // A short pane: 30 issues need far more than 12 rows.
  const rows = 12
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
  const boxes = await ui.findAll({ type: 'Box' })
  expect((boxes[0] as unknown as { props: { height?: number } }).props.height).toBe(rows)
  const list = boxes.find(b => b.key === 'list') as unknown as { props: Record<string, unknown> }
  expect(list.props).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }))
  const all = await texts(ui)
  expect(all.at(-1)).toBe('git.example.org/boats/radar')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the title row holds Refresh on ${surface}`, TOKEN, async ($, on) => {
    const asked: string[] = []
    world(on, [[issue(7, 'boats/radar', '2026-09-01T00:00:00Z')]], asked)

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await texts(ui))[0]).toBe('My issues (1)')
    const button = (await ui.find({ key: 'refresh' })) as unknown as { props: Record<string, unknown> }
    expect(button.props).toEqual(expect.objectContaining({ label: 'Refresh', hotkey: 'r' }))
    const before = asked.length
    await ui.press({ key: 'refresh' })
    expect(asked.length).toBeGreaterThan(before)
  })
}

test('long titles are cut to one line, and numbers of any width line up', TOKEN, async ($, on) => {
  const long = { ...issue(1000, 'boats/radar', '2026-09-02T00:00:00Z'), title: 'A title far too long to fit on one line of a narrow pane' }
  world(on, [[issue(7, 'boats/radar', '2026-09-01T00:00:00Z'), long]])

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const all = await texts(ui)

  // '#1000 ' is the widest number, so the column is six wide.
  expect(all).toContain('#7    Issue 7')
  expect(all).toContain('#1000 A title far too long to…')
  expect(all.find(t => t.startsWith('#1000 '))?.length).toBe(30)
})
