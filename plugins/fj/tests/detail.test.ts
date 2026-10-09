import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj',
  props: {
    title: 'fj',
    isFocused: false,
    bodyColumns: 60,
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

const ISSUE = {
  number: 29,
  title: 'Docs: config keys',
  state: 'open',
  html_url: 'https://git.example.org/boats/radar/issues/29',
  body: 'The README lists the old settings.\n\nDocument the Token.',
  user: { login: 'alice' },
  created_at: '2026-09-18T09:00:00Z',
  updated_at: '2026-10-07T12:00:00Z',
  comments: 2,
  milestone: { title: 'v0.3.0', due_on: '2026-10-31T00:00:00Z' },
  due_date: '2026-10-14T12:00:00Z',
  ref: 'refs/heads/29-config-docs',
  labels: [
    { name: 'docs', color: 'e8875c' },
    { name: 'needs-triage', color: '1d4ed8' },
  ],
}

// Answers by path; a path left out answers 404.
type Answers = Record<string, unknown>

const FULL: Answers = {
  '/issues/29': ISSUE,
  '/issues/29/comments': [
    { user: { login: 'maria' }, created_at: '2026-10-01T12:00:00Z', body: 'First.' },
    { user: { login: 'jdoe' }, created_at: '2026-10-07T12:00:00Z', body: 'Also mention the desktop app.' },
  ],
  '/issues/29/dependencies': [
    { number: 24, title: 'Settings screen rework', state: 'open' },
    { number: 19, title: 'Drop FORGEJO_TOKEN', state: 'closed' },
  ],
  '/issues/29/blocks': [{ number: 31, title: 'Release notes for 0.3.0', state: 'open' }],
  '/issues/29/timeline': [
    { type: 'comment', created_at: '2026-10-01T12:00:00Z', body: 'x', ref_commit_sha: null, ref_issue: null },
    {
      type: 'pull_ref',
      created_at: '2026-10-05T12:00:00Z',
      body: '',
      ref_commit_sha: null,
      ref_issue: { number: 61, title: 'Document the Token setting', state: 'closed', pull_request: { merged: true } },
    },
    {
      type: 'commit_ref',
      created_at: '2026-10-07T12:00:00Z',
      body: '<a href="/boats/radar/commit/a1b2c3d4e5">docs: list the Token&#39;s scopes</a>',
      ref_commit_sha: 'a1b2c3d4e5f6',
      ref_issue: null,
    },
  ],
  '/issues/29/times': [{ time: 3600 }, { time: 1200 }],
}

function world(on: On, answers: Answers, asked: string[] = [], opened: string[] = [], opener = 'open') {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (e.argv[0] === 'open' || e.argv[0] === 'xdg-open') {
      opened.push(cmd)
      const ok = e.argv[0] === opener
      return { value: { exitCode: ok ? 0 : 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = cmd === 'git remote get-url origin' ? 'git@git.example.org:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const url = new URL(e.url)
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) },
    })
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5' })
    if (url.pathname.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/issues/search')) return reply(200, url.searchParams.get('page') === '1' ? [LISTED] : [])
    // The repo's open issues: only #29, which is yours.
    if (url.pathname.endsWith('/repos/boats/radar/issues')) return reply(200, [])
    const path = e.url.startsWith(API) ? e.url.slice(API.length) : ''
    if (path === '') return reply(200, { full_name: 'boats/radar', open_issues_count: 9 })
    return path in answers ? reply(200, answers[path]) : reply(404, { message: 'not found' })
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

async function opened($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'pick-29' })
  return ui
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`selecting an issue shows its detail in place of the list on ${surface}`, TOKEN, async ($, on) => {
    const clock = world(on, FULL)
    await clock.set(NOW)
    const ui = await opened($, surface)
    const all = await texts(ui)

    expect(all).not.toContain("What's next")
    for (const want of [
      '#29 Docs: config keys',
      'open · v0.3.0 (due 31 Oct) · 2 comments',
      'opened 3w ago by alice · updated 2d ago',
      '14 Oct, in 5 days',
      '29-config-docs',
      '1h 20m logged',
      ' docs ',
      ' needs-triage ',
      'Blocked by     ',
      'Settings screen rework',
      'Drop FORGEJO_TOKEN',
      'Blocks         ',
      'Release notes for 0.3.0',
      'Pull requests  ',
      ' merged',
      'Commits        ',
      'a1b2c3d ',
      "docs: list the Token's scopes",
      'The README lists the old settings.',
      'Document the Token.',
      'Also mention the desktop app.',
      '1 earlier comment',
      'git.example.org/boats/radar',
    ]) {
      expect(all.some(t => t === want || t.includes(want))).toBe(true)
    }
    expect(all.some(t => t.startsWith('── Last comment ── jdoe · 2d ago'))).toBe(true)
    await expect(ui.find({ key: 'work' })).resolves.toBeDefined()
    await expect(ui.find({ key: 'open' })).resolves.toBeDefined()
  })
}

test('an open blocker is red, a closed one struck through', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  const all = await ui.findAll({ type: 'Text' })
  const open = all.find(t => t.text.startsWith('Settings screen rework')) as unknown as { props: Record<string, unknown> }
  const closed = all.find(t => t.text.startsWith('Drop FORGEJO_TOKEN')) as unknown as { props: Record<string, unknown> }
  expect(open.props.strikethrough).toBe(false)
  expect(closed.props.strikethrough).toBe(true)
  const num = all.find(t => t.text === '#24 ') as unknown as { props: Record<string, unknown> }
  expect(num.props.color).toBe('error')
})

test('a passed due date is red', TOKEN, async ($, on) => {
  const clock = world(on, { ...FULL, '/issues/29': { ...ISSUE, due_date: '2026-10-06T12:00:00Z' } })
  await clock.set(NOW)
  const ui = await opened($)
  const due = (await ui.findAll({ type: 'Text' })).find(t => t.text === '6 Oct, 3 days ago') as unknown as {
    props: Record<string, unknown>
  }
  expect(due.props.color).toBe('error')
})

test('the lines with nothing to show are left out', TOKEN, async ($, on) => {
  // Only the issue answers; dependencies, timeline and times are off.
  world(on, { '/issues/29': { ...ISSUE, due_date: null, ref: '', labels: [], comments: 0 } })
  const ui = await opened($)
  const all = await texts(ui)

  for (const gone of ['Due', 'Branch', 'Time', 'Labels', 'Blocked by', 'Blocks', 'Pull requests', 'Commits']) {
    expect(all.some(t => t.trimEnd() === gone)).toBe(false)
  }
  expect(all.some(t => t.startsWith('── Last comment'))).toBe(false)
  expect(all).toContain('The README lists the old settings.')
})

test('a long description is cut, with how much more there is', TOKEN, async ($, on) => {
  const body = Array.from({ length: 80 }, (_, k) => `line ${k + 1}`).join('\n')
  world(on, { ...FULL, '/issues/29': { ...ISSUE, body } })
  const ui = await opened($)
  const all = await texts(ui)

  expect(all).toContain('line 1')
  expect(all).not.toContain('line 80')
  expect(all.some(t => /^… \d+ more lines$/.test(t))).toBe(true)
})

test("What's next goes back to the overview", TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  await ui.press({ key: 'back' })

  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  await expect(ui.find({ key: 'work' })).resolves.toBeUndefined()
})

test('says so when the issue cannot be read', TOKEN, async ($, on) => {
  world(on, {})
  const ui = await opened($)

  expect(await texts(ui)).toContain('Could not load #29: #29: HTTP 404.')
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
})

test('Refresh reads the open issue again', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, FULL, asked)
  const ui = await opened($)
  const before = asked.filter(u => u === `${API}/issues/29`).length
  await ui.press({ key: 'refresh' })

  expect(asked.filter(u => u === `${API}/issues/29`).length).toBe(before + 1)
  expect((await texts(ui)).some(t => t.includes('Docs: config keys'))).toBe(true)
})

test('an issue opened again is shown from memory until Refresh', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, FULL, asked)
  const ui = await opened($)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'pick-29' })
  const issue = () => asked.filter(u => u === `${API}/issues/29` || u === `${API}/issues/29/comments`).length
  expect(issue()).toBe(2)
  expect((await texts(ui)).some(t => t.includes('Docs: config keys'))).toBe(true)

  await ui.press({ key: 'refresh' })
  expect(issue()).toBe(4)
  // /fj asks again too.
  await $.command.run(RUN)
  expect(issue()).toBe(6)
})

type Filled = { text: string; mode?: string }[]

function promptBox(on: On, typed: string, filled: Filled, take = true, toasts: string[] = []) {
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: typed, cursor: typed.length } }))
  on('prompt.fill', (_$, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return take ? { isFilled: true } : { isFilled: false, refusal: 'dialog' as const }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Work on this drafts a prompt with the last comment on ${surface}`, TOKEN, async ($, on) => {
    const filled: Filled = []
    const toasts: string[] = []
    world(on, FULL)
    promptBox(on, '', filled, true, toasts)
    const ui = await opened($, surface)
    await ui.press({ key: 'work' })

    expect(filled).toEqual([
      {
        text: [
          'Work on #29: Docs: config keys',
          'https://git.example.org/boats/radar/issues/29',
          '',
          'The README lists the old settings.',
          '',
          'Document the Token.',
          '',
          'Last comment, by jdoe:',
          'Also mention the desktop app.',
        ].join('\n'),
        mode: 'replace',
      },
    ])
    expect(toasts).toEqual(['#29 is in the prompt: Esc to edit it there'])
  })
}

test('Work on this goes under what is typed already', TOKEN, async ($, on) => {
  const filled: Filled = []
  world(on, { '/issues/29': { ...ISSUE, body: '  ' } })
  promptBox(on, 'also check the README', filled)
  const ui = await opened($)
  await ui.press({ key: 'work' })

  expect(filled).toEqual([
    { text: '\n\nWork on #29: Docs: config keys\nhttps://git.example.org/boats/radar/issues/29', mode: 'append' },
  ])
})

test('says so when the prompt cannot take the draft', TOKEN, async ($, on) => {
  const toasts: string[] = []
  world(on, FULL)
  promptBox(on, '', [], false, toasts)
  const ui = await opened($)
  await ui.press({ key: 'work' })

  expect(toasts).toEqual(['Could not put #29 in the prompt'])
})

test('Open in browser opens the issue page with open, else xdg-open', TOKEN, async ($, on) => {
  const ran: string[] = []
  world(on, FULL, [], ran, 'xdg-open')
  const ui = await opened($)
  await ui.press({ key: 'open' })
  expect(ran).toEqual([
    'open https://git.example.org/boats/radar/issues/29',
    'xdg-open https://git.example.org/boats/radar/issues/29',
  ])
})

test('says so when no browser opens', TOKEN, async ($, on) => {
  const toasts: string[] = []
  world(on, FULL, [], [], 'none')
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  const ui = await opened($)
  await ui.press({ key: 'open' })
  expect(toasts).toEqual(['Could not open a browser for https://git.example.org/boats/radar/issues/29'])
})
