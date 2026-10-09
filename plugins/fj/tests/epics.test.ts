import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Answers `git remote get-url origin` with `url`, or fails it when null.
function remote(on: On, url: string | null) {
  on('process.run', () => ({
    value: {
      exitCode: url === null ? 2 : 0,
      stdout: url === null ? '' : `${url}\n`,
      stderr: url === null ? "error: No such remote 'origin'" : '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

// Answers the Forgejo API as `labels=<label>` and `## <heading>` would find.
function forgejo(on: On, asked: string[], label = 'epic') {
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'secret' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const q = new URL(e.url).searchParams
    const one = /\/issues\/(\d+)$/.exec(new URL(e.url).pathname)
    const body = one
      ? DETAIL(Number(one[1]))
      : e.url.includes('/repos/issues/search')
      ? []
      : e.url.includes('/milestones')
      ? MILESTONES
      : q.get('labels') === label
        ? EPICS[q.get('milestones') ?? ''] ?? []
        : q.has('labels')
          ? []
          : q.get('page') === '1'
            ? ISSUES
            : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
}

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'epics',
  props: {
    title: 'Epics',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const MILESTONES = [
  { id: 1, title: 'v0.2.0', state: 'closed' },
  { id: 2, title: 'v0.3.0', state: 'open' },
]

// What /issues/<n> answers: enough of Forgejo's issue for the detail.
const DETAIL = (n: number) => ({
  number: n,
  title: `Issue ${n}`,
  state: n === 118 ? 'open' : 'closed',
  body: `First line of ${n}.\n\nSecond paragraph.`,
  created_at: '2026-09-01T08:00:00Z',
  updated_at: '2026-10-02T09:30:00Z',
  comments: 4,
  user: { login: 'alice' },
  labels: [{ name: 'bug' }, { name: 'ready-for-agent' }],
  milestone: { title: 'v0.3.0' },
  assignees: [{ login: 'alice' }],
})

const CLOSED = [129, 170, 120, 10, 998, 999]
const ISSUES = [118, 120, 129, 170, 998, 999, 10].map(number => ({
  number,
  title: `Issue ${number}`,
  state: CLOSED.includes(number) ? 'closed' : 'open',
}))

const EPICS: Record<string, unknown[]> = {
  '1': [{ number: 10, title: 'E0 — Old', state: 'closed', html_url: 'https://x/10' }],
  '2': [
    {
      number: 122,
      title: 'E3 — The AIS radar',
      state: 'open',
      html_url: 'https://x/122',
      // #170 is closed though its box is not ticked; #118 is open though
      // ticked; #135 has no box; #999 sits under another heading.
      body: [
        '## Story',
        '- [ ] #999 not a child',
        '## Children',
        'Decide first:',
        '- [x] #129 ADR',
        '- [ ] #170 A moored target',
        '- [x] #118 The bottom of the range ladder',
        'Deferred:',
        '- #135 Watch a target',
        '## Notes',
        '- [x] #998 not a child either',
      ].join('\n'),
    },
    { number: 120, title: 'E1 — The Cerbo', state: 'closed', html_url: 'https://x/120' },
  ],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lists the epics of a milestone on ${surface}`, async ($, on) => {
    const asked: string[] = []
    remote(on, 'ssh://git@git.example.org:2222/boats/radar.git')
    forgejo(on, asked)

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    await expect(ui.find({ text: /E1 — The Cerbo/ })).resolves.toBeDefined()
    const buttons = async (pattern: RegExp) =>
      (await ui.findAll({ type: 'Button' })).filter(b => pattern.test(b.key ?? ''))
    const rows = await buttons(/^pick-\d+$/)
    expect(rows.map(r => r.text)).toEqual([
      'E3 — The AIS radar (2/3) #122',
      'E1 — The Cerbo (0/0) #120',
    ])
    expect((await buttons(/^toggle-/)).map(b => b.text)).toEqual(['▸', '▸'])
    const colors = async (pattern: RegExp) =>
      (await ui.findAll({ type: 'Text', text: pattern })).map(r => r.props?.color)
    expect(await colors(/#120$/)).toContain('inactive')
    expect(await colors(/#122$/)).toContain('warning')
    expect(rows.some(r => r.text.includes('https://'))).toBe(false)
    await expect(ui.find({ text: 'Issue 129' })).resolves.toBeUndefined()

    await ui.press({ key: 'toggle-122' })
    await expect(ui.find({ key: 'toggle-122', text: '▾' })).resolves.toBeDefined()
    expect((await buttons(/^pick-122-/)).map(b => b.key)).toEqual(['pick-122-118', 'pick-122-129', 'pick-122-170'])
    const kids = await ui.findAll({ type: 'Text', text: /^Issue \d+ #\d+$/ })
    expect(kids.map(k => [k.text, k.props?.color])).toEqual([
      ['Issue 118 #118', 'warning'],
      ['Issue 129 #129', 'inactive'],
      ['Issue 170 #170', 'inactive'],
    ])

    await ui.press({ key: 'toggle-122' })
    await expect(ui.find({ text: 'Issue 129' })).resolves.toBeUndefined()
    expect(
      asked.every(
        u =>
          u.startsWith('https://git.example.org/api/v1/repos/boats/radar/') ||
          u.startsWith('https://git.example.org/api/v1/repos/issues/search?'),
      ),
    ).toBe(true)

    await ui.select({ key: 'milestone', value: '1' })
    await expect(ui.find({ text: /E0 — Old/ })).resolves.toBeDefined()
    await expect(ui.find({ text: /E3/ })).resolves.toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows a selected child in the detail on ${surface}`, async ($, on) => {
    const asked: string[] = []
    remote(on, 'git@git.example.org:boats/radar.git')
    forgejo(on, asked)

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    await expect(ui.find({ text: 'Select an issue above.' })).resolves.toBeDefined()

    await ui.press({ key: 'toggle-122' })
    await ui.press({ key: 'pick-122-118' })

    expect(asked).toContain('https://git.example.org/api/v1/repos/boats/radar/issues/118')
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const at = texts.lastIndexOf('Issue 118 #118')
    expect(texts.slice(at, at + 3)).toEqual([
      'Issue 118 #118',
      'open · v0.3.0 · bug · ready-for-agent',
      'opened by alice 2026-09-01 · updated 2026-10-02 · 4 comments · assigned to alice',
    ])
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('First line of 118.')
    const selected = (await ui.findAll({ type: 'Text', text: 'Issue 118 #118' })).map(t => t.props?.inverse)
    expect(selected[0]).toBe(true)

    await ui.press({ key: 'pick-122' })
    await expect(ui.find({ text: /^Issue 122 #122$/ })).resolves.toBeDefined()
  })
}

// After a reload the pane is still open but /fj has not run in this module:
// its buttons have to find the repo themselves.
test('the pane works when /fj has not run since the module loaded', async ($, on) => {
  const asked: string[] = []
  remote(on, 'git@git.example.org:boats/radar.git')
  forgejo(on, asked)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await expect(ui.find({ key: 'pick-122' })).resolves.toBeDefined()

  await ui.press({ key: 'pick-122' })
  await expect(ui.find({ text: 'closed · v0.3.0 · bug · ready-for-agent' })).resolves.toBeDefined()
})

for (const [form, url] of [
  ['scp', 'git@git.example.org:boats/radar.git'],
  ['https', 'https://git.example.org/boats/radar'],
  ['ssh without port', 'ssh://git@git.example.org/boats/radar.git/'],
] as const) {
  test(`reads the repo from a ${form} remote`, async ($, on) => {
    const asked: string[] = []
    remote(on, url)
    forgejo(on, asked)

    await $.command.run(RUN)

    expect(asked).toContainEqual(
      expect.stringMatching(/^https:\/\/git\.example\.org\/api\/v1\/repos\/boats\/radar\/milestones\?/),
    )
  })
}

test('lists issues under the label and heading set in config', {
  options: { label: 'kind/epic', childrenHeading: 'Tasks' },
}, async ($, on) => {
  const asked: string[] = []
  remote(on, 'git@git.example.org:boats/radar.git')
  forgejo(on, asked, 'kind/epic')
  // Same epic, its checklist under `## Tasks` instead of `## Children`.
  EPICS['3'] = [{ number: 7, title: 'E9 — Tasks', state: 'open', body: '## Tasks\n- [ ] #118 x\n- [ ] #129 y' }]
  MILESTONES.push({ id: 3, title: 'v0.4.0', state: 'open' })
  try {
    await $.command.run({ ...RUN, args: 'v0.4.0' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await expect(ui.find({ key: 'pick-7', text: 'E9 — Tasks (1/2) #7' })).resolves.toBeDefined()
    expect(asked.some(u => u.includes('labels=kind%2Fepic'))).toBe(true)
  } finally {
    delete EPICS['3']
    MILESTONES.pop()
  }
})

test('says so when the directory has no origin', async ($, on) => {
  const asked: string[] = []
  remote(on, null)
  forgejo(on, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'no git remote "origin" here' })).resolves.toBeDefined()
  expect(asked).toEqual([])
})

test('says so when the token is missing', async ($, on) => {
  remote(on, 'git@git.example.org:boats/radar.git')
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(
    ui.find({ text: 'no token: set it with /plugin configure fj@egribnau-mods, or set FORGEJO_TOKEN' }),
  ).resolves.toBeDefined()
})

test('sends the Token setting and leaves FORGEJO_TOKEN unread', { options: { token: 'from-config' } }, async ($, on) => {
  const auth: string[] = []
  let readEnv = false
  remote(on, 'git@git.example.org:boats/radar.git')
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => {
    readEnv = true
    return { value: 'from-env' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    auth.push(String(e.init?.headers?.Authorization))
    return { value: { status: 200, ok: true, headers: {}, text: '[]' } }
  })

  const said = await $.command.run(RUN)

  expect(said.text).toBe('Epics pane opened (token: setting).')
  expect(auth.length).toBeGreaterThan(0)
  expect(new Set(auth)).toEqual(new Set(['token from-config']))
  expect(readEnv).toBe(false)
})
