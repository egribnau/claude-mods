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
  // How many open issues block it.
  blockedBy?: number
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
    // GitHub sends it for issues, never for pull requests.
    ...(extra.pull
      ? {}
      : { issue_dependencies_summary: { blocked_by: extra.blockedBy ?? 0, blocking: 0, total_blocked_by: extra.blockedBy ?? 0, total_blocking: 0 } }),
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
  features: { time: false, deps: true, epics: true },
}

test('check: ready in four requests, with a Bearer token and the API version', async () => {
  const asked: Asked[] = []
  const c = await github(fakeSend(checkRoute(), asked), R, 'github_pat_x', null).check()
  expect(c).toEqual({ version: 'GitHub', setup: READY })
  expect(asked.map(a => a.url)).toEqual([
    `${BASE}/user`,
    API,
    `${API}/issues?state=open&per_page=20`,
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

test('check: dependencies are on where the issues come with their summary, or on github.com with no issue to tell by', async () => {
  const withSummary = await github(fakeSend(checkRoute()), R, 't', null).check()
  expect(withSummary.setup).toEqual(expect.objectContaining({ features: { time: false, deps: true, epics: true } }))

  const { issue_dependencies_summary: _, ...bare } = issue(14, '2026-09-18T09:00:00Z')
  const ghe = { ...R, host: 'github.example.com' }
  const without = await github(fakeSend(checkRoute({ issues: { status: 200, body: [bare] } }, '/api/v3')), ghe, 't', '3.12.4').check()
  expect(without.setup).toEqual(expect.objectContaining({ features: { time: false, deps: false, epics: true } }))

  // A pull request first, as the newest open item, says nothing: the issue after it tells.
  const prFirst = { issues: { status: 200, body: [issue(16, '2026-10-05T09:00:00Z', { pull: true }), bare] } }
  expect((await github(fakeSend(checkRoute(prFirst)), R, 't', null).check()).setup).toEqual(
    expect.objectContaining({ features: { time: false, deps: false, epics: true } }),
  )
  const prThenIssue = { issues: { status: 200, body: [issue(16, '2026-10-05T09:00:00Z', { pull: true }), issue(14, '2026-09-18T09:00:00Z')] } }
  expect((await github(fakeSend(checkRoute(prThenIssue, '/api/v3')), ghe, 't', null).check()).setup).toEqual(
    expect.objectContaining({ features: { time: false, deps: true, epics: true } }),
  )
  // Only pull requests open: no issue to tell by.
  const onlyPr = { issues: { status: 200, body: [issue(16, '2026-10-05T09:00:00Z', { pull: true })] } }
  expect((await github(fakeSend(checkRoute(onlyPr)), R, 't', null).check()).setup).toEqual(
    expect.objectContaining({ features: { time: false, deps: true, epics: true } }),
  )

  const none = { issues: { status: 200, body: [] } }
  expect((await github(fakeSend(checkRoute(none)), R, 't', null).check()).setup).toEqual(
    expect.objectContaining({ features: { time: false, deps: true, epics: true } }),
  )
  expect((await github(fakeSend(checkRoute(none, '/api/v3')), ghe, 't', null).check()).setup).toEqual(
    expect.objectContaining({ features: { time: false, deps: false, epics: true } }),
  )
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
      due: null,
      url: 'https://github.com/boats/radar/issues/12',
      body: 'Body of 12',
      updated: expect.any(String),
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
    { title: 'v1.2', due: '2026-10-31T07:00:00Z', closed: 1, total: 4, description: '', url: 'https://github.com/boats/radar/milestone/2', closedAt: null, id: 2 },
    { title: 'someday', due: null, closed: 0, total: 0, description: '', url: 'https://github.com/boats/radar/milestone/4', closedAt: null, id: 4 },
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
      commentList: null,
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
  // Each issue's blockers, as dependencies/blocked_by lists them.
  deps?: Record<number, unknown[]>
  // The issues with the Epic label, and each epic's sub-issues.
  epics?: unknown[]
  subs?: Record<number, unknown[]>
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
    const blockedBy = /^\/repos\/boats\/radar\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(p)
    if (blockedBy) return reply(200, w.deps?.[Number(blockedBy[1])] ?? [])
    const subs = /^\/repos\/boats\/radar\/issues\/(\d+)\/sub_issues$/.exec(p)
    if (subs) return reply(200, w.subs?.[Number(subs[1])] ?? [])
    if (p === '/repos/boats/radar/issues') {
      if (u.searchParams.get('per_page') === '20') {
        const status = w.issuesStatus ?? 200
        return reply(status, status === 200 ? [] : { message: 'Resource not accessible by personal access token' })
      }
      if (u.searchParams.has('labels')) return reply(200, w.epics ?? [])
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
  expect(all).toContain(rule('In progress · 1'))
  expect(all).toContain('● #12 Issue 12')
  // You work in v1.2, where #12 is yours: Next is taken from there.
  expect(all).toContain(rule('Next · in v1.2'))
  expect(all).toContain('○ #14 Issue 14')
  expect(all).toContain(rule('Queue'))
  expect(all).toContain('○ #21 Issue 21')
  expect(all.some(t => t.includes('#15') || t.includes('#16'))).toBe(false)
  const bug = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'bug')
  // GitHub's colour, without '#', made readable as any label's is.
  expect(bug?.props.color).toBe(readable('d73a4a'))
  expect(all.slice(-4)).toEqual(['3 open · 1 yours', '3 open', ' · ', '1 yours'])
  expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar: 1 in progress, next is #14, in v1.2." }))
  // Only GitHub's API host is asked, always with the token; nothing blocks
  // these, so no dependencies are asked, and no epic has sub-issues to ask.
  expect(asked?.every(a => a.url.startsWith(`${BASE}/`) && a.auth === 'Bearer github_pat_x')).toBe(true)
  expect(asked?.some(a => a.url.includes('/timeline') || a.url.includes('dependencies') || a.url.includes('sub_issues'))).toBe(false)
})

test('github.com: the milestone picker starts on the one due first and narrows to another', GH, async ($, on) => {
  const clock = world(on, { mine: [MINE], open: OPEN, milestones: [V13, V12] })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await texts(ui)
  const label = async () => ((await ui.find({ key: 'milestone' })) as { props: Record<string, unknown> } | undefined)?.props.label
  expect(await label()).toBe('v1.2 ▾')
  expect(all).toContain('○ #14 Issue 14')
  expect(all.some(t => t.includes('#21'))).toBe(false)

  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-m:v1.3' })
  all = await texts(ui)
  expect(await label()).toBe('v1.3 ▾')
  expect(all).toContain('○ #21 Issue 21')
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

// Blockers

const dep = (number: number, state: string, repo = 'boats/radar') => ({
  ...issue(number, '2026-09-01T09:00:00Z'),
  state,
  repository: { full_name: repo },
})

test('blockers: none asked for an issue the open issues said nothing blocks; the open ones of this repo for the rest', async () => {
  const asked: Asked[] = []
  const route = (u: URL): Reply => {
    if (u.pathname === '/repos/boats/radar/issues') {
      return { status: 200, body: [issue(14, '2026-09-18T09:00:00Z'), issue(15, '2026-09-19T09:00:00Z', { blockedBy: 1 })] }
    }
    if (u.pathname === '/repos/boats/radar/issues/15/dependencies/blocked_by') {
      return { status: 200, body: [dep(9, 'open'), dep(8, 'closed'), dep(7, 'open', 'boats/other')] }
    }
    return NOT_FOUND
  }
  const t = github(fakeSend(route, asked), R, 't', null)
  await t.open()
  expect(await t.blockers(14)).toEqual([])
  expect(await t.blockers(15)).toEqual([9])
  // Not in the list: asked.
  expect(await t.blockers(99)).toBeNull()
  expect(asked.map(a => a.url)).toEqual([
    `${API}/issues?state=open&per_page=100`,
    `${API}/issues/15/dependencies/blocked_by?per_page=100`,
    `${API}/issues/99/dependencies/blocked_by?per_page=100`,
  ])
})

test('issue: with dependencies on, what blocks it and what it blocks, this repo only, and whether an open blocker is blocked; off, not asked', async () => {
  const asked: Asked[] = []
  const route = (u: URL): Reply => {
    const p = u.pathname
    if (p === '/repos/boats/radar/issues/15') return { status: 200, body: issue(15, '2026-09-19T09:00:00Z', { blockedBy: 1 }) }
    if (p === '/repos/boats/radar/issues/15/timeline') return { status: 200, body: [] }
    if (p === '/repos/boats/radar/issues/15/dependencies/blocked_by')
      return {
        status: 200,
        body: [
          { ...dep(9, 'open'), issue_dependencies_summary: { blocked_by: 2 } },
          dep(8, 'closed'),
          dep(7, 'open', 'boats/other'),
          { ...dep(6, 'open'), issue_dependencies_summary: undefined },
        ],
      }
    if (p === '/repos/boats/radar/issues/6/dependencies/blocked_by') return { status: 200, body: [dep(5, 'closed')] }
    if (p === '/repos/boats/radar/issues/15/dependencies/blocking') return { status: 200, body: [dep(21, 'open')] }
    return NOT_FOUND
  }
  const t = github(fakeSend(route, asked), R, 't', null)
  const d = await t.issue(15, { time: false, deps: true, epics: false })
  // #9's count says it is blocked; #6 has none, so its blockers are asked:
  // only a closed one, so it is not.
  expect(d.blockedBy).toEqual([
    { number: 9, title: 'Issue 9', state: 'open', blocked: true, assignees: [] },
    { number: 8, title: 'Issue 8', state: 'closed', assignees: [] },
    { number: 6, title: 'Issue 6', state: 'open', blocked: false, assignees: [] },
  ])
  expect(asked.filter(a => a.url.includes('/issues/9/dependencies')).length).toBe(0)
  expect(asked.filter(a => a.url.includes('/issues/6/dependencies/blocked_by')).length).toBe(1)
  // #21 waits on #15 while #15 is open: blocked, and nothing asked.
  expect(d.blocks).toEqual([{ number: 21, title: 'Issue 21', state: 'open', blocked: true, assignees: [] }])
  expect(asked.some(a => a.url.includes('/issues/21/'))).toBe(false)

  asked.length = 0
  const off = await t.issue(15, { time: false, deps: false, epics: false })
  expect(off.blockedBy).toBeNull()
  expect(off.blocks).toBeNull()
  expect(asked.some(a => a.url.includes('/dependencies/'))).toBe(false)
})

test('github.com: an issue with an open blocker waits, the next free one is Next, and only the blocked ones are asked about', GH, async ($, on) => {
  const asked: World['asked'] = []
  const clock = world(on, {
    mine: [],
    open: [
      issue(14, '2026-09-18T09:00:00Z', { blockedBy: 1 }),
      issue(21, '2026-10-02T09:00:00Z'),
      issue(22, '2026-10-03T09:00:00Z'),
      issue(23, '2026-10-04T09:00:00Z', { blockedBy: 2 }),
    ],
    deps: { 14: [dep(9, 'open'), dep(8, 'closed')], 23: [dep(14, 'open'), dep(9, 'open')] },
    asked,
  })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('○ #21 Issue 21')
  expect(all).toContain('⊘ #14 Issue 14')
  // What blocks it, counted: #9.
  expect(all.some(t => t.startsWith('⊘ 1'))).toBe(true)
  // #23, after Next, waits too, at the bottom of the Queue.
  expect(all).toContain('⊘ #23 Issue 23')
  expect(all.indexOf('⊘ #23 Issue 23')).toBeGreaterThan(all.indexOf('○ #22 Issue 22'))
  // Only #14 and #23, which GitHub says are blocked, cost a request: #21 and
  // #22 had none open.
  expect(asked?.filter(a => a.url.includes('/dependencies/')).map(a => new URL(a.url).pathname)).toEqual([
    '/repos/boats/radar/issues/14/dependencies/blocked_by',
    '/repos/boats/radar/issues/23/dependencies/blocked_by',
  ])
})

test('github.com: an issue whose blockers are all closed is pickable, with no request for it', GH, async ($, on) => {
  const asked: World['asked'] = []
  const clock = world(on, { mine: [], open: [issue(14, '2026-09-18T09:00:00Z', { blockedBy: 0 })], deps: { 14: [dep(9, 'closed')] }, asked })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).toContain('○ #14 Issue 14')
  expect(asked?.some(a => a.url.includes('/dependencies/'))).toBe(false)
})

// Epics

const epicIssue = (number: number, title: string, state = 'open', labels = ['Epic'], due?: typeof V12) => ({
  ...issue(number, '2026-08-01T09:00:00Z', { title, labels, milestone: due }),
  state,
})
// A sub-issue as GitHub lists it, in this repo unless `repo` says otherwise.
const sub = (number: number, extra: Extra & { state?: string; repo?: string } = {}) => {
  const i = issue(number, '2026-09-10T09:00:00Z', extra)
  const repo = extra.repo ?? 'boats/radar'
  return { ...i, state: extra.state ?? 'open', html_url: `https://github.com/${repo}/issues/${number}` }
}

test('epics: open and closed issues with the Epic label, any case, pull requests left out', async () => {
  const asked: Asked[] = []
  const route = listRoute('/repos/boats/radar/issues', [
    [
      epicIssue(20, 'Radar sweep', 'open', ['epic'], V12),
      epicIssue(19, 'Old sweep', 'closed', ['Epic']),
      { ...epicIssue(18, 'A pull request', 'open', ['epic']), pull_request: { url: 'x' } },
      // GitHub may answer a label it matched otherwise: only the label counts.
      epicIssue(17, 'Not an epic', 'open', ['epic-ish']),
    ],
  ])
  const found = await github(fakeSend(route, asked), R, 't', null, 'Epic').epics()
  expect(found).toEqual([
    expect.objectContaining({ number: 20, title: 'Radar sweep', state: 'open', milestone: 'v1.2', due: null, assignees: [] }),
    expect.objectContaining({ number: 19, title: 'Old sweep', state: 'closed', milestone: null, due: null, assignees: [] }),
  ])
  // Its labels and when it was opened, for an epic's facts line (#64).
  expect(found[0]?.labels).toEqual([{ name: 'epic', color: 'd73a4a' }])
  expect(found[0]?.created).toBe('2026-08-01T09:00:00Z')
  expect(asked.map(a => a.url)).toEqual([`${API}/issues?state=all&labels=Epic&per_page=100`])
})

test('children: sub-issues of this repo, yours, closed, and blocked asked only where GitHub says so', async () => {
  const asked: Asked[] = []
  const route = (u: URL): Reply => {
    const p = u.pathname
    if (p === '/repos/boats/radar/issues/20/sub_issues') {
      return {
        status: 200,
        body: [
          sub(12, { assignees: ['alice'], blockedBy: 1 }),
          sub(14, { labels: ['bug'], milestone: V12 }),
          sub(15, { blockedBy: 1 }),
          sub(16, { assignees: ['jdoe'] }),
          sub(22, { state: 'closed' }),
          sub(24, { repo: 'boats/sonar' }),
        ],
      }
    }
    if (p === '/repos/boats/radar/issues/15/dependencies/blocked_by') return { status: 200, body: [dep(9, 'open'), dep(8, 'closed')] }
    return NOT_FOUND
  }
  const kids = await github(fakeSend(route, asked), R, 't', null).children(20, 'alice')
  expect(kids?.map(k => [k.number, k.state, k.mine, k.blocked, k.blockedBy, k.assignees])).toEqual([
    [12, 'open', true, false, [], ['alice']],
    [14, 'open', false, false, [], []],
    [15, 'open', false, true, [9], []],
    [16, 'open', false, false, [], ['jdoe']],
    [22, 'closed', false, false, [], []],
  ])
  expect(kids?.[1]).toEqual(expect.objectContaining({ labels: [{ name: 'bug', color: 'd73a4a' }], milestone: 'v1.2', created: '2026-09-10T09:00:00Z' }))
  // Yours is never checked; only #15 said open issues block it.
  expect(asked.map(a => new URL(a.url).pathname)).toEqual([
    '/repos/boats/radar/issues/20/sub_issues',
    '/repos/boats/radar/issues/15/dependencies/blocked_by',
  ])
  expect(await github(fakeSend(() => NOT_FOUND), R, 't', null).children(20, 'alice')).toBeNull()
})

const EPICS_PANE = { ...PANE, requestId: 'next-epics', props: { ...PANE.props, title: 'Epics' } } as const

test('children: each with its own sub-issue count, where GitHub gives one', async () => {
  const route = (u: URL): Reply =>
    u.pathname === '/repos/boats/radar/issues/20/sub_issues'
      ? { status: 200, body: [{ ...sub(14), sub_issues_summary: { total: 3, completed: 1, percent_completed: 33 } }, sub(15)] }
      : NOT_FOUND
  const kids = await github(fakeSend(route), R, 't', null).children(20, 'alice')
  expect(kids?.map(k => k.subIssues)).toEqual([{ closed: 1, total: 3 }, undefined])
})

test('github.com: sub-issues with sub-issues of their own fold in the tree, label or not, as deep as they go', GH, async ($, on) => {
  const asked: World['asked'] = []
  const clock = world(on, {
    mine: [MINE],
    open: OPEN,
    milestones: [V12],
    epics: [epicIssue(20, 'Radar sweep', 'open', ['Epic'], V12)],
    subs: {
      20: [{ ...sub(14), sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } }, sub(15)],
      14: [{ ...sub(30), sub_issues_summary: { total: 1, completed: 0, percent_completed: 0 } }, sub(31, { state: 'closed' })],
      30: [sub(40)],
    },
    asked,
  })
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  const subsAsked = () => asked?.filter(a => a.url.includes('/sub_issues')).map(a => new URL(a.url).pathname.split('/')[5])
  await ui.press({ key: 'fold-20' })
  // #14 has no Epic label: its count comes with it, nothing more is asked.
  expect((await texts(ui)).find(t => t.startsWith('#14 '))).toMatch(/^#14 Issue 14 +1\/2$/)
  expect(subsAsked()).toEqual(['20'])
  await ui.press({ key: 'fold-14' })
  await ui.press({ key: 'fold-30' })
  const all = await texts(ui)
  expect(all).toContain('      ○ #40 Issue 40')
  expect(all).toContain('    ✓ 1 closed')
  expect(subsAsked()).toEqual(['20', '14', '30'])
})

// A row that folds keeps its standing (#45): the fold mark takes its colour.
test('github.com: a sub-issue of yours with sub-issues of its own folds with a green ⊕', GH, async ($, on) => {
  const clock = world(on, {
    mine: [MINE],
    open: OPEN,
    milestones: [V12],
    epics: [epicIssue(20, 'Radar sweep', 'open', ['Epic'], V12)],
    subs: {
      20: [{ ...sub(14, { assignees: ['alice'] }), sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } }, sub(15)],
    },
  })
  await clock.set(NOW)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  await ui.press({ key: 'fold-20' })
  expect(await ui.find({ key: 'fold-14' })).not.toBeNull()
  const found = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: Record<string, unknown> }[]
  // The epic's own fold mark, unfolded, is plain; #14's, yours and folded, is green.
  expect(found.filter(t => t.text === '⊖ ').map(t => t.props.color)).toEqual([undefined])
  expect(found.filter(t => t.text === '⊕ ').map(t => t.props.color)).toEqual(['success'])
})

test('github.com: an epic with its sub-issues in the Epics pane, with the bar and the tallies', GH, async ($, on) => {
  const asked: World['asked'] = []
  const clock = world(on, {
    mine: [MINE],
    open: OPEN,
    milestones: [V12],
    epics: [epicIssue(20, 'Radar sweep', 'open', ['Epic'], V12), epicIssue(19, 'Old sweep', 'closed', ['Epic'], V12)],
    subs: {
      20: [
        sub(12, { assignees: ['alice'] }),
        sub(14, { labels: ['bug'] }),
        sub(15, { blockedBy: 1 }),
        sub(16, { assignees: ['jdoe'] }),
        sub(22, { state: 'closed' }),
      ],
    },
    deps: { 15: [dep(9, 'open')] },
    asked,
  })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })
  let all = await texts(ui)
  expect(all.some(t => t.includes('Radar sweep') && t.includes('1/5'))).toBe(true)
  for (const want of ['● 1', '○ 1', '◌ 1', '⊘ 1']) expect(all).toContain(want)
  expect(all.some(t => t.includes('Old sweep'))).toBe(true)

  await ui.press({ key: 'fold-20' })
  all = await texts(ui)
  expect(all).toContain('  ● #12 Issue 12')
  expect(all).toContain('  ○ #14 Issue 14')
  expect(all).toContain('  ⊘ #15 Issue 15')
  expect(all).toContain('  ✓ 1 closed')
  expect(all.some(t => /could not|error|HTTP/i.test(t))).toBe(false)
  // The closed epic's sub-issues are never asked.
  expect(asked?.filter(a => a.url.includes('/sub_issues')).map(a => new URL(a.url).pathname)).toEqual(['/repos/boats/radar/issues/20/sub_issues'])
})

test('milestones: the description kept, none as empty', async () => {
  const t = github(fakeSend(listRoute('/repos/boats/radar/milestones', [[{ ...V12, description: 'GitHub as a third forge.' }]])), R, 't', null)
  expect((await t.milestones())[0]?.description).toBe('GitHub as a third forge.')
})

test('closedMilestones: the last closed first, at most n; none when refused', async () => {
  const asked: Asked[] = []
  const shut = (title: string, at: string, number: number) => ({ ...milestone(title, null, number, 0, 5), state: 'closed', closed_at: at })
  const pages = [[shut('v1.0', '2026-08-01T10:00:00Z', 4), shut('v1.1', '2026-09-01T10:00:00Z', 5), shut('v0.9', '2026-07-01T10:00:00Z', 6), shut('v1.1.1', '2026-09-20T10:00:00Z', 7)]]
  const t = github(fakeSend(listRoute('/repos/boats/radar/milestones', pages), asked), R, 't', null)
  expect(await t.closedMilestones(3)).toEqual([
    { title: 'v1.1.1', due: null, closed: 5, total: 5, description: '', url: 'https://github.com/boats/radar/milestone/7', closedAt: '2026-09-20T10:00:00Z', id: 7 },
    { title: 'v1.1', due: null, closed: 5, total: 5, description: '', url: 'https://github.com/boats/radar/milestone/5', closedAt: '2026-09-01T10:00:00Z', id: 5 },
    { title: 'v1.0', due: null, closed: 5, total: 5, description: '', url: 'https://github.com/boats/radar/milestone/4', closedAt: '2026-08-01T10:00:00Z', id: 4 },
  ])
  expect(asked.map(a => a.url)).toEqual([`${API}/milestones?state=closed&per_page=100`])
  expect(await github(fakeSend(() => NOT_FOUND), R, 't', null).closedMilestones(3)).toEqual([])
})

// Where you work (docs/whats-next/ORDERING.md): the requests behind it.

test('lastClosed: your closed issues in the milestone by its number, newest change first; the latest closed, pull requests left out', async () => {
  const asked: Asked[] = []
  const closed = (n: number, at: string, extra: Extra = {}) => ({ ...issue(n, '2026-09-01T00:00:00Z', extra), state: 'closed', closed_at: at })
  const route = listRoute('/repos/boats/radar/issues', [
    [
      closed(40, '2026-10-07T10:00:00Z', { milestone: V12 }),
      closed(41, '2026-10-09T10:00:00Z', { milestone: V12 }),
      closed(42, '2026-10-09T11:00:00Z', { milestone: V12, pull: true }),
    ],
  ])
  const t = github(fakeSend(route, asked), R, 'gh-x', null)
  expect(await t.lastClosed({ title: 'v1.2', due: null, closed: 0, total: 0, id: 2 }, 'alice')).toEqual({
    number: 41,
    title: 'Issue 41',
    closed: '2026-10-09T10:00:00Z',
    milestone: 'v1.2',
  })
  const u = new URL(asked[0]?.url ?? '')
  expect(u.searchParams.get('state')).toBe('closed')
  expect(u.searchParams.get('assignee')).toBe('alice')
  expect(u.searchParams.get('milestone')).toBe('2')
  expect(u.searchParams.get('sort')).toBe('updated')
  expect(asked).toHaveLength(1)
  await t.lastClosed('none', 'alice')
  await t.lastClosed('all', 'alice')
  expect(new URL(asked[1]?.url ?? '').searchParams.get('milestone')).toBe('none')
  expect(new URL(asked[2]?.url ?? '').searchParams.has('milestone')).toBe(false)
})

test('parentOf: the parent issue while open and in this repo; members: the sub-issues by number', async () => {
  const parent = (state: string, repo = 'boats/radar') => ({ ...issue(30, '2026-09-01T00:00:00Z'), state, html_url: `https://github.com/${repo}/issues/30` })
  const answer = (body: unknown) => (u: URL): Reply =>
    u.pathname.endsWith('/sub_issues') ? { status: 200, body: [issue(43, '2026-09-01T00:00:00Z'), issue(44, '2026-09-02T00:00:00Z')] } : { status: 200, body }
  const asked: Asked[] = []
  expect(await github(fakeSend(answer(parent('open')), asked), R, 'gh-x', null).parentOf(41)).toBe(30)
  expect(asked.map(a => a.url)).toEqual([`${API}/issues/41/parent`])
  expect(await github(fakeSend(answer(parent('closed'))), R, 'gh-x', null).parentOf(41)).toBe(null)
  expect(await github(fakeSend(answer(parent('open', 'boats/other'))), R, 'gh-x', null).parentOf(41)).toBe(null)
  expect(await github(fakeSend(() => NOT_FOUND), R, 'gh-x', null).parentOf(41)).toBe(null)
  const t = github(fakeSend(answer(null)), R, 'gh-x', null)
  expect(await t.members(30)).toEqual([43, 44])
  expect(t.nested).toBe(true)
})

test('open: how many open issues wait on each comes with the list', async () => {
  const blocking = { ...issue(37, '2026-09-01T00:00:00Z'), issue_dependencies_summary: { blocked_by: 0, blocking: 2, total_blocked_by: 0, total_blocking: 2 } }
  const t = github(fakeSend(listRoute('/repos/boats/radar/issues', [[blocking, issue(38, '2026-09-02T00:00:00Z')]])), R, 'gh-x', null)
  const got = await t.open()
  expect(got.map(i => i.unblocks)).toEqual([2, 0])
})
