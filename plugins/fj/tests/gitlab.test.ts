import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitlab } from '../hooks/gitlab'
import type { Send } from '../hooks/tracker'
import type { Repo } from '../types'

// GitLab behind the tracker: answers shaped as GitLab's API v4 gives them,
// first against a fake Send, then through the pane.

const R: Repo = { host: 'gitlab.com', owner: 'boats', name: 'radar' }
const BASE = 'https://gitlab.com/api/v4'
const PROJECT = `${BASE}/projects/boats%2Fradar`
const NOW = Date.parse('2026-10-09T12:00:00Z')

// Fixtures, as GitLab answers them.

const SELF = {
  id: 4711,
  name: 'fj',
  revoked: false,
  created_at: '2026-09-01T08:12:44.512Z',
  description: '',
  scopes: ['read_api', 'read_user'],
  user_id: 991,
  last_used_at: '2026-10-09T07:00:00.000Z',
  active: true,
  expires_at: '2027-09-01',
}

const USER = {
  id: 991,
  username: 'alice',
  name: 'Alice Example',
  state: 'active',
  locked: false,
  avatar_url: 'https://secure.gravatar.com/avatar/x?s=80&d=identicon',
  web_url: 'https://gitlab.com/alice',
  bot: false,
}

const PROJ = {
  id: 52117834,
  description: null,
  name: 'radar',
  name_with_namespace: 'boats / radar',
  path: 'radar',
  path_with_namespace: 'boats/radar',
  default_branch: 'main',
  web_url: 'https://gitlab.com/boats/radar',
  issues_enabled: true,
  open_issues_count: 7,
  visibility: 'private',
}

const person = (username: string, id: number) => ({
  id,
  username,
  name: username,
  state: 'active',
  locked: false,
  avatar_url: `https://secure.gravatar.com/avatar/${username}?s=80&d=identicon`,
  web_url: `https://gitlab.com/${username}`,
})

const milestone = (title: string, due: string | null, id: number) => ({
  id,
  iid: id % 100,
  project_id: 52117834,
  title,
  description: '',
  state: 'active',
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
  due_date: due,
  start_date: null,
  expired: false,
  web_url: `https://gitlab.com/boats/radar/-/milestones/${id % 100}`,
})

const V12 = milestone('v1.2', '2026-10-31', 4410102)
const V13 = milestone('v1.3', '2026-11-30', 4410103)

type Extra = {
  milestone?: ReturnType<typeof milestone>
  labels?: string[]
  assignees?: string[]
  description?: string | null
  title?: string
}

// An issue: `id` is global and never what fj shows; `iid` is the number in
// the project.
function issue(iid: number, created: string, extra: Extra = {}) {
  const assignees = (extra.assignees ?? []).map((u, k) => person(u, 900 + k))
  return {
    id: 160000000 + iid * 37,
    iid,
    project_id: 52117834,
    title: extra.title ?? `Issue ${iid}`,
    description: extra.description === undefined ? `Body of ${iid}` : extra.description,
    state: 'opened',
    created_at: created,
    updated_at: '2026-10-08T09:30:00.000Z',
    closed_at: null,
    closed_by: null,
    labels: (extra.labels ?? []).map((name, k) => ({
      id: 3300 + k,
      name,
      color: '#d9534f',
      description: null,
      description_html: '',
      text_color: '#FFFFFF',
    })),
    milestone: extra.milestone ?? null,
    assignees,
    author: person('jdoe', 777),
    type: 'ISSUE',
    assignee: assignees[0] ?? null,
    user_notes_count: 3,
    merge_requests_count: 0,
    upvotes: 0,
    downvotes: 0,
    due_date: null,
    confidential: false,
    discussion_locked: null,
    issue_type: 'issue',
    web_url: `https://gitlab.com/boats/radar/-/issues/${iid}`,
    time_stats: { time_estimate: 0, total_time_spent: 0, human_time_estimate: null, human_total_time_spent: null },
    task_completion_status: { count: 0, completed_count: 0 },
    has_tasks: false,
    references: { short: `#${iid}`, relative: `#${iid}`, full: `boats/radar#${iid}` },
    severity: 'UNKNOWN',
  }
}

// GitLab's page headers, lower-cased as the engine hands them over. `next`:
// '' on the last page.
const pageHeaders = (page: number, next: string, total: number) => ({
  'content-type': 'application/json',
  'x-page': String(page),
  'x-next-page': next,
  'x-prev-page': page > 1 ? String(page - 1) : '',
  'x-per-page': '100',
  'x-total': String(total),
  'x-total-pages': String(Math.max(1, Math.ceil(total / 100))),
})

// The fake Send.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'down'
type Asked = { url: string; method: string; headers: Record<string, string> }

// A Send answering through `route`, recording each request.
function fakeSend(route: (url: URL) => Reply, asked: Asked[] = []): Send {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    asked.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    const r = route(new URL(url))
    if (r === 'down') throw new Error('connect ECONNREFUSED')
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: r.headers ?? { 'content-type': 'application/json' },
      text: JSON.stringify(r.body ?? {}),
    }
  }) as unknown as Send
}

type Check = { self?: Reply; user?: Reply; project?: Reply }

// The three answers check asks for, path by path; 404 for anything else.
function checkRoute(c: Check = {}) {
  return (u: URL): Reply => {
    const p = u.pathname
    if (p === '/api/v4/personal_access_tokens/self') return c.self ?? { status: 200, body: SELF }
    if (p === '/api/v4/user') return c.user ?? { status: 200, body: USER }
    if (p.startsWith('/api/v4/projects/') && !p.slice('/api/v4/projects/'.length).includes('/')) {
      return c.project ?? { status: 200, body: PROJ }
    }
    return { status: 404, body: { message: '404 Not Found' } }
  }
}

const READY = {
  kind: 'ready',
  openIssues: 7,
  login: 'alice',
  actions: { kind: 'read-only', reason: 'later' },
  features: { time: false, deps: false, epics: false },
}

// check()

test('check: ready in exactly three requests, with PRIVATE-TOKEN and no Authorization', async () => {
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(checkRoute(), asked), R, 'glpat-x', null).check()

  expect(got).toEqual({ version: 'GitLab', setup: READY })
  expect(asked.map(a => a.url)).toEqual([`${BASE}/personal_access_tokens/self`, `${BASE}/user`, PROJECT])
  for (const a of asked) {
    expect(a.method).toBe('GET')
    expect(a.headers['PRIVATE-TOKEN']).toBe('glpat-x')
    expect(a.headers.Authorization).toBeUndefined()
  }
})

test('check: the version detection found is shown', async () => {
  const got = await gitlab(fakeSend(checkRoute()), { ...R, host: 'gitlab.example.com' }, 'glpat-x', '17.2.1').check()
  expect(got.version).toBe('GitLab 17.2.1')
  expect(got.setup).toEqual(READY)
})

test('check: a token with api passes as well as one with read_api', async () => {
  const got = await gitlab(fakeSend(checkRoute({ self: { status: 200, body: { ...SELF, scopes: ['api'] } } })), R, 'glpat-x', null).check()
  expect(got.setup).toEqual(READY)
})

test('check: no token, no request', async () => {
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(checkRoute(), asked), R, null, null).check()
  expect(got.setup).toEqual({ kind: 'no-token' })
  expect(asked).toEqual([])
})

test('check: a token refused at personal_access_tokens/self', async () => {
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(checkRoute({ self: { status: 401, body: { message: '401 Unauthorized' } } }), asked), R, 'glpat-x', null).check()
  expect(got.setup).toEqual({ kind: 'token-refused' })
  expect(asked).toHaveLength(1)
})

test('check: a token with only read_user lacks read_api', async () => {
  const got = await gitlab(
    fakeSend(checkRoute({ self: { status: 200, body: { ...SELF, scopes: ['read_user'] } } })),
    R,
    'glpat-x',
    null,
  ).check()
  expect(got.setup).toEqual({ kind: 'no-scope', missing: 'read_api' })
})

test('check: an older GitLab without personal_access_tokens/self still reaches ready', async () => {
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(checkRoute({ self: { status: 404, body: { error: '404 Not Found' } } }), asked), R, 'glpat-x', null).check()
  expect(got.setup).toEqual(READY)
  expect(asked).toHaveLength(3)
})

test('check: /user refused with 403 means read_api is missing', async () => {
  const got = await gitlab(
    fakeSend(checkRoute({ user: { status: 403, body: { error: 'insufficient_scope', scope: 'read_api' } } })),
    R,
    'glpat-x',
    null,
  ).check()
  expect(got.setup).toEqual({ kind: 'no-scope', missing: 'read_api' })
})

test('check: /user with 401 is a refused token, another status an error', async () => {
  const refused = await gitlab(fakeSend(checkRoute({ user: { status: 401 } })), R, 'glpat-x', null).check()
  expect(refused.setup).toEqual({ kind: 'token-refused' })
  const broken = await gitlab(fakeSend(checkRoute({ user: { status: 502 } })), R, 'glpat-x', null).check()
  expect(broken.setup).toEqual({ kind: 'error', message: '/user: HTTP 502' })
})

test('check: a project that is not there is not-found', async () => {
  const got = await gitlab(fakeSend(checkRoute({ project: { status: 404, body: { message: '404 Project Not Found' } } })), R, 'glpat-x', null).check()
  expect(got.setup).toEqual({ kind: 'not-found' })
})

test('check: the project answering 401, 403 or 500', async () => {
  const at = async (status: number) =>
    (await gitlab(fakeSend(checkRoute({ project: { status } })), R, 'glpat-x', null).check()).setup
  expect(await at(401)).toEqual({ kind: 'token-refused' })
  expect(await at(403)).toMatchObject({ kind: 'no-scope' })
  expect(await at(500)).toEqual({ kind: 'error', message: 'boats/radar: HTTP 500' })
})

test('check: a host that does not answer is an error naming why', async () => {
  const got = await gitlab(fakeSend(() => 'down'), R, 'glpat-x', null).check()
  expect(got.setup).toEqual({ kind: 'error', message: 'connect ECONNREFUSED' })
})

test('check: a nested group owner is URL-encoded in the project path', async () => {
  const asked: Asked[] = []
  const r = { host: 'gitlab.com', owner: 'boats/sonar/team', name: 'radar' }
  const got = await gitlab(fakeSend(checkRoute(), asked), r, 'glpat-x', null).check()
  expect(got.setup).toEqual(READY)
  expect(asked[2]?.url).toBe(`${BASE}/projects/boats%2Fsonar%2Fteam%2Fradar`)
})

test('the tracker names GitLab, its scope, its setting and where to make a token', () => {
  const t = gitlab(fakeSend(checkRoute()), R, 'glpat-x', null) as ReturnType<typeof gitlab> & {
    name: string
    scopes: string
    setting: string
  }
  expect(t.name).toBe('GitLab')
  expect(t.scopes).toBe('read_api')
  expect(t.setting).toBe('GitLab tokens')
  expect(t.tokensUrl).toBe('https://gitlab.com/-/user_settings/personal_access_tokens')
})

// Lists

// Answers a list's pages from `pages`, each with GitLab's headers unless
// `bare`; anything else 404.
function listRoute(path: string, pages: unknown[][], opts: { bare?: boolean; failOn?: number } = {}) {
  const total = pages.reduce((n, p) => n + p.length, 0)
  return (u: URL): Reply => {
    if (u.pathname !== path) return { status: 404, body: { message: '404 Not Found' } }
    const page = Number(u.searchParams.get('page'))
    if (page === opts.failOn) return { status: 500, body: { message: '500 Internal Server Error' } }
    const body = pages[page - 1] ?? []
    const next = page < pages.length ? String(page + 1) : ''
    return { status: 200, body, headers: opts.bare ? { 'content-type': 'application/json' } : pageHeaders(page, next, total) }
  }
}

const ISSUES = '/api/v4/projects/boats%2Fradar/issues'

test('mine: your open issues by iid, with label colours without #', async () => {
  const asked: Asked[] = []
  const mine = issue(12, '2026-09-25T09:00:00.000Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] })
  const t = gitlab(fakeSend(listRoute(ISSUES, [[mine]]), asked), R, 'glpat-x', null)

  expect(await t.mine()).toEqual([
    {
      number: 12,
      title: 'Issue 12',
      milestone: 'v1.2',
      labels: [{ name: 'bug', color: 'd9534f' }],
      created: '2026-09-25T09:00:00.000Z',
      url: 'https://gitlab.com/boats/radar/-/issues/12',
      body: 'Body of 12',
    },
  ])
  const u = new URL(asked[0]?.url ?? '')
  expect(`${u.origin}${u.pathname}`).toBe(`${PROJECT}/issues`)
  expect(u.searchParams.get('state')).toBe('opened')
  expect(u.searchParams.get('scope')).toBe('assigned_to_me')
  expect(u.searchParams.get('with_labels_details')).toBe('true')
  expect(u.searchParams.get('per_page')).toBe('100')
  expect(u.searchParams.get('page')).toBe('1')
  expect(asked[0]?.headers['PRIVATE-TOKEN']).toBe('glpat-x')
})

test('open: every open issue by iid with its assignees, a plain string label without colour', async () => {
  const asked: Asked[] = []
  const plain = { ...issue(14, '2026-09-18T09:00:00.000Z', { description: null }), labels: ['docs'] }
  const taken = issue(15, '2026-09-01T09:00:00.000Z', { assignees: ['jdoe', 'mvos'] })
  const t = gitlab(fakeSend(listRoute(ISSUES, [[plain, taken]]), asked), R, 'glpat-x', null)
  const got = await t.open()

  expect(got.map(i => i.number)).toEqual([14, 15])
  expect(got[0]).toEqual({
    number: 14,
    title: 'Issue 14',
    milestone: null,
    labels: [{ name: 'docs', color: '' }],
    created: '2026-09-18T09:00:00.000Z',
    url: 'https://gitlab.com/boats/radar/-/issues/14',
    body: '',
    assignees: [],
  })
  expect(got[1]?.assignees).toEqual(['jdoe', 'mvos'])
  const u = new URL(asked[0]?.url ?? '')
  expect(u.searchParams.get('state')).toBe('opened')
  expect(u.searchParams.has('scope')).toBe(false)
  expect(u.searchParams.get('with_labels_details')).toBe('true')
})

test('open: follows x-next-page over three pages and stops when it is empty', async () => {
  const asked: Asked[] = []
  const page = (from: number, n: number) => Array.from({ length: n }, (_, k) => issue(from + k, '2026-09-01T00:00:00.000Z'))
  const t = gitlab(fakeSend(listRoute(ISSUES, [page(1, 100), page(101, 100), page(201, 3)]), asked), R, 'glpat-x', null)
  const got = await t.open()

  expect(got).toHaveLength(203)
  expect(got.at(-1)?.number).toBe(203)
  expect(asked.map(a => new URL(a.url).searchParams.get('page'))).toEqual(['1', '2', '3'])
})

test('open: x-next-page set goes on even after a short page', async () => {
  const asked: Asked[] = []
  const t = gitlab(
    fakeSend(listRoute(ISSUES, [[issue(1, '2026-09-01T00:00:00.000Z')], [issue(2, '2026-09-02T00:00:00.000Z')]]), asked),
    R,
    'glpat-x',
    null,
  )
  expect((await t.open()).map(i => i.number)).toEqual([1, 2])
  expect(asked).toHaveLength(2)
})

test('open: with no x-next-page header, stops on a short page', async () => {
  const asked: Asked[] = []
  const full = Array.from({ length: 100 }, (_, k) => issue(k + 1, '2026-09-01T00:00:00.000Z'))
  const t = gitlab(fakeSend(listRoute(ISSUES, [full, [issue(101, '2026-09-01T00:00:00.000Z')]], { bare: true }), asked), R, 'glpat-x', null)
  expect(await t.open()).toHaveLength(101)
  expect(asked.map(a => new URL(a.url).searchParams.get('page'))).toEqual(['1', '2'])
})

test('lists: a failing page throws, naming the list', async () => {
  const full = Array.from({ length: 100 }, (_, k) => issue(k + 1, '2026-09-01T00:00:00.000Z'))
  const t = gitlab(fakeSend(listRoute(ISSUES, [full, full], { failOn: 2 })), R, 'glpat-x', null)
  await expect(t.open()).rejects.toThrow('open issues: HTTP 500')
  const u = gitlab(fakeSend(listRoute(ISSUES, [full], { failOn: 1 })), R, 'glpat-x', null)
  await expect(u.mine()).rejects.toThrow('your issues: HTTP 500')
})

test('milestones: active ones with their due date; none when refused', async () => {
  const asked: Asked[] = []
  const path = '/api/v4/projects/boats%2Fradar/milestones'
  const t = gitlab(fakeSend(listRoute(path, [[V12, milestone('Someday', null, 4410199)]]), asked), R, 'glpat-x', null)

  expect(await t.milestones()).toEqual([
    { title: 'v1.2', due: '2026-10-31', closed: 0, total: 0 },
    { title: 'Someday', due: null, closed: 0, total: 0 },
  ])
  const u = new URL(asked[0]?.url ?? '')
  expect(u.searchParams.get('state')).toBe('active')
  expect(u.searchParams.get('include_ancestors')).toBe('true')

  const refused = gitlab(fakeSend(listRoute(path, [[V12]], { failOn: 1 })), R, 'glpat-x', null)
  expect(await refused.milestones()).toEqual([])
})

test('no epics, blockers or children on GitLab yet, and nothing asked for them', async () => {
  const asked: Asked[] = []
  const t = gitlab(fakeSend(checkRoute(), asked), R, 'glpat-x', null)
  expect(await t.epics()).toEqual([])
  expect(await t.blockers(12)).toBe(null)
  expect(await t.children(12, 'alice')).toBe(null)
  expect(asked).toEqual([])
})

// One issue

test('issue: one request by iid, mapped for the detail view', async () => {
  const asked: Asked[] = []
  const raw = {
    ...issue(12, '2026-09-25T09:00:00.000Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] }),
    due_date: '2026-10-20',
    user_notes_count: 4,
  }
  const t = gitlab(
    fakeSend(u => (u.pathname === `${ISSUES}/12` ? { status: 200, body: raw } : { status: 404, body: { message: '404 Not found' } }), asked),
    R,
    'glpat-x',
    null,
  )
  const got = await t.issue(12, { time: false, deps: false, epics: false })

  expect(got).toEqual({
    number: 12,
    title: 'Issue 12',
    state: 'open',
    url: 'https://gitlab.com/boats/radar/-/issues/12',
    body: 'Body of 12',
    author: 'jdoe',
    created: '2026-09-25T09:00:00.000Z',
    updated: '2026-10-08T09:30:00.000Z',
    comments: 4,
    milestone: { title: 'v1.2', due: '2026-10-31' },
    due: '2026-10-20',
    branch: null,
    logged: null,
    labels: [{ name: 'bug', color: 'd9534f' }],
    assignees: ['alice'],
    blockedBy: null,
    blocks: null,
    pulls: null,
    commits: null,
    lastComment: null,
  })
  expect(asked.map(a => a.url)).toEqual([`${PROJECT}/issues/12`])
})

test('issue: a closed one stays closed, and a missing one throws', async () => {
  const closed = { ...issue(9, '2026-08-01T00:00:00.000Z'), state: 'closed', author: null, user_notes_count: undefined }
  const t = gitlab(
    fakeSend(u => (u.pathname === `${ISSUES}/9` ? { status: 200, body: closed } : { status: 404, body: { message: '404 Not found' } })),
    R,
    'glpat-x',
    null,
  )
  const got = await t.issue(9, { time: false, deps: false, epics: false })
  expect(got.state).toBe('closed')
  expect(got.author).toBe('someone')
  expect(got.comments).toBe(0)
  expect(got.milestone).toBe(null)
  await expect(t.issue(404, { time: false, deps: false, epics: false })).rejects.toThrow('#404: HTTP 404')
})

test('assign and close send nothing and say why', async () => {
  const asked: Asked[] = []
  const t = gitlab(fakeSend(checkRoute(), asked), R, 'glpat-x', null)
  expect(await t.assign(12, ['alice'])).toBe('fj cannot change GitLab issues yet.')
  expect(await t.close(12, true)).toBe('fj cannot change GitLab issues yet.')
  expect(asked).toEqual([])
})

// The pane, on gitlab.com

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj',
  props: {
    title: 'fj',
    isFocused: false,
    bodyColumns: 50,
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

const GL = { options: { gitlabTokens: 'gitlab.com=glpat-x', icons: 'text', compact: 'off' } }

type World = {
  // What personal_access_tokens/self answers.
  self?: number
  // Your issues and all open issues, one page each.
  mine?: unknown[]
  open?: unknown[]
  // The status your issues answer with; 200 when left out.
  mineStatus?: number
  milestones?: unknown[]
  asked?: { url: string; token: string | undefined; auth: string | undefined }[]
}

function world(on: On, w: World) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout =
      cmd === 'git remote get-url origin' ? 'git@gitlab.com:boats/radar.git' : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.asked?.push({ url: e.url, token: headers['PRIVATE-TOKEN'], auth: headers.Authorization })
    const u = new URL(e.url)
    const page = Number(u.searchParams.get('page') || '1')
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
      value: { status, ok: status === 200, headers: { 'content-type': 'application/json', ...extra }, text: JSON.stringify(body) },
    })
    const list = (items: unknown[]) => reply(200, page === 1 ? items : [], pageHeaders(page, '', items.length))
    const p = u.pathname
    if (p === '/api/v4/personal_access_tokens/self') {
      const status = w.self ?? 200
      return reply(status, status === 200 ? SELF : { message: '401 Unauthorized' })
    }
    if (p === '/api/v4/user') return reply(200, USER)
    if (p === '/api/v4/projects/boats%2Fradar') return reply(200, PROJ)
    if (p === '/api/v4/projects/boats%2Fradar/milestones') return w.milestones ? list(w.milestones) : reply(403, { message: '403 Forbidden' })
    if (p === '/api/v4/projects/boats%2Fradar/issues') {
      if (u.searchParams.get('scope') === 'assigned_to_me') {
        const status = w.mineStatus ?? 200
        return status === 200 ? list(w.mine ?? []) : reply(status, { message: '500 Internal Server Error' })
      }
      return list(w.open ?? [])
    }
    return reply(404, { message: '404 Not Found' })
  })
  return clock
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const rule = (name: string) => `── ${name} `.padEnd(50, '─')

// #12 is yours; #14 is the oldest free one, so Next; #15 is someone else's;
// #21 waits in the queue, in v1.3.
const MINE = issue(12, '2026-09-25T09:00:00.000Z', { milestone: V12, labels: ['bug'], assignees: ['alice'] })
const OPEN = [
  MINE,
  issue(14, '2026-09-18T09:00:00.000Z', { milestone: V12 }),
  issue(15, '2026-09-01T09:00:00.000Z', { assignees: ['jdoe'] }),
  issue(21, '2026-10-02T09:00:00.000Z', { milestone: V13 }),
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`gitlab.com: setup passes, read only for now, on ${surface}`, GL, async ($, on) => {
    const asked: World['asked'] = []
    // Your issues failing keeps the steps on screen.
    world(on, { mineStatus: 500, open: OPEN, asked })

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(all[0]).toBe('Could not load the issues: your issues: HTTP 500.')
    expect(all).toEqual(
      expect.arrayContaining([
        '✓ Repo    boats/radar',
        '✓ Forge   GitLab at gitlab.com',
        '✓ Token   for gitlab.com from GitLab tokens',
        '✓ Access  7 open issues, as alice',
        '· Actions read only on GitLab for now',
      ]),
    )
    expect(all).not.toContain('What to do')
    // gitlab.com is known by name: the first request is the token's.
    expect(asked?.slice(0, 3).map(a => a.url)).toEqual([`${BASE}/personal_access_tokens/self`, `${BASE}/user`, PROJECT])
    expect(asked?.every(a => a.token === 'glpat-x' && a.auth === undefined)).toBe(true)
    expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar, but could not load its issues.' }))
  })
}

test("gitlab.com: What's next shows your issue and the free ones by iid", GL, async ($, on) => {
  const clock = world(on, { mine: [MINE], open: OPEN })
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
  // Someone else's is left out; the global ids are never shown.
  expect(all.some(t => t.includes('#15'))).toBe(false)
  expect(all.some(t => /#16\d{7}/.test(t))).toBe(false)
  // The label keeps its colour, given without '#'.
  const bug = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'bug')
  expect(bug?.props.color).toBe('#d9534f')
  expect(all.slice(-4)).toEqual(['gitlab.com/', 'boats/radar', '3 open · ', '1 yours'])
  expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar: 1 in progress, next is #14.' }))
})

type Btn = { key: string; props: Record<string, unknown> }
const pickerLabel = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
  ((await ui.find({ key: 'milestone' })) as Btn | undefined)?.props.label

test('gitlab.com: the milestone picker starts on the one due first and narrows to another', GL, async ($, on) => {
  const clock = world(on, { mine: [MINE], open: OPEN, milestones: [V13, V12] })
  await clock.set(NOW)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await texts(ui)
  expect(await pickerLabel(ui)).toBe('v1.2 ▾')
  expect(all).toContain(rule('In progress in v1.2 (1)'))
  expect(all).toContain('▸ #14 Issue 14')
  expect(all.some(t => t.includes('#21'))).toBe(false)

  await ui.press({ key: 'milestone' })
  await ui.press({ key: 'milestone-m:v1.3' })
  all = await texts(ui)
  expect(await pickerLabel(ui)).toBe('v1.3 ▾')
  expect(all).toContain(rule('In progress in v1.3 (0)'))
  expect(all).toContain('▸ #21 Issue 21')
  expect(all.some(t => t.includes('#12') || t.includes('#14'))).toBe(false)
})

test('gitlab.com without a token: how to make one for GitLab, and nothing asked', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   GitLab at gitlab.com')
  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('1. Create a token at https://gitlab.com/-/user_settings/personal_access_tokens with read_api.')
  expect(all).toContain('https://gitlab.com/-/user_settings/personal_access_tokens')
  expect(all).toContain(
    '2. Run /plugin configure fj@egribnau-mods and paste it as GitLab tokens, alone or as gitlab.com=<token> next to tokens for other hosts.',
  )
  expect(all.some(t => t.includes('Forgejo tokens') || t.includes('read:issue'))).toBe(false)
  expect(asked).toEqual([])
})

test('gitlab.com refusing the token: says GitLab did not accept it', GL, async ($, on) => {
  world(on, { self: 401 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Token   for gitlab.com from GitLab tokens')
  expect(all).toContain('✗ Access  token refused')
  expect(all).toContain(
    'GitLab did not accept the token for gitlab.com from GitLab tokens: it may be mistyped, expired or revoked.',
  )
  expect(all).toContain('1. Create a token at https://gitlab.com/-/user_settings/personal_access_tokens with read_api.')
})
