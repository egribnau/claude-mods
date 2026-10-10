import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { github, nextLink } from '../hooks/github'
import { readable } from '../hooks/issue'
import type { Send } from '../hooks/tracker'
import type { Repo } from '../types'

// GitHub behind the tracker: answers shaped as GitHub's REST API gives them,
// first against a fake Send, then through the pane.

const R: Repo = { host: 'github.com', owner: 'boats', name: 'radar' }
const BASE = 'https://api.github.com'
const API = `${BASE}/repos/boats/radar`
const NOW = Date.parse('2026-10-09T12:00:00Z')

// Fixtures, as GitHub answers them.

const person = (login: string, id: number) => ({
  login,
  id,
  node_id: `MDQ6VXNlcj${id}`,
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  html_url: `https://github.com/${login}`,
  type: 'User',
  site_admin: false,
})

const USER = { ...person('alice', 991), name: 'Alice Example', public_repos: 12, created_at: '2014-03-02T10:00:00Z' }

const REPO = {
  id: 52117834,
  node_id: 'R_kgDOxyz',
  name: 'radar',
  full_name: 'boats/radar',
  private: true,
  owner: person('boats', 300),
  html_url: 'https://github.com/boats/radar',
  has_issues: true,
  // Pull requests included.
  open_issues_count: 11,
  default_branch: 'main',
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
}

const milestone = (title: string, due: string | null, number: number, open = 3, closed = 1) => ({
  url: `${API}/milestones/${number}`,
  html_url: `https://github.com/boats/radar/milestone/${number}`,
  id: 9900000 + number,
  node_id: `MI_kwDO${number}`,
  number,
  title,
  description: null,
  creator: person('boats', 300),
  open_issues: open,
  closed_issues: closed,
  state: 'open',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  due_on: due,
  closed_at: null,
})

const V12 = milestone('v1.2', '2026-10-31T07:00:00Z', 2)
const V13 = milestone('v1.3', '2026-11-30T08:00:00Z', 3)

type Extra = {
  milestone?: ReturnType<typeof milestone>
  labels?: string[]
  assignees?: string[]
  body?: string | null
  title?: string
  pull?: boolean
}

function issue(number: number, created: string, extra: Extra = {}) {
  const assignees = (extra.assignees ?? []).map((u, k) => person(u, 900 + k))
  return {
    url: `${API}/issues/${number}`,
    html_url: `https://github.com/boats/radar/${extra.pull ? 'pull' : 'issues'}/${number}`,
    id: 2400000000 + number * 37,
    node_id: `I_kwDO${number}`,
    number,
    title: extra.title ?? `Issue ${number}`,
    user: person('jdoe', 777),
    labels: (extra.labels ?? []).map((name, k) => ({
      id: 7700 + k,
      node_id: `LA_kwDO${k}`,
      url: `${API}/labels/${name}`,
      name,
      color: 'd73a4a',
      default: true,
      description: null,
    })),
    state: 'open',
    locked: false,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: extra.milestone ?? null,
    comments: 2,
    created_at: created,
    updated_at: '2026-10-08T09:30:00Z',
    closed_at: null,
    author_association: 'MEMBER',
    body: extra.body === undefined ? `Body of ${number}` : extra.body,
    ...(extra.pull ? { pull_request: { url: `${API}/pulls/${number}`, merged_at: null } } : {}),
    state_reason: null,
  }
}

// The fake Send.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'down'
type Asked = { url: string; method: string; headers: Record<string, string> }

function fakeSend(route: (url: URL) => Reply, asked: Asked[] = []): Send {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    asked.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    const r = route(new URL(url))
    if (r === 'down') throw new Error('connect ECONNREFUSED')
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { 'content-type': 'application/json; charset=utf-8', ...r.headers },
      text: JSON.stringify(r.body ?? {}),
    }
  }) as unknown as Send
}

const NOT_FOUND = { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' } }

type Check = { user?: Reply; repo?: Reply; issues?: Reply; search?: Reply }

// The four answers check asks for, path by path; 404 for anything else.
function checkRoute(c: Check = {}, prefix = '') {
  return (u: URL): Reply => {
    const p = u.pathname.slice(prefix.length)
    if (p === '/user') return c.user ?? { status: 200, body: USER }
    if (p === '/repos/boats/radar') return c.repo ?? { status: 200, body: REPO }
    if (p === '/repos/boats/radar/issues') return c.issues ?? { status: 200, body: [issue(14, '2026-09-18T09:00:00Z')] }
    if (p === '/search/issues') return c.search ?? { status: 200, body: { total_count: 7, incomplete_results: false, items: [] } }
    return NOT_FOUND
  }
}

const READY = {
  kind: 'ready',
  openIssues: 7,
  login: 'alice',
  // Push rights, and a fine-grained token, whose permissions GitHub does not list.
  actions: { kind: 'unknown' },
  features: { time: false, deps: false, epics: false },
}

test('check: ready in four requests, with a Bearer token and the API version', async () => {
  const asked: Asked[] = []
  const c = await github(fakeSend(checkRoute(), asked), R, 'github_pat_x', null).check()
  expect(c).toEqual({ version: 'GitHub', setup: READY })
  expect(asked.map(a => a.url)).toEqual([
    `${BASE}/user`,
    API,
    `${API}/issues?state=open&per_page=1`,
    `${BASE}/search/issues?q=repo%3Aboats%2Fradar%20is%3Aissue%20is%3Aopen&per_page=1`,
  ])
  expect(asked.every(a => a.headers.Authorization === 'Bearer github_pat_x')).toBe(true)
  expect(asked.every(a => a.headers.Accept === 'application/vnd.github+json')).toBe(true)
  expect(asked.every(a => a.headers['X-GitHub-Api-Version'] === '2022-11-28')).toBe(true)
})

test('check: GitHub Enterprise answers under /api/v3 and is named with its version', async () => {
  const asked: Asked[] = []
  const r = { ...R, host: 'github.example.com' }
  const c = await github(fakeSend(checkRoute({}, '/api/v3'), asked), r, 'ghp_x', '3.12.4').check()
  expect(c).toEqual({ version: 'GitHub Enterprise 3.12.4', setup: READY })
  expect(asked[0]?.url).toBe('https://github.example.com/api/v3/user')
})

test('check: a search that fails counts the open issues as the repo does, pull requests and all', async () => {
  for (const search of [{ status: 422, body: { message: 'Validation Failed' } }, 'down'] as Reply[]) {
    const c = await github(fakeSend(checkRoute({ search })), R, 't', null).check()
    expect(c.setup).toEqual({ ...READY, openIssues: 11 })
  }
})

test('check: no token, no request', async () => {
  const asked: Asked[] = []
  const c = await github(fakeSend(checkRoute(), asked), R, null, null).check()
  expect(c).toEqual({ version: 'GitHub', setup: { kind: 'no-token' } })
  expect(asked).toEqual([])
})

test('check: /user with 401 is a refused token, nothing else asked', async () => {
  const asked: Asked[] = []
  const c = await github(fakeSend(checkRoute({ user: { status: 401, body: { message: 'Bad credentials' } } }), asked), R, 't', null).check()
  expect(c.setup).toEqual({ kind: 'token-refused' })
  expect(asked).toHaveLength(1)
})

test('check: a repo the token cannot see is not found', async () => {
  const c = await github(fakeSend(checkRoute({ repo: NOT_FOUND })), R, 't', null).check()
  expect(c.setup).toEqual({ kind: 'not-found' })
})

test('check: the repo refused with 403 is no permission; issues refused names the Issues permission', async () => {
  const forbidden = { status: 403, body: { message: 'Resource not accessible by personal access token' } }
  expect((await github(fakeSend(checkRoute({ repo: forbidden })), R, 't', null).check()).setup).toEqual({ kind: 'no-scope' })
  expect((await github(fakeSend(checkRoute({ issues: forbidden })), R, 't', null).check()).setup).toEqual({
    kind: 'no-scope',
    missing: 'Issues',
  })
})

test("check: GitHub's rate limit is an error that says so, not a missing permission", async () => {
  const limit = {
    status: 403,
    body: { message: 'API rate limit exceeded for user ID 991.' },
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-10-09T13:05:00Z') / 1000) },
  }
  const c = await github(fakeSend(checkRoute({ issues: limit })), R, 't', null).check()
  expect(c.setup).toEqual({ kind: 'error', message: "issues: GitHub's rate limit is used up until 13:05 UTC" })
})

test('check: a repo with its issues turned off says so', async () => {
  const c = await github(fakeSend(checkRoute({ repo: { status: 200, body: { ...REPO, has_issues: false } } })), R, 't', null).check()
  expect(c.setup).toEqual({ kind: 'error', message: 'boats/radar has its issues turned off' })
})

// /user's answer for a classic token, which lists its scopes in a header.
const classic = (scopes: string): Reply => ({ status: 200, body: USER, headers: { 'x-oauth-scopes': scopes } })
const withPush = (push: boolean, priv = true): Reply => ({
  status: 200,
  body: { ...REPO, private: priv, permissions: { ...REPO.permissions, push } },
})

test('check: a classic token with repo and push rights may assign and close', async () => {
  const c = await github(fakeSend(checkRoute({ user: classic('repo, read:org') })), R, 'ghp_x', null).check()
  expect(c.setup).toEqual({ ...READY, actions: { kind: 'ok' } })
})

test('check: public_repo is enough on a public repo only', async () => {
  const pub = await github(fakeSend(checkRoute({ user: classic('public_repo'), repo: withPush(true, false) })), R, 't', null).check()
  expect(pub.setup).toEqual({ ...READY, actions: { kind: 'ok' } })
  const priv = await github(fakeSend(checkRoute({ user: classic('public_repo') })), R, 't', null).check()
  expect(priv.setup).toEqual({ ...READY, actions: { kind: 'read-only', reason: 'scope' } })
})

test('check: without push rights read only, whatever the token', async () => {
  for (const user of [classic('repo'), undefined]) {
    const c = await github(fakeSend(checkRoute({ user, repo: withPush(false) })), R, 't', null).check()
    expect(c.setup).toEqual({ ...READY, actions: { kind: 'read-only', reason: 'push' } })
  }
})

test('check: a host that does not answer is an error naming why', async () => {
  const c = await github(fakeSend(() => 'down'), R, 't', null).check()
  expect(c.setup).toEqual({ kind: 'error', message: 'connect ECONNREFUSED' })
})

test('the tracker names GitHub, its permission, its setting and where to make a token', () => {
  const t = github(fakeSend(() => NOT_FOUND), R, null, null)
  expect(t.name).toBe('GitHub')
  expect(t.setting).toBe('GitHub token')
  expect(t.tokensUrl).toBe('https://github.com/settings/personal-access-tokens')
  expect(t.writeScope).toBe('repo')
})

// Lists

test('nextLink: the next page from a Link header, null on the last', () => {
  expect(
    nextLink(`<${API}/issues?state=open&per_page=100&page=2>; rel="next", <${API}/issues?state=open&per_page=100&page=5>; rel="last"`),
  ).toBe(`${API}/issues?state=open&per_page=100&page=2`)
  expect(nextLink(`<${API}/issues?page=1>; rel="prev", <${API}/issues?page=1>; rel="first"`)).toBeNull()
  expect(nextLink(undefined)).toBeNull()
})

// A list over `pages`, each page linking the next as GitHub does.
function listRoute(path: string, pages: unknown[][], failOn?: number) {
  return (u: URL): Reply => {
    if (u.pathname !== path) return u.pathname === '/user' ? { status: 200, body: USER } : NOT_FOUND
    const page = Number(u.searchParams.get('page') || '1')
    if (page === failOn) return { status: 502, body: { message: 'Server Error' } }
    const next = new URL(u.href)
    next.searchParams.set('page', String(page + 1))
    return {
      status: 200,
      body: pages[page - 1] ?? [],
      headers: page < pages.length ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {},
    }
  }
}

test('mine: asked by login, pull requests left out, labels keep their colour', async () => {
  const asked: Asked[] = []
  const route = listRoute('/repos/boats/radar/issues', [
    [
      issue(12, '2026-09-25T09:00:00Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] }),
      issue(13, '2026-09-26T09:00:00Z', { assignees: ['alice'], pull: true }),
    ],
  ])
  // Who you are is not known yet for this token: asked once, then remembered.
  const t = github(fakeSend(route, asked), R, 'fresh-token', null)
  expect(await t.mine()).toEqual([
    {
      number: 12,
      title: 'Issue 12',
      milestone: 'v1.2',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      created: '2026-09-25T09:00:00Z',
      url: 'https://github.com/boats/radar/issues/12',
      body: 'Body of 12',
    },
  ])
  await t.mine()
  expect(asked.map(a => a.url)).toEqual([
    `${BASE}/user`,
    `${API}/issues?state=open&assignee=alice&per_page=100`,
    `${API}/issues?state=open&assignee=alice&per_page=100`,
  ])
})

test('open: follows the Link header over three pages, each with its assignees', async () => {
  const asked: Asked[] = []
  const pages = [
    [issue(1, '2026-09-01T09:00:00Z', { assignees: ['jdoe'] })],
    [issue(2, '2026-09-02T09:00:00Z'), issue(3, '2026-09-03T09:00:00Z', { pull: true })],
    [issue(4, '2026-09-04T09:00:00Z', { body: null })],
  ]
  const found = await github(fakeSend(listRoute('/repos/boats/radar/issues', pages), asked), R, 't', null).open()
  expect(found.map(i => [i.number, i.assignees])).toEqual([
    [1, ['jdoe']],
    [2, []],
    [4, []],
  ])
  expect(found[2]?.body).toBe('')
  expect(asked.map(a => new URL(a.url).searchParams.get('page'))).toEqual([null, '2', '3'])
})

test('lists: a failing page throws, naming the list', async () => {
  const pages = [[issue(1, '2026-09-01T09:00:00Z')], [issue(2, '2026-09-02T09:00:00Z')]]
  const t = github(fakeSend(listRoute('/repos/boats/radar/issues', pages, 2)), R, 't', null)
  expect(t.open()).rejects.toThrow('open issues: HTTP 502, Server Error')
})

test('milestones: open ones with their due date and closed of all; none when refused', async () => {
  const asked: Asked[] = []
  const t = github(fakeSend(listRoute('/repos/boats/radar/milestones', [[V12, milestone('someday', null, 4, 0, 0)]]), asked), R, 't', null)
  expect(await t.milestones()).toEqual([
    { title: 'v1.2', due: '2026-10-31T07:00:00Z', closed: 1, total: 4 },
    { title: 'someday', due: null, closed: 0, total: 0 },
  ])
  expect(asked.map(a => a.url)).toEqual([`${API}/milestones?state=open&per_page=100`])
  expect(await github(fakeSend(() => NOT_FOUND), R, 't', null).milestones()).toEqual([])
})

test('issue: a timeline that fails leaves comments, pull requests and commits unknown', async () => {
  const asked: Asked[] = []
  const i = issue(12, '2026-09-25T09:00:00Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] })
  const t = github(fakeSend(u => (u.pathname === '/repos/boats/radar/issues/12' ? { status: 200, body: i } : NOT_FOUND), asked), R, 't', null)
  const d = await t.issue(12, { time: false, deps: false, epics: false })
  expect(d).toEqual(
    expect.objectContaining({
      number: 12,
      state: 'open',
      url: 'https://github.com/boats/radar/issues/12',
      author: 'jdoe',
      comments: 2,
      milestone: { title: 'v1.2', due: '2026-10-31T07:00:00Z' },
      assignees: ['alice'],
      logged: null,
      blockedBy: null,
      pulls: null,
      commits: null,
      lastComment: null,
    }),
  )
  expect(asked.map(a => a.url)).toEqual([`${API}/issues/12`, `${API}/issues/12/timeline?per_page=100`])
  expect(t.issue(99, { time: false, deps: false, epics: false })).rejects.toThrow('#99: HTTP 404, Not Found')
})

// The pane, on github.com

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

const GH = { options: { githubTokens: 'github_pat_x', icons: 'text', compact: 'off' } }

type World = {
  // What /user answers with; 200 when left out.
  user?: number
  // What the issues answer with when check asks for one; 200 when left out.
  issuesStatus?: number
  mine?: unknown[]
  // The status your issues answer with; 200 when left out.
  mineStatus?: number
  open?: unknown[]
  milestones?: unknown[]
  asked?: { url: string; auth: string | undefined }[]
}

function world(on: On, w: World) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout =
      cmd === 'git remote get-url origin' ? 'git@github.com:boats/radar.git' : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.asked?.push({ url: e.url, auth: headers.Authorization })
    const u = new URL(e.url)
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status === 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) },
    })
    const p = u.pathname
    if (p === '/user') return w.user && w.user !== 200 ? reply(w.user, { message: 'Bad credentials' }) : reply(200, USER)
    if (p === '/repos/boats/radar') return reply(200, REPO)
    if (p === '/search/issues') return reply(200, { total_count: 3, incomplete_results: false, items: [] })
    if (p === '/repos/boats/radar/milestones') return reply(200, w.milestones ?? [])
    if (p === '/repos/boats/radar/issues') {
      if (u.searchParams.get('per_page') === '1') {
        const status = w.issuesStatus ?? 200
        return reply(status, status === 200 ? [] : { message: 'Resource not accessible by personal access token' })
      }
      if (u.searchParams.has('assignee')) return reply(w.mineStatus ?? 200, w.mineStatus ? { message: 'Server Error' } : (w.mine ?? []))
      return reply(200, w.open ?? [])
    }
    return reply(404, { message: 'Not Found' })
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const rule = (name: string) => `── ${name} `.padEnd(50, '─')

// #12 is yours; #14 is the oldest free one, so Next; #15 is someone else's;
// #16 is a pull request; #21 waits in the queue, in v1.3.
const MINE = issue(12, '2026-09-25T09:00:00Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] })
const OPEN = [
  MINE,
  issue(14, '2026-09-18T09:00:00Z', { milestone: V12 }),
  issue(15, '2026-09-01T09:00:00Z', { assignees: ['jdoe'] }),
  issue(16, '2026-08-01T09:00:00Z', { pull: true }),
  issue(21, '2026-10-02T09:00:00Z', { milestone: V13 }),
]

test("github.com: What's next shows your issue and the free ones, pull requests left out", GH, async ($, on) => {
  const asked: World['asked'] = []
  const clock = world(on, { mine: [MINE], open: OPEN, asked })
  await clock.set(NOW)

  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all[0]).toBe("What's next")
  expect(all).toContain(rule('In progress (1)'))
  expect(all).toContain('● #12 Issue 12')
  expect(all).toContain(rule('Next'))
  expect(all).toContain('▸ #14 Issue 14')
  expect(all).toContain(rule('Queue (1)'))
  expect(all).toContain('  #21 Issue 21')
  expect(all.some(t => t.includes('#15') || t.includes('#16'))).toBe(false)
  const bug = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'bug')
  // GitHub's colour, without '#', made readable as any label's is.
  expect(bug?.props.color).toBe(readable('d73a4a'))
  expect(all.slice(-4)).toEqual(['github.com/', 'boats/radar', '3 open · ', '1 yours'])
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #14." }))
  // Only GitHub's API host is asked, always with the token; no blockers or epics.
  expect(asked?.every(a => a.url.startsWith(`${BASE}/`) && a.auth === 'Bearer github_pat_x')).toBe(true)
  expect(asked?.some(a => a.url.includes('labels=') || a.url.includes('/timeline') || a.url.includes('dependencies'))).toBe(false)
})

test('github.com: the milestone picker starts on the one due first and narrows to another', GH, async ($, on) => {
  const clock = world(on, { mine: [MINE], open: OPEN, milestones: [V13, V12] })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await texts(ui)
  const label = async () => ((await ui.find({ key: 'milestone' })) as { props: Record<string, unknown> } | undefined)?.props.label
  expect(await label()).toBe('v1.2 ▾')
  expect(all).toContain('▸ #14 Issue 14')
  expect(all.some(t => t.includes('#21'))).toBe(false)

  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-m:v1.3' })
  all = await texts(ui)
  expect(await label()).toBe('v1.3 ▾')
  expect(all).toContain('▸ #21 Issue 21')
  expect(all.some(t => t.includes('#12') || t.includes('#14'))).toBe(false)
})

test('github.com: setup passes with the open issues counted, actions unknown for a fine-grained token', GH, async ($, on) => {
  // Your issues failing keeps the steps on screen.
  world(on, { mineStatus: 500, open: OPEN })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all[0]).toBe('Could not load the issues: your issues: HTTP 500, Server Error.')
  expect(all).toEqual(
    expect.arrayContaining([
      '✓ Repo    boats/radar',
      '✓ Forge   GitHub at github.com',
      '✓ Token   from GitHub token',
      '✓ Access  3 open issues, as alice',
      '· Actions unknown, scopes not listed',
    ]),
  )
})

test('github.com without a token: how to make one for GitHub, and nothing asked', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   GitHub at github.com')
  expect(all).toContain('✗ Token   none found')
  expect(all).toContain(
    '1. Create a token at https://github.com/settings/personal-access-tokens with Issues read and write, or read for read only; a classic token needs repo.',
  )
  expect(all).toContain(
    '2. Run /plugin configure whats-next@egribnau-mods and paste it as GitHub token, alone or as github.com=<token> next to tokens for other hosts.',
  )
  expect(asked).toEqual([])
})

test('github.com refusing the token: says GitHub did not accept it', GH, async ($, on) => {
  world(on, { user: 401 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Token   from GitHub token')
  expect(all).toContain('✗ Access  token refused')
  expect(all).toContain('GitHub did not accept the token from GitHub token: it may be mistyped, expired or revoked.')
})

test('github.com with a token that may not read issues: names the Issues permission', GH, async ($, on) => {
  world(on, { issuesStatus: 403 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Access  no Issues')
  expect(all).toContain("The token from GitHub token reads boats/radar, but not its issues: What's Next needs the Issues permission.")
})
