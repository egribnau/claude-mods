import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitlab } from '../hooks/gitlab'
import type { Send } from '../hooks/tracker'
import type { EpicChild, Repo } from '../types'

// GitLab blockers and epics (#10): an epic is an issue with the Epic label,
// its children the issues it links as related. Blocking links exist only on
// GitLab EE; on Free (CE) there are none, and no waiting rows. Answers shaped
// as GitLab's API v4 gives them, first against a fake Send, then through the
// panes.

const NOW = Date.parse('2026-10-09T12:00:00Z')
const ON = { time: true, deps: true, epics: true }
const OFF = { time: true, deps: false, epics: true }

// Each unit test has a host of its own: gitlab.ts remembers user ids, label
// colours and whether blocking links exist per host or project for as long
// as the module lives, so a host shared with another test could answer from
// that test's answers.
const at = (host: string) => {
  const r: Repo = { host, owner: 'boats', name: 'radar' }
  const base = `https://${host}/api/v4`
  return { r, base, project: `${base}/projects/boats%2Fradar`, path: '/api/v4/projects/boats%2Fradar' }
}

// Fixtures, as GitLab answers them.

const SELF = {
  id: 4711,
  name: 'whats-next',
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
  permissions: { project_access: { access_level: 30, notification_level: 3 }, group_access: null },
}

// What /metadata answers: `enterprise` says GitLab EE, where blocking links
// may exist.
const metadata = (enterprise: boolean) => ({
  version: enterprise ? '17.5.1-ee' : '17.5.1',
  revision: '3f2b8a1c9d0',
  kas: {
    enabled: true,
    externalUrl: 'wss://kas.gitlab.example/',
    externalK8sProxyUrl: 'https://kas.gitlab.example/k8s-proxy/',
    version: '17.5.1',
  },
  enterprise,
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

const PEOPLE: Record<string, number> = { alice: 991, jdoe: 777, mvos: 778 }

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

const SOMEDAY = { ...V12, id: 4410199, iid: 7, title: 'Someday', due_date: null, web_url: 'https://gitlab.com/boats/radar/-/milestones/7' }

// A project label, as /labels lists it: colour with its '#'.
const projectLabel = (id: number, name: string, color: string) => ({
  id,
  name,
  color,
  text_color: '#FFFFFF',
  description: null,
  description_html: '',
  open_issues_count: 3,
  closed_issues_count: 1,
  open_merge_requests_count: 0,
  subscribed: false,
  priority: null,
  is_project_label: true,
})

const LABELS = [projectLabel(31, 'bug', '#d9534f'), projectLabel(32, 'docs', '#428bca'), projectLabel(33, 'Epic', '#6699cc')]

type Extra = {
  title?: string
  state?: 'opened' | 'closed'
  labels?: string[]
  assignees?: string[]
  milestone?: typeof V12 | null
  created?: string
  // Another project's issue, as a link may name one.
  project?: string
}

// An issue as a list gives it with with_labels_details: labels as objects.
// `id` is global and never what What's Next shows; `iid` is the number in the project.
function issue(host: string, iid: number, extra: Extra = {}) {
  const assignees = (extra.assignees ?? []).map(a => person(a, PEOPLE[a] ?? 500))
  const project = extra.project ?? 'boats/radar'
  return {
    id: 160000000 + iid * 37,
    iid,
    project_id: project === 'boats/radar' ? 52117834 : 52117999,
    title: extra.title ?? `Issue ${iid}`,
    description: `Body of ${iid}`,
    state: extra.state ?? 'opened',
    created_at: extra.created ?? '2026-09-18T09:00:00.000Z',
    updated_at: '2026-10-07T12:00:00.000Z',
    closed_at: extra.state === 'closed' ? '2026-10-01T12:00:00.000Z' : null,
    closed_by: null,
    labels: (extra.labels ?? []).map(name => {
      const known = LABELS.find(l => l.name === name)
      return { id: known?.id ?? 99, name, color: known?.color ?? '#cccccc', description: null, text_color: '#FFFFFF' }
    }),
    milestone: extra.milestone === undefined ? null : extra.milestone,
    assignees,
    assignee: assignees[0] ?? null,
    author: person('jdoe', 777),
    type: 'ISSUE',
    user_notes_count: 0,
    merge_requests_count: 0,
    upvotes: 0,
    downvotes: 0,
    due_date: null,
    confidential: false,
    discussion_locked: null,
    issue_type: 'issue',
    web_url: `https://${host}/${project}/-/issues/${iid}`,
    time_stats: { time_estimate: 0, total_time_spent: 0, human_time_estimate: null, human_total_time_spent: null },
    task_completion_status: { count: 0, completed_count: 0 },
    has_tasks: false,
    references: { short: `#${iid}`, relative: `#${iid}`, full: `${project}#${iid}` },
    severity: 'UNKNOWN',
  }
}

// A linked issue, as /issues/:iid/links answers: the issue with plain label
// names, and how it is linked.
function link(host: string, iid: number, linkType: 'relates_to' | 'blocks' | 'is_blocked_by', extra: Extra = {}) {
  const i = issue(host, iid, extra)
  return {
    ...i,
    labels: extra.labels ?? [],
    issue_link_id: 7000 + iid,
    link_type: linkType,
    link_created_at: '2026-09-20T10:00:00.000Z',
    link_updated_at: '2026-09-20T10:00:00.000Z',
  }
}

const stats = (all: number, closed: number) => ({ statistics: { counts: { all, closed, opened: all - closed } } })

// The fake Send.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'down'
type Asked = { url: string; method: string }

function fakeSend(route: (url: URL) => Reply, asked: Asked[] = []): Send {
  return (async (url: string, init?: { method?: string }) => {
    asked.push({ url, method: init?.method ?? 'GET' })
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

const NOT_FOUND: Reply = { status: 404, body: { message: '404 Not Found' } }
const FAILS: Reply = { status: 500, body: { message: '500 Internal Server Error' } }
const ok = (body: unknown): Reply => ({ status: 200, body })
const onePage = (items: unknown[]): Reply => ({
  status: 200,
  body: items,
  headers: {
    'content-type': 'application/json',
    'x-page': '1',
    'x-next-page': '',
    'x-prev-page': '',
    'x-per-page': '100',
    'x-total': String(items.length),
    'x-total-pages': '1',
  },
})

type World = {
  metadata?: Reply
  // What the issues list filtered by label answers.
  epics?: Reply
  // Each issue's links, by iid; an issue left out has none.
  links?: Record<number, Reply>
  labels?: Reply
  milestones?: unknown[]
  // issues_statistics, by milestone title.
  stats?: Record<string, Reply>
}

// The answers check and the tracker ask for, path by path; 404 for anything else.
function route(w: World = {}) {
  return (u: URL): Reply => {
    const p = u.pathname
    if (p === '/api/v4/metadata') return w.metadata ?? NOT_FOUND
    if (p === '/api/v4/personal_access_tokens/self') return ok(SELF)
    if (p === '/api/v4/user') return ok(USER)
    const base = '/api/v4/projects/boats%2Fradar'
    if (p === base) return ok(PROJ)
    if (!p.startsWith(base)) return NOT_FOUND
    const rest = p.slice(base.length)
    if (rest === '/issues' && u.searchParams.has('labels')) return w.epics ?? onePage([])
    if (rest === '/labels') return w.labels ?? onePage(LABELS)
    if (rest === '/milestones') return onePage(w.milestones ?? [])
    if (rest === '/issues_statistics') return w.stats?.[u.searchParams.get('milestone') ?? ''] ?? NOT_FOUND
    const links = /^\/issues\/(\d+)\/links$/.exec(rest)
    if (links) return w.links?.[Number(links[1])] ?? onePage([])
    const one = /^\/issues\/(\d+)(\/.*)?$/.exec(rest)
    if (one && !one[2]) return ok(issue(u.host, Number(one[1])))
    if (one?.[2] === '/notes' || one?.[2] === '/related_merge_requests') return ok([])
    return NOT_FOUND
  }
}

const pathOf = (a: Asked) => new URL(a.url).pathname
const linksAsked = (asked: Asked[]) => asked.map(pathOf).filter(p => p.endsWith('/links'))
const byNumber = (cs: EpicChild[] | null) => [...(cs ?? [])].sort((a, b) => a.number - b.number)

// check(): whether blocking links can exist

test('check: GitLab CE (enterprise false) has epics and time but no blocking links, in four requests', async () => {
  const { r, base } = at('check-ce.example')
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route({ metadata: ok(metadata(false)) }), asked), r, 'glpat-x', null, 'Epic').check()

  expect(got.setup).toMatchObject({ kind: 'ready', login: 'alice', features: { time: true, deps: false, epics: true } })
  expect(asked).toHaveLength(4)
  expect(asked.map(a => a.url)).toContain(`${base}/metadata`)
})

test('check: GitLab EE (enterprise true) may have blocking links', async () => {
  const { r } = at('check-ee.example')
  const got = await gitlab(fakeSend(route({ metadata: ok(metadata(true)) })), r, 'glpat-x', null, 'Epic').check()
  expect(got.setup).toMatchObject({ kind: 'ready', features: { time: true, deps: true, epics: true } })
})

test('check: /metadata failing means no blocking links, and setup is still ready', async () => {
  for (const [k, metadataReply] of [NOT_FOUND, { status: 403, body: { message: '403 Forbidden' } }, FAILS, 'down'].entries()) {
    const { r } = at(`check-nometa-${k}.example`)
    const got = await gitlab(fakeSend(route({ metadata: metadataReply as Reply })), r, 'glpat-x', null, 'Epic').check()
    expect(got.setup).toMatchObject({ kind: 'ready', features: { time: true, deps: false, epics: true } })
  }
})

// epics()

test('epics: the issues carrying the Epic label, compared without case, by iid', async () => {
  const { r, path } = at('epics.example')
  const h = 'epics.example'
  const asked: Asked[] = []
  const answer = onePage([
    issue(h, 20, { title: 'Rate limits', labels: ['epic'], milestone: V12 }),
    issue(h, 3, { title: 'Project setup', labels: ['EPIC', 'docs'], state: 'closed', milestone: V12 }),
    issue(h, 71, { title: 'Ideas', labels: ['Epic'] }),
    // GitLab's filter let it through, yet it carries no Epic label.
    issue(h, 9, { title: 'Epical', labels: ['Epical'] }),
  ])
  const got = await gitlab(fakeSend(route({ epics: answer }), asked), r, 'glpat-x', null, 'Epic').epics()

  expect(got).toEqual([
    { number: 20, title: 'Rate limits', state: 'open', milestone: 'v1.2' },
    { number: 3, title: 'Project setup', state: 'closed', milestone: 'v1.2' },
    { number: 71, title: 'Ideas', state: 'open', milestone: null },
  ])
  const u = new URL(asked[0]?.url ?? '')
  expect(u.pathname).toBe(`${path}/issues`)
  expect(u.searchParams.get('state')).toBe('all')
  expect(u.searchParams.get('labels')).toBe('Epic')
  expect(u.searchParams.get('with_labels_details')).toBe('true')
})

test('epics: a failing list throws, naming the epics', async () => {
  const { r } = at('epics-fails.example')
  const t = gitlab(fakeSend(route({ epics: FAILS })), r, 'glpat-x', null, 'Epic')
  await expect(t.epics()).rejects.toThrow('epics: HTTP 500')
})

// children(n, me)

// Epic #20's links: four related children of this project (one yours, one
// free, one someone else's, one closed), and what is left out: a blocking
// link, a related issue of another project and a related peer epic.
const epicLinkItems = (h: string) => [
  link(h, 37, 'relates_to', { assignees: ['alice'], labels: ['bug'], milestone: V12, created: '2026-09-25T09:00:00.000Z' }),
  link(h, 51, 'relates_to', { labels: ['docs', 'needs-triage'], created: '2026-10-03T09:00:00.000Z' }),
  link(h, 44, 'relates_to', { assignees: ['jdoe'], created: '2026-09-20T09:00:00.000Z' }),
  link(h, 33, 'relates_to', { created: '2026-09-11T09:00:00.000Z' }),
  link(h, 10, 'relates_to', { state: 'closed', created: '2026-08-11T09:00:00.000Z' }),
  link(h, 60, 'blocks'),
  link(h, 5, 'relates_to', { project: 'boats/other' }),
  link(h, 25, 'relates_to', { labels: ['epic'] }),
]
const epicLinks = (h: string) => onePage(epicLinkItems(h))

const CHILDREN: EpicChild[] = [
  {
    number: 10,
    title: 'Issue 10',
    state: 'closed',
    assignees: [],
    mine: false,
    blocked: false,
    labels: [],
    milestone: null,
    created: '2026-08-11T09:00:00.000Z',
    blockedBy: [],
  },
  {
    number: 33,
    title: 'Issue 33',
    state: 'open',
    assignees: [],
    mine: false,
    blocked: false,
    labels: [],
    milestone: null,
    created: '2026-09-11T09:00:00.000Z',
    blockedBy: [],
  },
  {
    number: 37,
    title: 'Issue 37',
    state: 'open',
    assignees: ['alice'],
    mine: true,
    blocked: false,
    labels: [{ name: 'bug', color: 'd9534f' }],
    milestone: 'v1.2',
    created: '2026-09-25T09:00:00.000Z',
    blockedBy: [],
  },
  {
    number: 44,
    title: 'Issue 44',
    state: 'open',
    assignees: ['jdoe'],
    mine: false,
    blocked: false,
    labels: [],
    milestone: null,
    created: '2026-09-20T09:00:00.000Z',
    blockedBy: [],
  },
  {
    number: 51,
    title: 'Issue 51',
    state: 'open',
    assignees: [],
    mine: false,
    blocked: false,
    // A label the project does not list has no colour.
    labels: [
      { name: 'docs', color: '428bca' },
      { name: 'needs-triage', color: '' },
    ],
    milestone: null,
    created: '2026-10-03T09:00:00.000Z',
    blockedBy: [],
  },
]

test('children: related issues of this project, not other epics, with label colours; deps off asks nothing per child', async () => {
  const h = 'children-off.example'
  const { r, path } = at(h)
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ metadata: ok(metadata(false)), links: { 20: epicLinks(h) } }), asked), r, 'glpat-x', null, 'Epic')
  await t.check()
  const before = asked.length

  expect(byNumber(await t.children(20, 'alice'))).toEqual(CHILDREN)
  const after = asked.slice(before)
  expect(linksAsked(after)).toEqual([`${path}/issues/20/links`])
  expect(after.filter(a => pathOf(a) === `${path}/labels`)).toHaveLength(1)
})

test('children: links whose URL names a work item, as newer GitLab answers, are children too', async () => {
  const h = 'children-work-items.example'
  const { r } = at(h)
  const asWorkItems = onePage(epicLinkItems(h).map(l => ({ ...l, web_url: l.web_url.replace('/-/issues/', '/-/work_items/') })))
  const t = gitlab(fakeSend(route({ metadata: ok(metadata(false)), links: { 20: asWorkItems } })), r, 'glpat-x', null, 'Epic')
  await t.check()
  expect(byNumber(await t.children(20, 'alice'))).toEqual(CHILDREN)
})

test('children: without a check, blocking links count as off', async () => {
  const h = 'children-nocheck.example'
  const { r, path } = at(h)
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ links: { 20: epicLinks(h) } }), asked), r, 'glpat-x', null, 'Epic')
  expect(byNumber(await t.children(20, 'alice'))).toEqual(CHILDREN)
  expect(linksAsked(asked)).toEqual([`${path}/issues/20/links`])
})

test('children: the project labels are fetched once, across two calls and trackers', async () => {
  const h = 'children-labels.example'
  const { r, path } = at(h)
  const asked: Asked[] = []
  const send = fakeSend(route({ links: { 20: epicLinks(h), 12: onePage([link(h, 51, 'relates_to', { labels: ['bug'] })]) } }), asked)

  await gitlab(send, r, 'glpat-x', null, 'Epic').children(20, 'alice')
  const second = await gitlab(send, r, 'glpat-x', null, 'Epic').children(12, 'alice')
  expect(second?.[0]?.labels).toEqual([{ name: 'bug', color: 'd9534f' }])
  expect(asked.filter(a => pathOf(a) === `${path}/labels`)).toHaveLength(1)
})

test('children: no label is asked for until a child list needs one', async () => {
  const { r, path } = at('children-lazy.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ metadata: ok(metadata(false)) }), asked), r, 'glpat-x', null, 'Epic')
  await t.check()
  await t.epics()
  expect(asked.some(a => pathOf(a) === `${path}/labels`)).toBe(false)
})

test('children: the epic links failing is null', async () => {
  const { r } = at('children-fails.example')
  for (const reply of [FAILS, 'down'] as const) {
    const t = gitlab(fakeSend(route({ links: { 20: reply } })), r, 'glpat-x', null, 'Epic')
    expect(await t.children(20, 'alice')).toBe(null)
  }
})

test('children: deps on, an open child not yours is blocked by its open is_blocked_by links of this project', async () => {
  const h = 'children-on.example'
  const { r, path } = at(h)
  const asked: Asked[] = []
  const w: World = {
    metadata: ok(metadata(true)),
    links: {
      20: epicLinks(h),
      33: onePage([
        link(h, 37, 'is_blocked_by', { assignees: ['alice'] }),
        link(h, 9, 'is_blocked_by', { state: 'closed' }),
        link(h, 8, 'is_blocked_by', { project: 'boats/other' }),
        link(h, 51, 'blocks'),
        link(h, 40, 'relates_to'),
      ]),
      44: NOT_FOUND,
    },
  }
  const send = fakeSend(route(w), asked)
  await gitlab(send, r, 'glpat-x', null, 'Epic').check()
  // A tracker is built per call: what check found holds for the next one.
  const before = asked.length
  const got = byNumber(await gitlab(send, r, 'glpat-x', null, 'Epic').children(20, 'alice'))

  expect(got.find(c => c.number === 33)).toMatchObject({ blockedBy: [37], blocked: true })
  for (const n of [10, 37, 44, 51]) expect(got.find(c => c.number === n)).toMatchObject({ blockedBy: [], blocked: false })
  // Only the open children that are not yours are asked about.
  expect(linksAsked(asked.slice(before)).sort()).toEqual(
    [`${path}/issues/20/links`, `${path}/issues/33/links`, `${path}/issues/44/links`, `${path}/issues/51/links`].sort(),
  )
})

// blockers(n)

test('blockers: the open is_blocked_by links of this project, by iid', async () => {
  const h = 'blockers.example'
  const { r } = at(h)
  const links = onePage([
    link(h, 37, 'is_blocked_by'),
    link(h, 35, 'is_blocked_by'),
    link(h, 9, 'is_blocked_by', { state: 'closed' }),
    link(h, 8, 'is_blocked_by', { project: 'boats/other' }),
    link(h, 51, 'blocks'),
    link(h, 40, 'relates_to'),
  ])
  const got = await gitlab(fakeSend(route({ links: { 33: links } })), r, 'glpat-x', null, 'Epic').blockers(33)
  expect([...(got ?? [])].sort((a, b) => a - b)).toEqual([35, 37])
})

test('blockers: the links failing is null', async () => {
  const { r } = at('blockers-fails.example')
  for (const reply of [FAILS, 'down'] as const) {
    expect(await gitlab(fakeSend(route({ links: { 33: reply } })), r, 'glpat-x', null, 'Epic').blockers(33)).toBe(null)
  }
})

// issue(n, features)

const detailLinks = (h: string) =>
  onePage([
    link(h, 37, 'is_blocked_by', { title: 'Token refresh on 401' }),
    link(h, 9, 'is_blocked_by', { title: 'Old limits', state: 'closed' }),
    link(h, 51, 'blocks', { title: 'Rate limit settings page' }),
    link(h, 8, 'is_blocked_by', { title: 'Elsewhere', project: 'boats/other' }),
    link(h, 40, 'relates_to', { title: 'Related' }),
  ])

test('issue: with deps, a fourth request for the links gives Blocked by and Blocks, a fifth whether the open blocker is blocked', async () => {
  const h = 'issue-on.example'
  const { r, project } = at(h)
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route({ links: { 33: detailLinks(h) } }), asked), r, 'glpat-x', null, 'Epic').issue(33, ON)

  // A fifth for the open blocker's own links: is it blocked too?
  expect(asked).toHaveLength(5)
  expect(asked.map(a => a.url)).toContain(`${project}/issues/33/links`)
  expect(asked.map(a => a.url)).toContain(`${project}/issues/37/links`)
  expect(got.blockedBy).toEqual([
    { number: 37, title: 'Token refresh on 401', state: 'open', blocked: false },
    { number: 9, title: 'Old limits', state: 'closed' },
  ])
  expect(got.blocks).toEqual([{ number: 51, title: 'Rate limit settings page', state: 'open' }])
})

test('issue: with deps, the links failing leaves both out and the issue loads', async () => {
  const { r } = at('issue-linksfail.example')
  const got = await gitlab(fakeSend(route({ links: { 33: FAILS } })), r, 'glpat-x', null, 'Epic').issue(33, ON)
  expect(got.title).toBe('Issue 33')
  expect(got.blockedBy).toBe(null)
  expect(got.blocks).toBe(null)
})

test('issue: without deps, three requests and no links', async () => {
  const h = 'issue-off.example'
  const { r } = at(h)
  const asked: Asked[] = []
  const got = await gitlab(fakeSend(route({ links: { 33: detailLinks(h) } }), asked), r, 'glpat-x', null, 'Epic').issue(33, OFF)

  expect(asked).toHaveLength(3)
  expect(linksAsked(asked)).toEqual([])
  expect(got.blockedBy).toBe(null)
  expect(got.blocks).toBe(null)
})

// milestones()

test('milestones: closed of total from issues_statistics, a failed one 0/0', async () => {
  const { r, path } = at('milestones-stats.example')
  const asked: Asked[] = []
  const t = gitlab(fakeSend(route({ milestones: [V12, SOMEDAY], stats: { 'v1.2': ok(stats(17, 9)), Someday: FAILS } }), asked), r, 'glpat-x', null, 'Epic')

  expect(await t.milestones()).toEqual([
    { title: 'v1.2', due: '2026-10-31', closed: 9, total: 17, description: '', url: 'https://gitlab.com/boats/radar/-/milestones/2', closedAt: null },
    { title: 'Someday', due: null, closed: 0, total: 0, description: '', url: 'https://gitlab.com/boats/radar/-/milestones/7', closedAt: null },
  ])
  const asks = asked.filter(a => pathOf(a) === `${path}/issues_statistics`).map(a => new URL(a.url).searchParams.get('milestone'))
  expect(asks.sort()).toEqual(['Someday', 'v1.2'])
})

// The panes, on gitlab.com

const H = 'gitlab.com'

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

const EPICS_PANE = {
  ...PANE,
  requestId: 'next-epics',
  props: { ...PANE.props, title: 'Epics', bodyColumns: 50 },
} as const

const RUN = {
  command: 'next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const GL = { options: { gitlabTokens: 'gitlab.com=glpat-x', icons: 'text', compact: 'off', label: 'Epic' } }

// #20 is the epic, someone else's; its related children are #37 (yours),
// #33 (free), #44 (jdoe's) and the closed #10. Of the free open issues #33
// is oldest; on EE it is blocked by #29, which is free too.
const EPIC = issue(H, 20, { title: 'Rate limits', labels: ['Epic'], assignees: ['jdoe'], milestone: V12, created: '2026-09-01T09:00:00.000Z' })
const MINE = issue(H, 37, { assignees: ['alice'], labels: ['bug'], milestone: V12, created: '2026-09-25T09:00:00.000Z' })
const OPEN = [
  EPIC,
  MINE,
  issue(H, 33, { milestone: V12, created: '2026-09-11T09:00:00.000Z' }),
  issue(H, 29, { title: 'Settings screen rework', milestone: V12, created: '2026-09-18T09:00:00.000Z' }),
  issue(H, 44, { assignees: ['jdoe'], milestone: V12, created: '2026-09-20T09:00:00.000Z' }),
]

const LINKS: Record<number, unknown[]> = {
  20: [
    link(H, 37, 'relates_to', { assignees: ['alice'], labels: ['bug'], milestone: V12 }),
    link(H, 33, 'relates_to', { milestone: V12 }),
    link(H, 44, 'relates_to', { assignees: ['jdoe'], milestone: V12 }),
    link(H, 10, 'relates_to', { state: 'closed', milestone: V12 }),
    link(H, 5, 'relates_to', { project: 'boats/other' }),
    link(H, 25, 'relates_to', { labels: ['Epic'] }),
  ],
  33: [link(H, 29, 'is_blocked_by', { title: 'Settings screen rework', milestone: V12 })],
}

type Opened = { id: string; title?: string }

function paneWorld(on: On, enterprise: boolean, asked: string[] = [], opened: Opened[] = []) {
  const clock = mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout =
      cmd === 'git remote get-url origin' ? 'git@gitlab.com:boats/radar.git' : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const u = new URL(e.url)
    const page = Number(u.searchParams.get('page') || '1')
    const reply = (status: number, body: unknown) => ({
      value: {
        status,
        ok: status >= 200 && status < 300,
        headers: {
          'content-type': 'application/json',
          'x-page': String(page),
          'x-next-page': '',
          'x-per-page': '100',
        },
        text: JSON.stringify(body),
      },
    })
    const list = (items: unknown[]) => reply(200, page === 1 ? items : [])
    const p = u.pathname
    const base = '/api/v4/projects/boats%2Fradar'
    if (p === '/api/v4/metadata') return reply(200, metadata(enterprise))
    if (p === '/api/v4/personal_access_tokens/self') return reply(200, SELF)
    if (p === '/api/v4/user') return reply(200, USER)
    if (p === base) return reply(200, PROJ)
    if (p === `${base}/milestones`) return list([V12])
    if (p === `${base}/issues_statistics`) {
      return u.searchParams.get('milestone') === 'v1.2' ? reply(200, stats(7, 2)) : reply(404, { message: '404 Not Found' })
    }
    if (p === `${base}/labels`) return list(LABELS)
    if (p === `${base}/issues`) {
      const label = u.searchParams.get('labels')
      if (label !== null) return list(label.toLowerCase() === 'epic' ? [EPIC] : [])
      if (u.searchParams.get('scope') === 'assigned_to_me') return list([MINE])
      return list(OPEN)
    }
    const links = new RegExp(`^${base}/issues/(\\d+)/links$`).exec(p)
    if (links) return list(LINKS[Number(links[1])] ?? [])
    const one = new RegExp(`^${base}/issues/(\\d+)(/.*)?$`).exec(p)
    if (one && !one[2]) return reply(200, OPEN.find(i => i.iid === Number(one[1])) ?? issue(H, Number(one[1])))
    if (one?.[2] === '/notes' || one?.[2] === '/related_merge_requests') return reply(200, [])
    return reply(404, { message: '404 Not Found' })
  })
  return clock
}

type Found = { key: string; text: string; props: Record<string, unknown> }
type Ui = {
  findAll: (q: { type: string }) => Promise<unknown[]>
  find: (q: { key: string }) => Promise<unknown>
  press: (q: { key: string }) => Promise<unknown>
}
const texts = async (ui: Ui) => ((await ui.findAll({ type: 'Text' })) as Found[]).map(t => t.text)
const rule = (name: string) => `── ${name} `.padEnd(60, '─')
const linkPaths = (asked: string[]) => [...new Set(asked.map(u => new URL(u).pathname).filter(p => p.endsWith('/links')))]
const ERROR = /could not|HTTP \d|error|unknown|failed/i

async function panes($: Engine) {
  await $.command.run(RUN)
  const epics = (await $.ui.mount({ ...EPICS_PANE, surface: 'terminal' })) as Ui
  const next = (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
  return { epics, next }
}

test('GitLab Free: the Epics pane shows the epic in its milestone, x/y closed, its bar and its children', GL, async ($, on) => {
  const opened: Opened[] = []
  const clock = paneWorld(on, false, [], opened)
  await clock.set(NOW)
  const { epics } = await panes($)

  expect(opened.some(p => p.id === 'next-epics')).toBe(true)
  let all = await texts(epics)
  expect(all.slice(0, 5)).toEqual(['── ', 'v1.2', ' · ', 'due 31 Oct', ' · 2/7 closed '])
  // One of its four children is closed.
  expect(all).toContain(`#20 ${'Rate limits'.padEnd(29)} ▰▰▱▱▱▱▱▱   1/4`)

  await epics.press({ key: 'fold-20' })
  all = await texts(epics)
  const rows = all.filter(t => /^ {2}. #\d+ /.test(t) || t.startsWith('  ✓'))
  expect(rows).toEqual(['  ● #37 Issue 37', '    #33 Issue 33', `  ○ #44 ${'Issue 44'.padEnd(37)} jdoe`, '  ✓ 1 closed'])
  // Another project's issue and the peer epic are no children.
  expect(all.some(t => t.includes('#5 ') || t.includes('#25'))).toBe(false)
  const bug = ((await epics.findAll({ type: 'Text' })) as Found[]).find(t => t.text === 'bug')
  expect(bug?.props.color).toBe('#d9534f')
  expect(all.some(t => ERROR.test(t))).toBe(false)
})

test("GitLab Free: What's next has no waiting rows, asks no links for them, and shows no error", GL, async ($, on) => {
  const asked: string[] = []
  const clock = paneWorld(on, false, asked)
  await clock.set(NOW)
  const { epics, next } = await panes($)

  const all = await texts(next)
  // Both panes are open: the tab names What's next, so its title row does not.
  expect(all).toContain(rule('Next in v1.2'))
  // #33 is oldest: with no blocking links it is Next.
  expect(all).toContain('  #33 Issue 33')
  expect(all.some(t => t.startsWith('⊘') || t.startsWith('blocked by') || t === 'Nothing available')).toBe(false)
  expect(all.some(t => ERROR.test(t))).toBe(false)
  expect((await texts(epics)).some(t => ERROR.test(t))).toBe(false)
  // The only links asked are the epic's, for its children.
  expect(linkPaths(asked)).toEqual(['/api/v4/projects/boats%2Fradar/issues/20/links'])
})

test("GitLab EE: an issue blocked by an is_blocked_by link waits in What's next", GL, async ($, on) => {
  const asked: string[] = []
  const clock = paneWorld(on, true, asked)
  await clock.set(NOW)
  const { next } = await panes($)

  const all = await texts(next)
  expect(all).toContain(rule('Next in v1.2'))
  expect(all).toContain('  #29 Settings screen rework')
  expect(all).toContain('⊘ #33 Issue 33')
  expect(all.some(t => t.startsWith('blocked by #29'))).toBe(true)
  expect(linkPaths(asked)).toContain('/api/v4/projects/boats%2Fradar/issues/33/links')
})

test('GitLab EE: the blocked child shows blocked in Epics', GL, async ($, on) => {
  const clock = paneWorld(on, true)
  await clock.set(NOW)
  const { epics } = await panes($)
  await epics.press({ key: 'fold-20' })
  const all = await texts(epics)
  expect(all).toContain('  ⊘ #33 Issue 33')
  expect(all.some(t => t.startsWith('blocked by #29'))).toBe(true)
})

test("GitLab EE: the blocked issue's detail lists what blocks it", GL, async ($, on) => {
  const clock = paneWorld(on, true)
  await clock.set(NOW)
  const { next } = await panes($)
  await next.press({ key: 'pick-33' })

  const all = await texts(next)
  expect(all.some(t => t.includes('Issue 33'))).toBe(true)
  expect(all).toContain('Blocked by     ')
  expect(all.some(t => t.startsWith('#29'))).toBe(true)
  expect(all.some(t => t.includes('Settings screen rework'))).toBe(true)
})
