import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitlab } from '../hooks/gitlab'
import type { Send } from '../hooks/tracker'
import type { Repo } from '../types'

// GitLab's issue detail, assign, close and time tracking (#9): answers
// shaped as GitLab's API v4 gives them, first against a fake Send, then
// through the pane.

const NOW = Date.parse('2026-10-09T12:00:00Z')
const FEATURES = { time: true, deps: false, epics: false }

// Each unit test has a host of its own: gitlab.ts remembers user ids per
// host for as long as the module lives, so a host shared with another test
// could answer a lookup from that test's answers.
const at = (host: string) => {
  const r: Repo = { host, owner: 'boats', name: 'radar' }
  const base = `https://${host}/api/v4`
  return { r, base, project: `${base}/projects/boats%2Fradar`, path: '/api/v4/projects/boats%2Fradar' }
}

// Fixtures, as GitLab answers them.

const SELF = {
  id: 4711,
  name: 'fj',
  revoked: false,
  created_at: '2026-09-01T08:12:44.512Z',
  description: '',
  scopes: ['api'],
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

const access = (level: number) => ({ access_level: level, notification_level: 3 })

// The project, with your role in it: `project` your own membership's level,
// `group` the one through its group; null for none.
const proj = (project: number | null = 30, group: number | null = null) => ({
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
  permissions: {
    project_access: project === null ? null : access(project),
    group_access: group === null ? null : access(group),
  },
})

const person = (username: string, id: number) => ({
  id,
  username,
  name: username,
  state: 'active',
  locked: false,
  avatar_url: `https://secure.gravatar.com/avatar/${username}?s=80&d=identicon`,
  web_url: `https://gitlab.com/${username}`,
})

const V12 = {
  id: 4410102,
  iid: 2,
  project_id: 52117834,
  title: 'v1.2',
  description: '',
  state: 'active',
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
  due_date: '2026-10-31',
  start_date: null,
  expired: false,
  web_url: 'https://gitlab.com/boats/radar/-/milestones/2',
}

type Extra = {
  assignees?: { username: string; id: number }[]
  spent?: number
  estimate?: number
  state?: string
}

// An issue: `id` is global and never what fj shows; `iid` is the number in
// the project. Time in seconds, as time_stats has it.
function issue(iid: number, extra: Extra = {}) {
  const assignees = (extra.assignees ?? []).map(a => person(a.username, a.id))
  const spent = extra.spent ?? 0
  const estimate = extra.estimate ?? 0
  return {
    id: 160000000 + iid * 37,
    iid,
    project_id: 52117834,
    title: `Issue ${iid}`,
    description: `Body of ${iid}`,
    state: extra.state ?? 'opened',
    created_at: '2026-09-18T09:00:00.000Z',
    updated_at: '2026-10-07T12:00:00.000Z',
    closed_at: null,
    closed_by: null,
    labels: [],
    milestone: V12,
    assignees,
    author: person('jdoe', 777),
    type: 'ISSUE',
    assignee: assignees[0] ?? null,
    user_notes_count: 3,
    merge_requests_count: 1,
    upvotes: 0,
    downvotes: 0,
    due_date: null,
    confidential: false,
    discussion_locked: null,
    issue_type: 'issue',
    web_url: `https://gitlab.com/boats/radar/-/issues/${iid}`,
    time_stats: {
      time_estimate: estimate,
      total_time_spent: spent,
      human_time_estimate: estimate ? `${estimate / 3600}h` : null,
      human_total_time_spent: spent ? `${spent / 60}m` : null,
    },
    task_completion_status: { count: 0, completed_count: 0 },
    has_tasks: false,
    references: { short: `#${iid}`, relative: `#${iid}`, full: `boats/radar#${iid}` },
    severity: 'UNKNOWN',
  }
}

const note = (id: number, who: ReturnType<typeof person>, created: string, body: string, system: boolean) => ({
  id,
  type: null,
  body,
  author: who,
  created_at: created,
  updated_at: created,
  system,
  noteable_id: 160000518,
  noteable_type: 'Issue',
  project_id: 52117834,
  resolvable: false,
  confidential: false,
  internal: false,
  noteable_iid: 14,
  commands_changes: {},
})

// Newest first, as sort=desc asks: system notes around the comments.
const NOTES = [
  note(9003, person('jdoe', 777), '2026-10-08T12:00:00.000Z', 'added 1h 30m of time spent', true),
  note(9002, person('mvos', 778), '2026-10-07T12:00:00.000Z', 'Also mention the desktop app.', false),
  note(9001, person('jdoe', 777), '2026-10-06T12:00:00.000Z', 'changed the description', true),
  note(9000, person('jdoe', 777), '2026-10-01T12:00:00.000Z', 'First.', false),
]

const mr = (iid: number, title: string, state: string) => ({
  id: 310000000 + iid,
  iid,
  project_id: 52117834,
  title,
  description: '',
  state,
  created_at: '2026-10-05T12:00:00.000Z',
  updated_at: '2026-10-05T12:00:00.000Z',
  merged_at: state === 'merged' ? '2026-10-06T12:00:00.000Z' : null,
  closed_at: null,
  target_branch: 'main',
  source_branch: `14-${title.toLowerCase().replace(/\W+/g, '-')}`,
  author: person('mvos', 778),
  assignees: [],
  draft: false,
  merge_status: 'can_be_merged',
  web_url: `https://gitlab.com/boats/radar/-/merge_requests/${iid}`,
})

const MRS = [mr(61, 'Document the token setting', 'merged'), mr(63, 'List the scopes', 'opened'), mr(64, 'Dropped idea', 'closed')]

// The fake Send.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'down'
type Asked = { url: string; method: string; headers: Record<string, string>; body: unknown }

// A Send answering through `route`, recording each request with its JSON
// body, if any.
function fakeSend(route: (url: URL, method: string) => Reply, asked: Asked[] = []): Send {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined
    asked.push({ url, method, headers: init?.headers ?? {}, body })
    const r = route(new URL(url), method)
    if (r === 'down') throw new Error('connect ECONNREFUSED')
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: r.headers ?? { 'content-type': 'application/json' },
      text: JSON.stringify(r.body ?? {}),
    }
  }) as unknown as Send
}

const NOT_FOUND: Reply = { status: 404, body: { message: '404 Not Found' } }

type World = {
  self?: Reply
  project?: Reply
  issue?: Reply
  notes?: Reply
  mrs?: Reply
  // Who /users?username= finds, by username.
  users?: Record<string, number>
  // What a PUT to the issue answers; 200 with the issue when left out.
  put?: Reply
}

// The answers check and the detail ask for, path by path; 404 for anything else.
function route(w: World = {}) {
  return (u: URL, method: string): Reply => {
    const p = u.pathname
    const issuePath = /^\/api\/v4\/projects\/boats%2Fradar\/issues\/(\d+)(\/.*)?$/.exec(p)
    if (method === 'PUT') return issuePath && !issuePath[2] ? (w.put ?? { status: 200, body: issue(Number(issuePath[1])) }) : NOT_FOUND
    if (p === '/api/v4/personal_access_tokens/self') return w.self ?? { status: 200, body: SELF }
    if (p === '/api/v4/user') return { status: 200, body: USER }
    if (p === '/api/v4/users') {
      const name = u.searchParams.get('username') ?? ''
      const id = w.users?.[name]
      return { status: 200, body: id === undefined ? [] : [person(name, id)] }
    }
    if (p === '/api/v4/projects/boats%2Fradar') return w.project ?? { status: 200, body: proj() }
    if (issuePath) {
      const n = Number(issuePath[1])
      if (issuePath[2] === undefined) return w.issue ?? { status: 200, body: issue(n, { spent: 5400, estimate: 14400 }) }
      if (issuePath[2] === '/notes') return w.notes ?? { status: 200, body: NOTES }
      if (issuePath[2] === '/related_merge_requests') return w.mrs ?? { status: 200, body: MRS }
    }
    return NOT_FOUND
  }
}

const contentType = (h: Record<string, string>) =>
  Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1]

// issue(n)

test('issue: exactly three requests, for the issue, its notes and its merge requests', async () => {
  const { r, project } = at('detail-three.example')
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route(), asked), r, 'glpat-x', null).issue(14, FEATURES)

  expect(asked).toHaveLength(3)
  expect(asked.every(a => a.method === 'GET' && a.headers['PRIVATE-TOKEN'] === 'glpat-x')).toBe(true)
  const paths = asked.map(a => {
    const u = new URL(a.url)
    return `${u.origin}${u.pathname}`
  })
  expect(paths.sort()).toEqual(
    [`${project}/issues/14`, `${project}/issues/14/notes`, `${project}/issues/14/related_merge_requests`].sort(),
  )
  const notes = new URL(asked.find(a => a.url.includes('/notes'))?.url ?? '')
  expect(notes.searchParams.get('sort')).toBe('desc')
  expect(notes.searchParams.get('order_by')).toBe('created_at')
  expect(notes.searchParams.get('per_page')).toBe('20')

  expect(got).toMatchObject({
    number: 14,
    title: 'Issue 14',
    state: 'open',
    author: 'jdoe',
    logged: 5400,
    estimate: 14400,
    branch: null,
    blockedBy: null,
    blocks: null,
    commits: null,
    lastComment: { author: 'mvos', when: '2026-10-07T12:00:00.000Z', body: 'Also mention the desktop app.' },
    pulls: [
      { number: 61, title: 'Document the token setting', state: 'merged' },
      { number: 63, title: 'List the scopes', state: 'open' },
      { number: 64, title: 'Dropped idea', state: 'closed' },
    ],
  })
})

test('issue: no time spent logs nothing, and a 0 estimate is null', async () => {
  const { r } = at('detail-notime.example')
  const t = gitlab(fakeSend(route({ issue: { status: 200, body: issue(14) } })), r, 'glpat-x', null)
  const got = await t.issue(14, FEATURES)
  expect(got.logged ?? 0).toBe(0)
  expect((got as { estimate?: unknown }).estimate).toBe(null)
})

test('issue: an estimate with nothing logged keeps the estimate', async () => {
  const { r } = at('detail-estimate.example')
  const t = gitlab(fakeSend(route({ issue: { status: 200, body: issue(14, { estimate: 7200 }) } })), r, 'glpat-x', null)
  const got = await t.issue(14, FEATURES)
  expect(got.logged ?? 0).toBe(0)
  expect((got as { estimate?: unknown }).estimate).toBe(7200)
})

test('issue: only system notes leave no last comment', async () => {
  const { r } = at('detail-system.example')
  const system = NOTES.filter(n => n.system)
  const got = await gitlab(fakeSend(route({ notes: { status: 200, body: system } })), r, 'glpat-x', null).issue(14, FEATURES)
  expect(got.lastComment).toBe(null)
})

test('issue: notes failing leave the last comment out, and the issue loads', async () => {
  const { r } = at('detail-nonotes.example')
  const got = await gitlab(fakeSend(route({ notes: { status: 500, body: { message: '500 Internal Server Error' } } })), r, 'glpat-x', null).issue(
    14,
    FEATURES,
  )
  expect(got.title).toBe('Issue 14')
  expect(got.lastComment).toBe(null)
  expect(got.pulls).toHaveLength(3)
})

test('issue: merge requests failing or down leave them out, and the issue loads', async () => {
  const { r } = at('detail-nomrs.example')
  for (const mrs of [{ status: 403, body: { message: '403 Forbidden' } }, 'down'] as const) {
    const got = await gitlab(fakeSend(route({ mrs })), r, 'glpat-x', null).issue(14, FEATURES)
    expect(got.title).toBe('Issue 14')
    expect(got.pulls).toBe(null)
    expect(got.lastComment?.author).toBe('mvos')
  }
})

test('issue: the issue itself failing throws', async () => {
  const { r } = at('detail-fails.example')
  const t = gitlab(fakeSend(route({ issue: { status: 500, body: { message: '500 Internal Server Error' } } })), r, 'glpat-x', null)
  await expect(t.issue(14, FEATURES)).rejects.toThrow('#14: HTTP 500')
})

// assign(n, logins)

test('assign: nobody is assignee_id 0, sent as JSON with the token', async () => {
  const { r, project } = at('assign-none.example')
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route(), asked), r, 'glpat-x', null).assign(14, [])

  expect(got).toBe(null)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ url: `${project}/issues/14`, method: 'PUT', body: { assignee_id: 0 } })
  expect(asked[0]?.headers['PRIVATE-TOKEN']).toBe('glpat-x')
  expect(contentType(asked[0]?.headers ?? {})).toBe('application/json')
})

test('assign: you, by the id /user gave check, with no lookup', async () => {
  const { r, project } = at('assign-me.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route(), asked), r, 'glpat-x', null)
  await t.check()
  const before = asked.length
  expect(await t.assign(14, ['alice'])).toBe(null)

  expect(asked.slice(before)).toHaveLength(1)
  expect(asked.at(-1)).toMatchObject({ url: `${project}/issues/14`, method: 'PUT', body: { assignee_id: 991 } })
})

test('assign: someone not seen yet is looked up once, by exact username', async () => {
  const { r, base } = at('assign-lookup.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ users: { mvos: 778 } }), asked), r, 'glpat-x', null)

  expect(await t.assign(14, ['mvos'])).toBe(null)
  expect(await t.assign(15, ['mvos'])).toBe(null)

  const lookups = asked.filter(a => new URL(a.url).pathname === '/api/v4/users')
  expect(lookups).toHaveLength(1)
  expect(lookups[0]?.method).toBe('GET')
  expect(new URL(lookups[0]?.url ?? '').searchParams.get('username')).toBe('mvos')
  expect(lookups[0]?.url.startsWith(`${base}/users?`)).toBe(true)
  expect(asked.filter(a => a.method === 'PUT').map(a => a.body)).toEqual([{ assignee_id: 778 }, { assignee_id: 778 }])
})

test('assign: someone GitLab does not know is the reason, and nothing is sent', async () => {
  const { r } = at('assign-ghost.example')
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route(), asked), r, 'glpat-x', null).assign(14, ['ghost'])

  expect(got).toBe('no GitLab user ghost')
  expect(asked.some(a => a.method === 'PUT')).toBe(false)
})

test('assign: two people go as assignee_ids', async () => {
  const { r } = at('assign-two.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ users: { jdoe: 777 } }), asked), r, 'glpat-x', null)
  await t.check()
  expect(await t.assign(14, ['alice', 'jdoe'])).toBe(null)

  expect(asked.filter(a => a.method === 'PUT').map(a => a.body)).toEqual([{ assignee_ids: [991, 777] }])
})

test('assign: ids come from an issue answer too, with no lookup', async () => {
  const { r } = at('assign-seen.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route(), asked), r, 'glpat-x', null)
  // The issue's author, jdoe, is 777.
  await t.issue(14, FEATURES)
  expect(await t.assign(14, ['jdoe'])).toBe(null)

  expect(asked.some(a => new URL(a.url).pathname === '/api/v4/users')).toBe(false)
  expect(asked.at(-1)?.body).toEqual({ assignee_id: 777 })
})

// close(n, closed)

test('close and reopen are a state_event', async () => {
  const { r, project } = at('close.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route(), asked), r, 'glpat-x', null)

  expect(await t.close(14, true)).toBe(null)
  expect(await t.close(14, false)).toBe(null)
  expect(asked.map(a => [a.method, a.url, a.body])).toEqual([
    ['PUT', `${project}/issues/14`, { state_event: 'close' }],
    ['PUT', `${project}/issues/14`, { state_event: 'reopen' }],
  ])
  expect(contentType(asked[0]?.headers ?? {})).toBe('application/json')
})

// Why a write was refused

test('a refusal is GitLab message, an object message joined, else error or the status', async () => {
  const { r } = at('refused.example')
  const said = async (put: Reply) => gitlab(fakeSend(route({ put })), r, 'glpat-x', null).close(14, true)

  expect(await said({ status: 403, body: { message: '403 Forbidden' } })).toBe('403 Forbidden')
  const joined = await said({ status: 400, body: { message: { state_event: ['is invalid'], base: ['is locked'] } } })
  expect(joined).toContain('is invalid')
  expect(joined).toContain('is locked')
  expect(await said({ status: 401, body: { error: 'invalid_token' } })).toBe('invalid_token')
  expect(await said({ status: 502, body: {} })).toBe('HTTP 502')
  expect(await said('down')).toBe('connect ECONNREFUSED')
})

// check() decides the actions

const actionsOf = async (host: string, w: World) => {
  const { r } = at(host)
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route(w), asked), r, 'glpat-x', null).check()
  return { setup: got.setup as { kind: string; actions?: unknown; features?: unknown }, asked }
}

test('check: api and Developer may act, in four requests, GitLab tracks time and has epics, no metadata no blockers', async () => {
  const { setup, asked } = await actionsOf('check-ok.example', {})
  expect(setup).toMatchObject({ kind: 'ready', login: 'alice', actions: { kind: 'ok' } })
  expect(setup.features).toEqual({ time: true, deps: false, epics: true })
  expect(asked).toHaveLength(4)
})

test('check: read_api alone is read only for the scope', async () => {
  const { setup } = await actionsOf('check-readapi.example', { self: { status: 200, body: { ...SELF, scopes: ['read_api', 'read_user'] } } })
  expect(setup).toMatchObject({ kind: 'ready', actions: { kind: 'read-only', reason: 'scope' } })
})

test('check: api as a Guest is read only for the role', async () => {
  const { setup } = await actionsOf('check-guest.example', { project: { status: 200, body: proj(10) } })
  expect(setup).toMatchObject({ kind: 'ready', actions: { kind: 'read-only', reason: 'role' } })
})

test('check: no role at all is read only for the role', async () => {
  const { setup } = await actionsOf('check-norole.example', { project: { status: 200, body: proj(null, null) } })
  expect(setup).toMatchObject({ kind: 'ready', actions: { kind: 'read-only', reason: 'role' } })
})

test('check: Reporter through the group counts over Guest in the project', async () => {
  const { setup } = await actionsOf('check-group.example', { project: { status: 200, body: proj(10, 20) } })
  expect(setup).toMatchObject({ kind: 'ready', actions: { kind: 'ok' } })
})

test('check: read_api alone says scope even as a Guest', async () => {
  const { setup } = await actionsOf('check-both.example', {
    self: { status: 200, body: { ...SELF, scopes: ['read_api'] } },
    project: { status: 200, body: proj(10) },
  })
  expect(setup).toMatchObject({ actions: { kind: 'read-only', reason: 'scope' } })
})

test('check: an older GitLab without the scopes, as a Developer, is unknown', async () => {
  const { setup, asked } = await actionsOf('check-old.example', { self: { status: 404, body: { error: '404 Not Found' } } })
  expect(setup).toMatchObject({ kind: 'ready', actions: { kind: 'unknown' } })
  expect(asked).toHaveLength(4)
})

test('check: an older GitLab as a Guest is still read only for the role', async () => {
  const { setup } = await actionsOf('check-oldguest.example', {
    self: { status: 404, body: { error: '404 Not Found' } },
    project: { status: 200, body: proj(10) },
  })
  expect(setup).toMatchObject({ actions: { kind: 'read-only', reason: 'role' } })
})

test('the tracker writes with api', () => {
  const { r } = at('scope-name.example')
  const t = gitlab(fakeSend(route()), r, 'glpat-x', null) as ReturnType<typeof gitlab> & { writeScope?: string }
  expect(t.writeScope).toBe('api')
})

// The pane, on gitlab.com

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

const GL = { options: { gitlabTokens: 'gitlab.com=glpat-x', icons: 'text', compact: 'off' } }

const pageHeaders = (n: number) => ({
  'content-type': 'application/json',
  'x-page': '1',
  'x-next-page': '',
  'x-prev-page': '',
  'x-per-page': '100',
  'x-total': String(n),
  'x-total-pages': '1',
})

type Pane = {
  scopes?: readonly string[]
  // Your level in the project.
  level?: number
  // #14 as GitLab holds it before any write.
  issue?: ReturnType<typeof issue>
  // Your issues answering 500, so setup's steps stay on screen.
  mineFails?: boolean
  // The writes fj sends, and what GitLab answers them.
  sent?: { path: string; body: Record<string, unknown> }[]
  refuse?: { status: number; body: unknown }
  asked?: string[]
}

function paneWorld(on: On, w: Pane) {
  const clock = mock.clock(on)
  let now = w.issue ?? issue(14, { spent: 5400, estimate: 14400 })
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout =
      cmd === 'git remote get-url origin' ? 'git@gitlab.com:boats/radar.git' : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    w.asked?.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    const u = new URL(e.url)
    const page = Number(u.searchParams.get('page') || '1')
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
      value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json', ...extra }, text: JSON.stringify(body) },
    })
    const list = (items: unknown[]) => reply(200, page === 1 ? items : [], pageHeaders(items.length))
    const p = u.pathname
    if (e.init?.method === 'PUT') {
      const body = JSON.parse(String(e.init.body ?? '{}')) as Record<string, unknown>
      w.sent?.push({ path: p, body })
      if (w.refuse) return reply(w.refuse.status, w.refuse.body)
      if ('assignee_id' in body) {
        const id = body.assignee_id
        now = { ...now, assignees: id === 991 ? [person('alice', 991)] : [], assignee: id === 991 ? person('alice', 991) : null }
      }
      if (body.state_event === 'close') now = { ...now, state: 'closed' }
      if (body.state_event === 'reopen') now = { ...now, state: 'opened' }
      return reply(200, now)
    }
    if (p === '/api/v4/personal_access_tokens/self') return reply(200, { ...SELF, scopes: w.scopes ?? ['api'] })
    if (p === '/api/v4/user') return reply(200, USER)
    if (p === '/api/v4/projects/boats%2Fradar') return reply(200, proj(w.level ?? 30))
    if (p === '/api/v4/projects/boats%2Fradar/milestones') return reply(403, { message: '403 Forbidden' })
    if (p === '/api/v4/projects/boats%2Fradar/issues') {
      const open = now.state === 'opened' ? [now] : []
      if (u.searchParams.get('scope') === 'assigned_to_me') {
        if (w.mineFails) return reply(500, { message: '500 Internal Server Error' })
        return list(open.filter(i => i.assignees.some(a => a.username === 'alice')))
      }
      return list(open)
    }
    if (p === '/api/v4/projects/boats%2Fradar/issues/14') return reply(200, now)
    if (p === '/api/v4/projects/boats%2Fradar/issues/14/notes') return reply(200, NOTES)
    if (p === '/api/v4/projects/boats%2Fradar/issues/14/related_merge_requests') return reply(200, MRS)
    return reply(404, { message: '404 Not Found' })
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

// /fj, then #14 picked from What's next.
async function opened($: Engine) {
  await $.command.run(RUN)
  const ui = (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
  await ui.press({ key: 'pick-14' })
  return ui
}

test('gitlab.com detail: time logged of estimated, the last comment and the merge requests', GL, async ($, on) => {
  const clock = paneWorld(on, {})
  await clock.set(NOW)
  const ui = await opened($)
  const all = await texts(ui)

  expect(all.some(t => t.includes('Issue 14'))).toBe(true)
  expect(all).toContain('1h 30m logged of 4h 0m estimated')
  expect(all.some(t => t.startsWith('── Last comment ── mvos · 2d ago'))).toBe(true)
  expect(all).toContain('Also mention the desktop app.')
  // A system note is never the last comment.
  expect(all.some(t => t.includes('added 1h 30m of time spent'))).toBe(false)
  expect(all.some(t => t.startsWith('Pull requests'))).toBe(true)
  for (const want of ['#61 ', 'Document the token setting', ' merged', '#63 ', 'List the scopes', ' open', '#64 ', 'Dropped idea']) {
    expect(all.some(t => t === want || t.includes(want))).toBe(true)
  }
  // The merge requests' global ids are never shown.
  expect(all.some(t => /31000006\d/.test(t))).toBe(false)
})

test('gitlab.com detail: an estimate alone, nothing logged', GL, async ($, on) => {
  paneWorld(on, { issue: issue(14, { estimate: 2700 }) })
  const ui = await opened($)
  const all = await texts(ui)
  expect(all).toContain('45m estimated')
  expect(all.some(t => t.includes('logged'))).toBe(false)
})

test('gitlab.com detail: neither logged nor estimated, no Time line', GL, async ($, on) => {
  paneWorld(on, { issue: issue(14) })
  const ui = await opened($)
  const all = await texts(ui)
  expect(all.some(t => t.trimEnd() === 'Time')).toBe(false)
  expect(all.some(t => t.includes('estimated') || t.includes('logged'))).toBe(false)
})

test('gitlab.com detail: one detail load is three requests', GL, async ($, on) => {
  const asked: string[] = []
  paneWorld(on, { asked })
  await $.command.run(RUN)
  const ui = (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
  const before = asked.length
  await ui.press({ key: 'pick-14' })
  const issueAsks = asked.slice(before).filter(a => a.includes('/issues/14'))
  expect(issueAsks).toHaveLength(3)
})

test('gitlab.com detail: with api and Developer, Assign me and Close show', GL, async ($, on) => {
  paneWorld(on, {})
  const ui = await opened($)
  const k = await keys(ui)
  expect(k).toContain('assign')
  expect(k).toContain('close')
  expect(await labelOf(ui, 'assign')).toBe('Assign me')
  expect(await labelOf(ui, 'close')).toBe('Close')
})

test('gitlab.com detail: Assign me sends your id, and the reload shows you assigned', GL, async ($, on) => {
  const sent: Pane['sent'] = []
  const asked: string[] = []
  paneWorld(on, { sent, asked })
  const ui = await opened($)
  const reads = asked.filter(a => a === 'GET https://gitlab.com/api/v4/projects/boats%2Fradar/issues/14').length
  await ui.press({ key: 'assign' })

  expect(sent).toEqual([{ path: '/api/v4/projects/boats%2Fradar/issues/14', body: { assignee_id: 991 } }])
  // Your id came from /user: no lookup.
  expect(asked.some(a => a.includes('/api/v4/users?'))).toBe(false)
  expect(asked.filter(a => a === 'GET https://gitlab.com/api/v4/projects/boats%2Fradar/issues/14').length).toBeGreaterThan(reads)
  expect(await labelOf(ui, 'assign')).toBe('Unassign me')

  await ui.press({ key: 'assign' })
  expect(sent.at(-1)?.body).toEqual({ assignee_id: 0 })
  expect(await labelOf(ui, 'assign')).toBe('Assign me')
})

test('gitlab.com detail: Close sends state_event close, and the reloaded lists leave #14 out', GL, async ($, on) => {
  const sent: Pane['sent'] = []
  const asked: string[] = []
  paneWorld(on, { sent, asked })
  const ui = await opened($)
  const reads = asked.filter(a => a === 'GET https://gitlab.com/api/v4/projects/boats%2Fradar/issues/14').length
  await ui.press({ key: 'close' })

  expect(sent).toEqual([{ path: '/api/v4/projects/boats%2Fradar/issues/14', body: { state_event: 'close' } }])
  // The issue is read again, then the lists: closed, it leaves them, and
  // the pane goes back to What's next.
  expect(asked.filter(a => a === 'GET https://gitlab.com/api/v4/projects/boats%2Fradar/issues/14').length).toBeGreaterThan(reads)
  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  expect(all.some(t => t.includes('#14'))).toBe(false)
})

test('gitlab.com detail: a refused close says GitLab message, in red', GL, async ($, on) => {
  paneWorld(on, { sent: [], refuse: { status: 403, body: { message: '403 Forbidden' } } })
  const ui = await opened($)
  await ui.press({ key: 'close' })

  const found = (await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]
  const line = found.find(t => t.text === 'Could not close #14: 403 Forbidden.')
  expect(line?.props.color).toBe('error')
  expect(await labelOf(ui, 'close')).toBe('Close')
})

for (const [why, w, step, notice] of [
  [
    'the token has read_api only',
    { scopes: ['read_api', 'read_user'] },
    '· Actions read only, token lacks api',
    "Assign and close need a token with api: the setup guide's steps make one.",
  ],
  [
    'alice is a Guest',
    { level: 10 },
    '· Actions read only, alice is below Reporter here',
    'Assign and close need Reporter or higher on boats/radar.',
  ],
] as const) {
  test(`gitlab.com read only (${why}): the Actions step says why`, GL, async ($, on) => {
    paneWorld(on, { ...w, mineFails: true })
    await $.command.run(RUN)
    const ui = (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
    const all = await texts(ui)
    expect(all).toContain(step)
    expect(all.some(t => t.includes('for now'))).toBe(false)
  })

  test(`gitlab.com read only (${why}): no Assign or Close, one line on how`, GL, async ($, on) => {
    paneWorld(on, { ...w })
    const ui = await opened($)
    const k = await keys(ui)
    expect(k).not.toContain('assign')
    expect(k).not.toContain('close')
    expect(k).toContain('work')
    expect(await texts(ui)).toContain(notice)
  })
}
