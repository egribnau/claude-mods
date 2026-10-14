import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

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

// What the token and the repo allow, for the actions. Left out: a repo
// without push and a token whose scopes Forgejo lists as read only.
type Rights = {
  push?: boolean
  // The token's scopes as /users/alice/tokens lists them; null: that list is refused.
  scopes?: readonly string[] | null
  // The writes What's Next sends, and what Forgejo answers them.
  sent?: { method: string; path: string; body: unknown }[]
  refuse?: { status: number; message: string }
  // Whether the repo tracks time and has dependencies; both when left out.
  time?: boolean
  deps?: boolean
}

function world(on: On, answers: Answers, asked: string[] = [], opened: string[] = [], opener = 'open', rights: Rights = {}) {
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
      value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (url.pathname.endsWith('/version')) return reply(200, { version: '16.0.5' })
    if (url.pathname.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (url.pathname.endsWith('/api/v1/users/alice/tokens')) {
      if (rights.scopes === null) return reply(401, { message: 'basic auth required' })
      return reply(200, [
        { name: 'other', token_last_eight: 'abcdefgh', scopes: ['all'] },
        { name: 'whats-next', token_last_eight: 'secret', scopes: rights.scopes ?? ['read:issue', 'read:repository', 'read:user'] },
      ])
    }
    if (e.init?.method === 'PATCH') {
      const body = JSON.parse(String(e.init.body ?? '{}')) as Record<string, unknown>
      rights.sent?.push({ method: 'PATCH', path: url.pathname, body })
      if (rights.refuse) return reply(rights.refuse.status, { message: rights.refuse.message })
      // The issue as Forgejo now holds it, for the next read.
      const now = { ...(answers['/issues/29'] as object), ...body } as Record<string, unknown>
      if (body.assignees) now.assignees = (body.assignees as string[]).map(login => ({ login }))
      answers = { ...answers, '/issues/29': now }
      return reply(201, now)
    }
    if (url.pathname.endsWith('/issues/search')) return reply(200, url.searchParams.get('page') === '1' ? [LISTED] : [])
    // The repo's open issues: only #29, which is yours.
    if (url.pathname.endsWith('/repos/boats/radar/issues')) return reply(200, [])
    const path = e.url.startsWith(API) ? url.pathname.slice(new URL(API).pathname.length) : ''
    if (path === '') {
      return reply(200, {
        full_name: 'boats/radar',
        open_issues_count: 9,
        permissions: { push: rights.push ?? false },
        internal_tracker: { enable_time_tracker: rights.time ?? true, enable_issue_dependencies: rights.deps ?? true },
      })
    }
    if (!(path in answers)) return reply(404, { message: 'not found' })
    // A list asked for in pages answers the page asked for.
    const answer = answers[path]
    const limit = Number(url.searchParams.get('limit'))
    if (Array.isArray(answer) && limit > 0) {
      const page = Number(url.searchParams.get('page') ?? '1')
      return reply(200, answer.slice((page - 1) * limit, page * limit))
    }
    return reply(200, answer)
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
      '✎ 3w alice',
      'Due        ',
      '14 Oct, in 5 days',
      'Milestone  ',
      'v0.3.0 · ⧗ 31 Oct',
      '29-config-docs',
      '1h 20m logged',
      'docs',
      'needs-triage',
      'Blocked by ',
      'Settings screen rework',
      'Drop FORGEJO_TOKEN',
      'Blocks     ',
      'Release notes for 0.3.0',
      'PRs        ',
      ' merged',
      'Commits    ',
      'a1b2c3d ',
      "docs: list the Token's scopes",
      '── Description',
      'The README lists the old settings.',
      'Document the Token.',
      '− Comments · 2',
      '− jdoe · 2d ago',
      'Also mention the desktop app.',
      '+ maria · 8d ago · First.',
    ]) {
      expect(all.some(t => t === want || t.includes(want))).toBe(true)
    }
    // The facts in their order: Blocked by, Blocks, Due, Milestone, Labels, Branch, Time, PRs, Commits.
    const order = ['Blocked by ', 'Blocks     ', 'Due        ', 'Milestone  ', 'Labels     ', 'Branch     ', 'Time       ', 'PRs        ', 'Commits    ']
    expect(order.every(k => all.includes(k))).toBe(true)
    expect(order.map(k => all.indexOf(k))).toEqual(order.map(k => all.indexOf(k)).sort((a, b) => a - b))
    expect(all.some(t => t.startsWith('opened '))).toBe(false)
    // No state word: #29 waits on #24, its mark says so.
    expect(all.some(t => t.trim() === 'open' || t.includes('open · '))).toBe(false)
    expect(all.some(t => t.startsWith('⊘ #29 Docs: config keys'))).toBe(true)
    await expect(ui.find({ key: 'prompt' })).resolves.toBeDefined()
    await expect(ui.find({ key: 'open' })).resolves.toBeDefined()
  })
}

test('labels are text in their Forgejo colour; one too dark to read is made lighter', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(found.find(t => t.text === 'docs')?.props.color).toBe('#e8875c')
  const deep = found.find(t => t.text === 'needs-triage')?.props.color as string
  expect(deep).toMatch(/^#[0-9a-f]{6}$/)
  expect(deep).not.toBe('#1d4ed8')
  expect(found.some(t => t.props.backgroundColor)).toBe(false)
})

// #24 blocks #29 and is blocked itself, by #22; #9 blocks #29 too, from
// another repo on Forgejo, and is left out. #31 is what #29 blocks.
const FOLLOW: Answers = {
  ...FULL,
  '/issues/29/dependencies': [
    { number: 24, title: 'Settings screen rework', state: 'open', repository: { full_name: 'boats/radar' } },
    { number: 9, title: 'Elsewhere', state: 'open', repository: { full_name: 'boats/sonar' } },
    { number: 19, title: 'Drop FORGEJO_TOKEN', state: 'closed', repository: { full_name: 'boats/radar' } },
  ],
  '/issues/24': { ...ISSUE, number: 24, title: 'Settings screen rework', html_url: 'https://git.example.org/boats/radar/issues/24' },
  '/issues/24/dependencies': [{ number: 22, title: 'Settings schema v2', state: 'open' }],
  '/issues/22': { ...ISSUE, number: 22, title: 'Settings schema v2', html_url: 'https://git.example.org/boats/radar/issues/22' },
}

type Found = { text: string; props: Record<string, unknown> }
const found = async (ui: Ui) => (await ui.findAll({ type: 'Text' })) as unknown as Found[]

test('an open blocker is blue after its mark; a closed one is a grey ✓, not struck through; numbers share one column', TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  const all = await found(ui)
  const num = (n: string) => all.find(t => t.text === n)
  expect(num('#24')?.props.color).toBe('suggestion')
  expect(all.some(t => t.props.color === 'error' && t.text.startsWith('#'))).toBe(false)
  expect(num('#19')?.props.color).toBe('inactive')
  expect(num('#31')?.props.color).toBe('suggestion')
  const closed = all.find(t => t.text.startsWith(' Drop FORGEJO_TOKEN'))
  expect(closed?.props.color).toBe('inactive')
  expect(closed?.props.strikethrough).toBeUndefined()
  const tick = all.find(t => t.text.trim() === '✓')
  expect(tick?.props.color).toBe('inactive')
  expect(all.some(t => t.text.trim() === 'closed')).toBe(false)
  // Every title starts in the same column: the number column, then a space.
  expect(all.some(t => t.text.startsWith(' Settings screen rework'))).toBe(true)
  expect(all.some(t => t.text.startsWith(' Release notes for 0.3.0'))).toBe(true)
})

test('a number shorter than the others sits at the right of the column', TOKEN, async ($, on) => {
  world(on, { ...FULL, '/issues/29/blocks': [{ number: 7, title: 'Short', state: 'open' }] })
  const ui = await opened($)
  expect((await texts(ui)).includes(' #7')).toBe(true)
})

test('an open blocker that is itself blocked is ⊘ and dim, its number blue, no word', TOKEN, async ($, on) => {
  world(on, FOLLOW)
  const ui = await opened($)
  const all = await found(ui)
  const at = all.findIndex(t => t.text === '#24')
  expect(all[at - 1]?.text).toBe('⊘ ')
  expect(all[at - 1]?.props.dimColor).toBe(true)
  expect(all[at]?.props.color).toBe('suggestion')
  expect(all[at + 1]?.props.dimColor).toBe(true)
  expect(all.some(t => t.text.trim() === 'blocked')).toBe(false)
})

test('a blocker with someone on it is ◌, their name at the right; one of yours is a green ●', TOKEN, async ($, on) => {
  world(on, {
    ...FULL,
    '/issues/29/dependencies': [
      { number: 24, title: 'Settings screen rework', state: 'open', assignees: [{ login: 'anna' }] },
      { number: 22, title: 'Settings schema v2', state: 'open', assignees: [{ login: 'alice' }] },
    ],
  })
  const all = await found(await opened($))
  const markOf = (n: string) => all[all.findIndex(t => t.text === n) - 1]
  expect(markOf('#24')?.text).toBe('◌ ')
  expect(all.some(t => t.text.trim() === 'anna' && t.props.dimColor === true)).toBe(true)
  expect(markOf('#22')?.text).toBe('● ')
  expect(markOf('#22')?.props.color).toBe('success')
})

test('a blocker in another repo is left out on Forgejo', TOKEN, async ($, on) => {
  world(on, FOLLOW)
  const ui = await opened($)
  expect((await texts(ui)).some(t => t.includes('Elsewhere'))).toBe(false)
  await expect(ui.find({ key: 'follow-9' })).resolves.toBeUndefined()
})

test('a blocker opens its issue in the same pane; Back returns to the issue it was opened from, then the list', TOKEN, async ($, on) => {
  world(on, FOLLOW)
  const ui = await opened($)
  await ui.press({ key: 'follow-24' })
  expect((await texts(ui)).some(t => t.includes('#24 Settings screen rework'))).toBe(true)

  await ui.press({ key: 'follow-22' })
  expect((await texts(ui)).some(t => t.includes('#22 Settings schema v2'))).toBe(true)
  expect(await labelOf(ui, 'back')).toBe('←')

  await ui.press({ key: 'back' })
  expect((await texts(ui)).some(t => t.includes('#24 Settings screen rework'))).toBe(true)
  await ui.press({ key: 'back' })
  expect((await texts(ui)).some(t => t.includes('#29 Docs: config keys'))).toBe(true)
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe("What's next")
})

test('Blocks lines open their issue too; pull requests are no buttons', TOKEN, async ($, on) => {
  world(on, { ...FULL, '/issues/31': { ...ISSUE, number: 31, title: 'Release notes for 0.3.0' } })
  const ui = await opened($)
  await expect(ui.find({ key: 'follow-61' })).resolves.toBeUndefined()
  await ui.press({ key: 'follow-31' })
  expect((await texts(ui)).some(t => t.includes('#31 Release notes for 0.3.0'))).toBe(true)
  await ui.press({ key: 'back' })
  expect((await texts(ui)).some(t => t.includes('#29 Docs: config keys'))).toBe(true)
})

test('an issue opened from the list again starts a new trail', TOKEN, async ($, on) => {
  world(on, FOLLOW)
  const ui = await opened($)
  await ui.press({ key: 'follow-24' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'pick-29' })
  await ui.press({ key: 'back' })
  expect((await texts(ui))[0]).toBe("What's next")
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

test('a due date within 7 days is amber, a later one dim; the milestone\'s due date follows the same rule', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(NOW)
  const all = await found(await opened($))
  expect(all.find(t => t.text === '14 Oct, in 5 days')?.props.color).toBe('warning')
  // The milestone is due 31 Oct, 22 days off: dim.
  const due = all.find(t => t.text === '⧗ 31 Oct')
  expect(due?.props.dimColor).toBe(true)
  expect(due?.props.color).toBeUndefined()
})

test('a passed milestone due date is red on its Milestone line', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(Date.parse('2026-11-02T12:00:00Z'))
  const all = await found(await opened($))
  expect(all.find(t => t.text === '⧗ 31 Oct')?.props.color).toBe('error')
})

test('the branch is plain, a commit sha dim and its age reads 2d ago; what it blocks is ⊘', TOKEN, async ($, on) => {
  const clock = world(on, FULL)
  await clock.set(NOW)
  const all = await found(await opened($))
  expect(all.find(t => t.text === '29-config-docs')?.props.color).toBeUndefined()
  const sha = all.find(t => /^[0-9a-f]{7,} $/.test(t.text))
  expect(sha?.props.dimColor).toBe(true)
  expect(sha?.props.color).toBeUndefined()
  expect(all.find(t => t.text === ' 2d ago')?.props.dimColor).toBe(true)
  // Under Blocks, #31 waits on #29 while #29 is open: ⊘, no word.
  expect(all[all.findIndex(t => t.text === '#31') - 1]?.text).toBe('⊘ ')
  expect(all.some(t => t.text.trim() === 'open')).toBe(false)
})

test('the heading wraps over two lines at most; a longer title ends the second in …', TOKEN, async ($, on) => {
  const title =
    'Docs: config keys and the scopes each token needs on Forgejo, GitLab and GitHub, with examples for every host and every setting'
  world(on, { ...FULL, '/issues/29': { ...ISSUE, title } })
  const all = await texts(await opened($))
  expect(all.some(t => t.startsWith('⊘ #29 Docs: config keys'))).toBe(true)
  // The second line starts under the number, after the mark's two columns.
  const second = all.find(t => t.endsWith('…') && t.startsWith('  ')) ?? ''
  expect(second.length).toBeGreaterThan(2)
  expect(second.length).toBeLessThanOrEqual(60)
  expect(all.some(t => t.includes('every setting'))).toBe(false)
})

test('a closed issue\'s heading is grey as a whole, number and title', TOKEN, async ($, on) => {
  world(on, { ...FULL, '/issues/29': { ...ISSUE, state: 'closed' } })
  const all = await found(await opened($))
  const heading = all.find(t => t.text.startsWith('✓ #29 '))
  expect(heading?.props.color).toBe('inactive')
  expect(heading?.props.bold).toBe(true)
  // No blue number inside it.
  expect(all.some(t => t.text === '#29' && t.props.color === 'suggestion')).toBe(false)
})

test('the lines with nothing to show are left out', TOKEN, async ($, on) => {
  // Only the issue answers; dependencies, timeline and times are off.
  world(on, { '/issues/29': { ...ISSUE, due_date: null, ref: '', labels: [], comments: 0 } })
  const ui = await opened($)
  const all = await texts(ui)

  for (const gone of ['Due', 'Branch', 'Time', 'Labels', 'Blocked by', 'Blocks', 'PRs', 'Commits']) {
    expect(all.some(t => t.trimEnd() === gone)).toBe(false)
  }
  expect(all.some(t => t.includes('Comments'))).toBe(false)
  await expect(ui.find({ key: 'comments-section' })).resolves.toBeUndefined()
  expect(all).toContain('The README lists the old settings.')
})

test('a long description is cut, with how much more there is', TOKEN, async ($, on) => {
  const body = Array.from({ length: 80 }, (_, k) => `line ${k + 1}`).join('\n')
  world(on, { ...FULL, '/issues/29': { ...ISSUE, body } })
  const ui = await opened($)
  const all = await texts(ui)

  expect(all).toContain('line 3')
  expect(all).not.toContain('line 4')
  expect(((await ui.find({ key: 'description-more' })) as { props: { label: string } } | undefined)?.props.label).toBe('… 77 more lines')
  // Folded: its rule a button that unfolds it.
  expect(all.some(t => t.startsWith('+ Description'))).toBe(true)
  await ui.press({ key: 'description-section' })
  const whole = await texts(ui)
  expect(whole.some(t => t.startsWith('− Description'))).toBe(true)
  expect(whole).toContain('line 80')
  expect(whole.some(t => /^… \d+ more lines$/.test(t))).toBe(false)
})

test("What's next goes back to the overview", TOKEN, async ($, on) => {
  world(on, FULL)
  const ui = await opened($)
  await ui.press({ key: 'back' })

  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  await expect(ui.find({ key: 'prompt' })).resolves.toBeUndefined()
})

test("the issue detail's bottom line is the same rule as the lists', its version and all, no repo", TOKEN, async ($, on) => {
  world(on, FULL)
  on('fs.read', (_$, e) => (e.path.endsWith('/.claude-plugin/plugin.json') ? { value: '{"version":"9.8.7"}' } : { deny: 'not here' }))
  const ui = await opened($)
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  expect(found.some(t => t.text.includes('git.example.org'))).toBe(false)
  expect(found.map(t => t.text)).toContain("── What's Next · v9.8.7 ".padEnd(60, '─'))
  expect(found.find(t => t.text === 'v9.8.7')?.props.dimColor).toBe(true)
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { key: string; props: Record<string, unknown> }[]
  const keys = boxes.map(b => b.key)
  expect(boxes.find(b => b.key === 'where')?.props.flexShrink).toBe(0)
  expect(keys.indexOf('where')).toBeGreaterThan(keys.indexOf('detail'))
  // An empty line before it, as before every rule.
  expect(keys.indexOf('where-gap')).toBe(keys.indexOf('where') - 1)
  expect(keys).not.toContain('where-rule')
})

test('says so when the issue cannot be read', TOKEN, async ($, on) => {
  world(on, {})
  const ui = await opened($)

  expect(await texts(ui)).toContain('Could not load #29: HTTP 404.')
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
  // /next asks again too.
  await $.command.run(RUN)
  expect(issue()).toBe(6)
})

type Filled = { text: string; mode?: string }[]

test('reads every page of the timeline, so a late pull request still shows', TOKEN, async ($, on) => {
  const filler = Array.from({ length: 55 }, () => ({ type: 'comment', created_at: '2026-10-01T12:00:00Z', body: 'x', ref_commit_sha: null, ref_issue: null }))
  const late = {
    type: 'pull_ref',
    created_at: '2026-10-06T12:00:00Z',
    body: '',
    ref_commit_sha: null,
    ref_issue: { number: 77, title: 'A late pull request', state: 'open', pull_request: { merged: false } },
  }
  const asked: string[] = []
  world(on, { ...FULL, '/issues/29/timeline': [...filler, late] }, asked)
  const ui = await opened($)
  expect((await texts(ui)).some(t => t.includes('A late pull request'))).toBe(true)
  expect(asked.filter(u => u.includes('/timeline')).map(u => new URL(u).searchParams.get('page'))).toEqual(['1', '2'])
})

test('a repo without time tracking and dependencies is not asked for them', TOKEN, async ($, on) => {
  const asked: string[] = []
  world(on, FULL, asked, [], 'open', { time: false, deps: false })
  await opened($)
  const parts = asked.filter(u => u.includes('/issues/29')).map(u => new URL(u).pathname.split('/issues/29')[1])
  expect(parts.sort()).toEqual(['', '/comments', '/timeline'])
})

const WRITE: Rights = { push: true, scopes: ['write:issue', 'read:repository', 'read:user'] }
const keys = async (ui: { findAll: (q: { type: string }) => Promise<unknown[]> }) =>
  ((await ui.findAll({ type: 'Button' })) as { key: string }[]).map(b => b.key)
const labelOf = async (ui: { find: (q: { key: string }) => Promise<unknown> }, key: string) =>
  ((await ui.find({ key })) as { props: Record<string, unknown> } | undefined)?.props.label

test('with write:issue and push, Assign Me and Close are in the menu, and hidden for their hotkeys', TOKEN, async ($, on) => {
  const clock = world(on, FULL, [], [], 'open', { ...WRITE })
  await clock.set(NOW)
  const ui = await opened($)
  expect(await keys(ui)).toEqual([
    'assign',
    'close',
    'open',
    'refresh',
    'help',
    'back',
    'prompt',
    'menu',
    'follow-24',
    'follow-19',
    'follow-31',
    'comments-section',
    'comment-0',
    'comment-1',
  ])
  expect(await labelOf(ui, 'assign')).toBe('Assign Me')
  expect(await labelOf(ui, 'close')).toBe('Close')
  const hotkey = async (key: string) => ((await ui.find({ key })) as { props: Record<string, unknown> }).props.hotkey
  expect([await hotkey('assign'), await hotkey('close'), await hotkey('open'), await hotkey('refresh'), await hotkey('back'), await hotkey('prompt')]).toEqual(['a', 'c', 'o', 'r', 'b', 'p'])
  const all = await texts(ui)
  expect(all.indexOf('open · ✎ 3w alice')).toBeLessThan(all.indexOf('14 Oct, in 5 days'))

  // The menu open: a line for each, its words then its hotkey.
  await ui.press({ key: 'menu' })
  const menu = (await keys(ui)).filter(k => k.startsWith('menu-'))
  expect(menu).toEqual(['menu-assign', 'menu-close', 'menu-open', 'menu-refresh', 'menu-help'])
  const shown = await texts(ui)
  for (const [label, key] of [
    ['Assign Me', 'a'],
    ['Close', 'c'],
    ['Open in Browser', 'o'],
    ['Refresh', 'r'],
  ] as const) {
    expect(shown.some(t => t.startsWith(label) && t.trimEnd().endsWith(` ${key}`))).toBe(true)
  }
})

test('Assign Me adds you, keeps the others, and the list follows: jdoe\'s alone, #29 leaves it', TOKEN, async ($, on) => {
  const sent: Rights['sent'] = []
  const asked: string[] = []
  world(on, { ...FULL, '/issues/29': { ...ISSUE, assignees: [{ login: 'jdoe' }] } }, asked, [], 'open', { ...WRITE, sent })
  const ui = await opened($)
  const searches = asked.filter(u => u.includes('/issues/search')).length
  await ui.press({ key: 'assign' })
  expect(sent).toEqual([{ method: 'PATCH', path: '/api/v1/repos/boats/radar/issues/29', body: { assignees: ['jdoe', 'alice'] } }])
  expect(asked.filter(u => u.includes('/issues/search')).length).toBeGreaterThan(searches)
  // Back on What's next, #29 under your issues.
  expect((await texts(ui))[0]).toBe("What's next")
  await expect(ui.find({ key: 'pick-29' })).resolves.toBeDefined()
  await ui.press({ key: 'pick-29' })
  expect(await labelOf(ui, 'assign')).toBe('Unassign Me')

  // The search still lists #29 as yours, as a lagging forge would: the
  // issue as read again wins, and someone else's issue leaves What's next.
  await ui.press({ key: 'assign' })
  expect(sent.at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/repos/boats/radar/issues/29', body: { assignees: ['jdoe'] } })
  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  expect(all.some(t => t.includes('#29'))).toBe(false)
})

test('Close closes at once, and the lists leave it out though the search still has it', TOKEN, async ($, on) => {
  const sent: Rights['sent'] = []
  world(on, FULL, [], [], 'open', { ...WRITE, sent })
  const ui = await opened($)
  await ui.press({ key: 'close' })
  expect(sent).toEqual([{ method: 'PATCH', path: '/api/v1/repos/boats/radar/issues/29', body: { state: 'closed' } }])
  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  expect(all.some(t => t.includes('#29'))).toBe(false)
})

test('a refusal says why, in red under the heading line', TOKEN, async ($, on) => {
  world(on, FULL, [], [], 'open', { ...WRITE, sent: [], refuse: { status: 422, message: 'it depends on open issues' } })
  const ui = await opened($)
  await ui.press({ key: 'close' })
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  const line = found.find(t => t.text === 'Could not close #29: it depends on open issues.')
  expect(line?.props.color).toBe('error')
  const all = await texts(ui)
  expect(all.indexOf('open · ✎ 3w alice')).toBeLessThan(all.indexOf('Could not close #29: it depends on open issues.'))
  expect(all.indexOf('Could not close #29: it depends on open issues.')).toBeLessThan(all.indexOf('Blocked by '))
  expect(await labelOf(ui, 'close')).toBe('Close')
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
})

test('Reopen goes back to the list it came from', TOKEN, async ($, on) => {
  const sent: Rights['sent'] = []
  world(on, { ...FULL, '/issues/29': { ...ISSUE, state: 'closed' } }, [], [], 'open', { ...WRITE, sent })
  const ui = await opened($)
  expect(await labelOf(ui, 'close')).toBe('Reopen')
  await ui.press({ key: 'close' })
  expect(sent).toEqual([{ method: 'PATCH', path: '/api/v1/repos/boats/radar/issues/29', body: { state: 'open' } }])
  expect((await texts(ui))[0]).toBe("What's next")
  await expect(ui.find({ key: 'back' })).resolves.toBeUndefined()
})

test('a refused assign keeps the issue open with why, and Prompt stays there too', TOKEN, async ($, on) => {
  const toasts: string[] = []
  world(on, FULL, [], [], 'open', { ...WRITE, sent: [], refuse: { status: 403, message: 'forbidden' } })
  promptBox(on, '', [], true, toasts)
  const ui = await opened($)
  await ui.press({ key: 'assign' })
  expect(await texts(ui)).toContain('Could not assign #29: forbidden.')
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()

  await ui.press({ key: 'prompt' })
  expect(await texts(ui)).toContain('Could not assign #29: forbidden.')
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
})

for (const [why, rights, how] of [
  ['the token lacks write:issue', { push: true }, "Assign and close need a token with write:issue: the setup guide's steps make one."],
  ['alice may not push here', { push: false, scopes: ['write:issue'] }, 'Assign and close need push rights on boats/radar.'],
] as const) {
  test(`read only (${why}): no Assign or Close, one line on how in the menu`, TOKEN, async ($, on) => {
    world(on, FULL, [], [], 'open', { ...rights })
    const ui = await opened($)
    expect(await keys(ui)).toEqual(['open', 'refresh', 'help', 'back', 'prompt', 'menu', 'follow-24', 'follow-19', 'follow-31', 'comments-section', 'comment-0', 'comment-1'])
    // The line on how shows with the menu open, dim, under its lines.
    expect(await texts(ui)).not.toContain(how)
    await ui.press({ key: 'menu' })
    expect((await keys(ui)).filter(k => k.startsWith('menu-'))).toEqual(['menu-open', 'menu-refresh', 'menu-help'])
    // Wrapped to the menu's width, each line its own Text.
    const all = await found(ui)
    const at = all.findIndex(t => t.text.startsWith('Assign and close'))
    const note = all.slice(at).filter(t => t.props.dimColor === true && how.includes(t.text))
    expect(note.map(t => t.text).join(' ')).toBe(how)
    expect(note.every(t => t.props.dimColor === true)).toBe(true)
  })
}

test('scopes not listed: the buttons show, and Forgejo has the last word', TOKEN, async ($, on) => {
  world(on, FULL, [], [], 'open', { push: true, scopes: null })
  const ui = await opened($)
  expect(await keys(ui)).toContain('assign')
})

test('Prompt assigns you first when you are not yet assigned', TOKEN, async ($, on) => {
  const sent: Rights['sent'] = []
  const toasts: string[] = []
  world(on, FULL, [], [], 'open', { ...WRITE, sent })
  promptBox(on, '', [], true, toasts)
  const ui = await opened($)
  await ui.press({ key: 'prompt' })
  expect(sent).toEqual([{ method: 'PATCH', path: '/api/v1/repos/boats/radar/issues/29', body: { assignees: ['alice'] } }])
  expect(toasts.at(-1)).toBe('#29 is yours and in the prompt: Esc to edit it there')
  expect((await texts(ui))[0]).toBe("What's next")

  await ui.press({ key: 'pick-29' })
  await ui.press({ key: 'prompt' })
  expect(sent).toHaveLength(1)
  expect(toasts.at(-1)).toBe('#29 is in the prompt: Esc to edit it there')
  expect((await texts(ui))[0]).toBe("What's next")
})

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
  test(`Prompt drafts the issue into the prompt, with the last comment, on ${surface}`, TOKEN, async ($, on) => {
    const filled: Filled = []
    const toasts: string[] = []
    world(on, FULL)
    promptBox(on, '', filled, true, toasts)
    const ui = await opened($, surface)
    await ui.press({ key: 'prompt' })

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

test('Prompt goes under what is typed already', TOKEN, async ($, on) => {
  const filled: Filled = []
  world(on, { '/issues/29': { ...ISSUE, body: '  ' } })
  promptBox(on, 'also check the README', filled)
  const ui = await opened($)
  await ui.press({ key: 'prompt' })

  expect(filled).toEqual([
    { text: '\n\nWork on #29: Docs: config keys\nhttps://git.example.org/boats/radar/issues/29', mode: 'append' },
  ])
})

test('says so when the prompt cannot take the draft', TOKEN, async ($, on) => {
  const toasts: string[] = []
  world(on, FULL)
  promptBox(on, '', [], false, toasts)
  const ui = await opened($)
  await ui.press({ key: 'prompt' })

  expect(toasts).toEqual(['Could not put #29 in the prompt'])
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
})

test('Open in Browser opens the issue page with open, else xdg-open', TOKEN, async ($, on) => {
  const ran: string[] = []
  world(on, FULL, [], ran, 'xdg-open')
  const ui = await opened($)
  await ui.press({ key: 'open' })
  await expect(ui.find({ key: 'back' })).resolves.toBeDefined()
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
