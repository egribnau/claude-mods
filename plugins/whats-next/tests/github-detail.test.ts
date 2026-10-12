import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { github } from '../hooks/github'
import type { Send } from '../hooks/tracker'
import type { Repo } from '../types'

// A GitHub issue's detail, assign and close: first against a fake Send,
// then through the pane.

const R: Repo = { host: 'github.com', owner: 'boats', name: 'radar' }
const API = 'https://api.github.com/repos/boats/radar'
const NOW = Date.parse('2026-10-09T12:00:00Z')
const OFF = { time: false, deps: false, epics: false }

const person = (login: string, id: number) => ({ login, id, type: 'User', html_url: `https://github.com/${login}` })

function issue(number: number, extra: { assignees?: string[]; state?: string } = {}) {
  const assignees = (extra.assignees ?? []).map((u, k) => person(u, 900 + k))
  return {
    url: `${API}/issues/${number}`,
    html_url: `https://github.com/boats/radar/issues/${number}`,
    id: 2400000000 + number,
    number,
    title: `Issue ${number}`,
    user: person('jdoe', 777),
    labels: [{ id: 1, name: 'bug', color: 'd73a4a', default: true, description: null }],
    state: extra.state ?? 'open',
    locked: false,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: { number: 2, title: 'v1.2', due_on: '2026-10-31T07:00:00Z', open_issues: 3, closed_issues: 1, state: 'open' },
    comments: 2,
    created_at: '2026-09-18T09:00:00Z',
    updated_at: '2026-10-08T09:30:00Z',
    closed_at: null,
    body: 'Body of 14',
    state_reason: null,
  }
}

// Timeline events, as GitHub lists them, oldest first.
const comment = (login: string, created: string, body: string) => ({
  event: 'commented',
  id: 3000000 + created.length,
  actor: person(login, 1),
  user: person(login, 1),
  created_at: created,
  updated_at: created,
  body,
  author_association: 'MEMBER',
})
const crossRef = (number: number, title: string, state: string, merged: string | null, repo = 'boats/radar', pull = true) => ({
  event: 'cross-referenced',
  actor: person('mvos', 2),
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  source: {
    type: 'issue',
    issue: {
      number,
      title,
      state,
      html_url: `https://github.com/${repo}/pull/${number}`,
      ...(pull ? { pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}`, merged_at: merged } } : {}),
      repository: { full_name: repo },
    },
  },
})
const referenced = (sha: string, created: string) => ({
  event: 'referenced',
  actor: person('alice', 991),
  commit_id: sha,
  commit_url: `${API}/commits/${sha}`,
  created_at: created,
})
const labeled = { event: 'labeled', actor: person('jdoe', 777), created_at: '2026-09-18T09:01:00Z', label: { name: 'bug', color: 'd73a4a' } }

const SHA = (k: number) => `${k}`.repeat(40).slice(0, 40)

const TIMELINE = [
  labeled,
  comment('jdoe', '2026-09-20T09:00:00Z', 'First thought.'),
  crossRef(61, 'Fix the crash', 'closed', '2026-10-02T10:00:00Z'),
  crossRef(63, 'Try another way', 'open', null),
  crossRef(61, 'Fix the crash', 'closed', '2026-10-02T10:00:00Z'),
  crossRef(5, 'Elsewhere', 'open', null, 'mvos/fork'),
  crossRef(22, 'An issue, no pull request', 'open', null, 'boats/radar', false),
  referenced(SHA(1), '2026-10-03T10:00:00Z'),
  referenced(SHA(2), '2026-10-04T10:00:00Z'),
  referenced(SHA(3), '2026-10-05T10:00:00Z'),
  referenced(SHA(4), '2026-10-06T10:00:00Z'),
  referenced(SHA(4), '2026-10-06T10:00:00Z'),
  comment('mvos', '2026-10-07T09:00:00Z', 'Also mention the desktop app.'),
]

const commit = (sha: string, message: string) => ({ sha, commit: { message, author: { name: 'Alice', date: '2026-10-03T10:00:00Z' } } })

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }
type Asked = { url: string; method: string; body?: unknown; auth?: string }

function fakeSend(route: (u: URL, method: string) => Reply, asked: Asked[] = []): Send {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? 'GET'
    asked.push({ url, method, auth: init?.headers?.Authorization, ...(init?.body ? { body: JSON.parse(init.body) } : {}) })
    const r = route(new URL(url), method)
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { 'content-type': 'application/json', ...r.headers }, text: JSON.stringify(r.body ?? {}) }
  }) as unknown as Send
}

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } }

function detailRoute(timeline: unknown[] | null = TIMELINE) {
  return (u: URL): Reply => {
    const p = u.pathname
    if (p === '/repos/boats/radar/issues/14') return { status: 200, body: issue(14, { assignees: ['alice'] }) }
    if (p === '/repos/boats/radar/issues/14/timeline') return timeline ? { status: 200, body: timeline } : { status: 500, body: { message: 'Server Error' } }
    const c = /^\/repos\/boats\/radar\/commits\/(\w+)$/.exec(p)
    if (c?.[1] === SHA(4)) return { status: 200, body: commit(SHA(4), 'Handle empty input\n\nLonger text.') }
    if (c?.[1] === SHA(3)) return { status: 200, body: commit(SHA(3), 'Add a test') }
    return NOT_FOUND
  }
}

test('issue: every comment oldest first, pull requests of this repo with merged, and the three newest commits', async () => {
  const asked: Asked[] = []
  const d = await github(fakeSend(detailRoute(), asked), R, 't', null).issue(14, OFF)
  expect(d.commentList).toEqual([
    { author: 'jdoe', when: '2026-09-20T09:00:00Z', body: 'First thought.' },
    { author: 'mvos', when: '2026-10-07T09:00:00Z', body: 'Also mention the desktop app.' },
  ])
  expect(d.pulls).toEqual([
    { number: 61, title: 'Fix the crash', state: 'merged' },
    { number: 63, title: 'Try another way', state: 'open' },
  ])
  // Newest first; a commit GitHub will not show keeps its sha, without a message.
  expect(d.commits).toEqual([
    { sha: SHA(4).slice(0, 7), message: 'Handle empty input', when: '2026-10-06T10:00:00Z' },
    { sha: SHA(3).slice(0, 7), message: 'Add a test', when: '2026-10-05T10:00:00Z' },
    { sha: SHA(2).slice(0, 7), message: '', when: '2026-10-04T10:00:00Z' },
  ])
  expect(d).toEqual(expect.objectContaining({ logged: null, estimate: null, branch: null, due: null, comments: 2, assignees: ['alice'] }))
  // The issue, its timeline, and one request per commit shown.
  expect(asked.map(a => a.url)).toEqual([
    `${API}/issues/14`,
    `${API}/issues/14/timeline?per_page=100`,
    `${API}/commits/${SHA(4)}`,
    `${API}/commits/${SHA(3)}`,
    `${API}/commits/${SHA(2)}`,
  ])
})

test('issue: a quiet timeline has no comments, pull requests or commits, and asks for none', async () => {
  const asked: Asked[] = []
  const d = await github(fakeSend(detailRoute([labeled]), asked), R, 't', null).issue(14, OFF)
  expect(d.commentList).toEqual([])
  expect(d.pulls).toEqual([])
  expect(d.commits).toEqual([])
  expect(asked).toHaveLength(2)
})

test('issue: a failing timeline leaves its parts unknown, and the issue loads', async () => {
  const d = await github(fakeSend(detailRoute(null)), R, 't', null).issue(14, OFF)
  expect(d.number).toBe(14)
  expect(d.pulls).toBeNull()
  expect(d.commits).toBeNull()
  expect(d.commentList).toBeNull()
})

// Writes

function writeRoute(answer: Reply = { status: 200, body: issue(14) }) {
  return (u: URL, method: string): Reply => (method === 'PATCH' && u.pathname === '/repos/boats/radar/issues/14' ? answer : NOT_FOUND)
}

test('assign: the whole list of assignees in one PATCH, with the token; nobody is an empty list', async () => {
  const asked: Asked[] = []
  const t = github(fakeSend(writeRoute(), asked), R, 'ghp_x', null)
  expect(await t.assign(14, ['jdoe', 'alice'])).toBeNull()
  expect(await t.assign(14, [])).toBeNull()
  expect(asked).toEqual([
    { url: `${API}/issues/14`, method: 'PATCH', auth: 'Bearer ghp_x', body: { assignees: ['jdoe', 'alice'] } },
    { url: `${API}/issues/14`, method: 'PATCH', auth: 'Bearer ghp_x', body: { assignees: [] } },
  ])
})

test('close and reopen: state closed or open', async () => {
  const asked: Asked[] = []
  const t = github(fakeSend(writeRoute(), asked), R, 't', null)
  expect(await t.close(14, true)).toBeNull()
  expect(await t.close(14, false)).toBeNull()
  expect(asked.map(a => a.body)).toEqual([{ state: 'closed' }, { state: 'open' }])
})

test('a milestone closes and reopens by its number: state closed or open', async () => {
  const asked: Asked[] = []
  const route = (u: URL, method: string): Reply => (method === 'PATCH' && u.pathname === '/repos/boats/radar/milestones/2' ? { status: 200, body: {} } : NOT_FOUND)
  const t = github(fakeSend(route, asked), R, 't', null)
  const m = { title: 'v1.2', due: null, closed: 1, total: 4, id: 2 }
  expect(await t.closeMilestone(m, true)).toBeNull()
  expect(await t.closeMilestone(m, false)).toBeNull()
  expect(asked.map(a => [a.method, a.url, a.body])).toEqual([
    ['PATCH', `${API}/milestones/2`, { state: 'closed' }],
    ['PATCH', `${API}/milestones/2`, { state: 'open' }],
  ])
})

test("a refused write says GitHub's message with the status", async () => {
  const t = github(fakeSend(writeRoute({ status: 403, body: { message: 'Resource not accessible by personal access token' } })), R, 't', null)
  expect(await t.close(14, true)).toBe('HTTP 403, Resource not accessible by personal access token')
})

// The pane, on github.com

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

const GH = { options: { githubTokens: 'ghp_x', icons: 'text', compact: 'off' } }

type Pane = {
  // The classic token's scopes; none for a fine-grained token.
  scopes?: string
  push?: boolean
  sent?: { body: Record<string, unknown> }[]
  refuse?: Reply
  asked?: string[]
  // GitHub's lists lagging every change, as they do for a few seconds:
  // they keep showing the issue as it was before.
  lag?: boolean
}

function paneWorld(on: On, w: Pane) {
  const clock = mock.clock(on)
  let now = issue(14)
  const before = now
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? 'git@github.com:boats/radar.git' : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    w.asked?.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    const u = new URL(e.url)
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
      value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json', ...extra }, text: JSON.stringify(body) },
    })
    const p = u.pathname
    if (e.init?.method === 'PATCH') {
      const body = JSON.parse(String(e.init.body ?? '{}')) as Record<string, unknown>
      w.sent?.push({ body })
      if (w.refuse) return reply(w.refuse.status, w.refuse.body)
      if (Array.isArray(body.assignees)) now = { ...now, assignees: (body.assignees as string[]).map((l, k) => person(l, 900 + k)) }
      if (body.state === 'closed' || body.state === 'open') now = { ...now, state: body.state }
      return reply(200, now)
    }
    if (p === '/user') return reply(200, { ...person('alice', 991), name: 'Alice' }, w.scopes !== undefined ? { 'x-oauth-scopes': w.scopes } : {})
    if (p === '/repos/boats/radar') {
      return reply(200, { full_name: 'boats/radar', private: true, has_issues: true, open_issues_count: 1, permissions: { push: w.push ?? true, pull: true } })
    }
    if (p === '/search/issues') return reply(200, { total_count: now.state === 'open' ? 1 : 0, items: [] })
    if (p === '/repos/boats/radar/milestones') return reply(200, [])
    if (p === '/repos/boats/radar/issues') {
      const listed = w.lag ? before : now
      const open = listed.state === 'open' ? [listed] : []
      if (u.searchParams.has('assignee')) return reply(200, open.filter(i => i.assignees.some(a => a.login === 'alice')))
      return reply(200, open)
    }
    if (p === '/repos/boats/radar/issues/14') return reply(200, now)
    if (p === '/repos/boats/radar/issues/14/timeline') return reply(200, TIMELINE)
    if (p.startsWith('/repos/boats/radar/commits/')) return reply(200, commit(p.split('/').at(-1) ?? '', 'A commit'))
    return reply(404, { message: 'Not Found' })
  })
  return clock
}

type Ui = {
  findAll: (q: { type: string }) => Promise<unknown[]>
  find: (q: { key: string }) => Promise<unknown>
  press: (q: { key: string }) => Promise<unknown>
}
const texts = async (ui: Ui) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)
const keys = async (ui: Ui) => ((await ui.findAll({ type: 'Button' })) as { key: string }[]).map(b => b.key)
const labelOf = async (ui: Ui, key: string) => ((await ui.find({ key })) as { props: Record<string, unknown> } | undefined)?.props.label

// /next, then #14 picked from What's next.
async function opened($: Engine) {
  await $.command.run(RUN)
  const ui = (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
  await ui.press({ key: 'pick-14' })
  return ui
}

test('github.com detail: the comments, pull requests and commits; no Time line', GH, async ($, on) => {
  const clock = paneWorld(on, {})
  await clock.set(NOW)
  const ui = await opened($)
  const all = await texts(ui)

  expect(all.some(t => t.includes('Issue 14'))).toBe(true)
  // The newest comment unfolded under the rule, the older one a line that unfolds it.
  expect(all.some(t => t.startsWith('− Comments · 2 '))).toBe(true)
  expect(all).toContain('− mvos · 2d ago')
  expect(all).toContain('Also mention the desktop app.')
  expect(all).toContain('+ jdoe · 2w ago · First thought.')
  expect(all).not.toContain('First thought.')
  for (const want of ['#61 ', 'Fix the crash', ' merged', '#63 ', 'Try another way']) {
    expect(all.some(t => t === want || t.includes(want))).toBe(true)
  }
  expect(all.some(t => t.includes('Elsewhere') || t.includes('An issue, no pull request'))).toBe(false)
  expect(all.some(t => t.trimEnd() === 'Time' || t.includes('logged') || t.includes('estimated'))).toBe(false)
})

test('github.com detail: with push rights and a fine-grained token, Assign Me and Close show', GH, async ($, on) => {
  paneWorld(on, {})
  const ui = await opened($)
  const k = await keys(ui)
  expect(k).toContain('assign')
  expect(k).toContain('close')
  expect(await labelOf(ui, 'assign')).toBe('Assign Me')
  // In the menu too, each a line.
  await ui.press({ key: 'menu' })
  const m = await keys(ui)
  expect(m).toContain('menu-assign')
  expect(m).toContain('menu-close')
})

test('github.com detail: Assign Me sends you as assignee, and the reload shows you assigned', GH, async ($, on) => {
  const sent: Pane['sent'] = []
  paneWorld(on, { sent, scopes: 'repo' })
  const ui = await opened($)
  await ui.press({ key: 'assign' })

  expect(sent).toEqual([{ body: { assignees: ['alice'] } }])
  // Back on the list, now yours: In progress.
  expect(await texts(ui)).toContain('● #14 Issue 14')

  await ui.press({ key: 'pick-14' })
  expect(await labelOf(ui, 'assign')).toBe('Unassign Me')
  await ui.press({ key: 'assign' })
  expect(sent.at(-1)?.body).toEqual({ assignees: [] })
  await ui.press({ key: 'pick-14' })
  expect(await labelOf(ui, 'assign')).toBe('Assign Me')
})

test("github.com detail: Close sends state closed, and the reloaded lists leave #14 out", GH, async ($, on) => {
  const sent: Pane['sent'] = []
  paneWorld(on, { sent, scopes: 'repo' })
  const ui = await opened($)
  await ui.press({ key: 'close' })

  expect(sent).toEqual([{ body: { state: 'closed' } }])
  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  expect(all.some(t => t.includes('#14'))).toBe(false)
})

test("github.com detail: a refused close says GitHub's message, in red", GH, async ($, on) => {
  paneWorld(on, { sent: [], refuse: { status: 403, body: { message: 'Resource not accessible by personal access token' } } })
  const ui = await opened($)
  await ui.press({ key: 'close' })

  // One Text per wrapped line, each red.
  const found = (await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]
  const red = found.filter(t => t.props.color === 'error').map(t => t.text)
  expect(red.length).toBeGreaterThan(1)
  expect(red.join(' ')).toBe('Could not close #14: HTTP 403, Resource not accessible by personal access token.')
})

for (const [why, w, notice] of [
  ['alice may not push', { push: false }, 'Assign and close need push rights on boats/radar.'],
  ['a classic token without repo', { scopes: 'read:org' }, "Assign and close need a token with repo: the setup guide's steps make one."],
] as const) {
  test(`github.com read only (${why}): no Assign or Close, one line on how`, GH, async ($, on) => {
    paneWorld(on, { ...w })
    const ui = await opened($)
    const k = await keys(ui)
    expect(k).not.toContain('assign')
    expect(k).not.toContain('close')
    expect(k).toContain('prompt')
    // The sentence only with the menu open, dim under its lines.
    expect((await texts(ui)).join(' ')).not.toContain(notice)
    await ui.press({ key: 'menu' })
    const m = await keys(ui)
    expect(m).not.toContain('menu-assign')
    expect(m).not.toContain('menu-close')
    expect(m).toContain('menu-open')
    const found = (await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]
    const dim = found.filter(t => t.props.dimColor === true).map(t => t.text)
    expect(dim.join(' ')).toContain(notice)
  })
}

test("github.com detail: lists that lag a change still show it at once, Assign Me and Close alike", GH, async ($, on) => {
  const clock = paneWorld(on, { sent: [], scopes: 'repo', lag: true })
  await clock.set(NOW)
  const ui = await opened($)
  await ui.press({ key: 'assign' })
  expect(await texts(ui)).toContain('● #14 Issue 14')

  await ui.press({ key: 'pick-14' })
  await ui.press({ key: 'assign' })
  let all = await texts(ui)
  expect(all).not.toContain('● #14 Issue 14')
  expect(all).toContain('○ #14 Issue 14')

  await ui.press({ key: 'pick-14' })
  await ui.press({ key: 'close' })
  all = await texts(ui)
  expect(all.some(t => t.includes('#14'))).toBe(false)
})
