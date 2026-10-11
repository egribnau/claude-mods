import type { Actions, CommitRef, EpicChild, Features, IssueDetail, IssueRow, Ref, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName } from './forge'
import { message, type Checked, type EpicRow, type OpenIssue, type Send, type Tracker } from './tracker'

// Forgejo, or Gitea, behind the tracker the pane asks: every Forgejo URL
// lives here. `token` is from the Forgejo tokens setting, null when it has
// none for the host; `label` is the Epic label setting. `known`: the raw
// version detection already read, so check does not ask for it again.
export function forgejo(send: Send, r: Repo, token: string | null, label: string, known?: string): Tracker {
  const slug = `${r.owner}/${r.name}`
  const base = `https://${r.host}/api/v1`
  const api = `${base}/repos/${slug}`
  const headers = { Authorization: `token ${token ?? ''}`, Accept: 'application/json' }
  const get = (url: string) => send(url, { method: 'GET', headers })

  // Forgejo's milestones carry no page URL: it is built from the id.
  const toMilestone = (m: RawMilestone): MilestoneRow => ({
    title: m.title,
    due: m.due_on,
    closed: m.closed_issues,
    total: m.open_issues + m.closed_issues,
    description: m.description ?? '',
    url: `https://${r.host}/${slug}/milestone/${m.id}`,
    closedAt: m.closed_at ?? null,
    id: m.id,
  })

  // Every page of a list, 50 at a time; a page that fails names `what`.
  async function fetchAll<T>(url: string, what: string): Promise<T[]> {
    const found: T[] = []
    for (let page = 1; ; page++) {
      const res = await get(`${url}&limit=50&page=${page}`)
      if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
      const batch = JSON.parse(res.text) as T[]
      found.push(...batch)
      if (batch.length < 50) break
    }
    return found
  }

  // One request's JSON, or null when it failed.
  async function fetchJson<T>(url: string): Promise<T | null> {
    const res = await get(url).catch(() => null)
    if (!res?.ok) return null
    try {
      return JSON.parse(res.text) as T
    } catch {
      return null
    }
  }

  const deps = (n: number) => fetchJson<RawDep[]>(`${api}/issues/${n}/dependencies`)

  // A change to issue `n`: null when Forgejo took it, else why not.
  const patch = (n: number, body: object) => patchAt(`${api}/issues/${n}`, body)

  // A change at `url`: null when Forgejo took it, else why not.
  async function patchAt(url: string, body: object): Promise<string | null> {
    const res = await send(url, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err: unknown) => message(err))
    if (typeof res !== 'string' && res.ok) return null
    let why = typeof res === 'string' ? res : `HTTP ${res.status}`
    if (typeof res !== 'string') {
      try {
        why = (JSON.parse(res.text) as { message?: string }).message || why
      } catch {
        // The status says enough.
      }
    }
    return why
  }

  // Each step in turn, stopping at the first that fails: a Forgejo (or
  // Gitea) at the host, a token, and the token reading the repo.
  async function check(): Promise<Checked> {
    const raw = known ?? (await askVersion())
    if (typeof raw !== 'string') return { version: null, setup: raw }
    const version = forgeName({ kind: 'forgejo', version: raw })
    if (!supported(raw)) return { version, setup: { kind: 'not-forgejo', reason: 'too-old', detail: version } }
    if (!token) return { version, setup: { kind: 'no-token' } }

    try {
      const res = await get(api)
      // Who the token belongs to, once the repo answers: what makes an issue yours.
      const user = res.ok ? await get(`${base}/user`) : null
      const login = user?.ok ? (JSON.parse(user.text) as { login: string }).login : null
      const repo = user?.ok ? (JSON.parse(res.text) as RawRepo) : null
      const setup: Setup = repo && login !== null
        ? {
            kind: 'ready',
            openIssues: repo.open_issues_count,
            login,
            actions: await mayAct(login, repo.permissions?.push === true),
            features: {
              time: repo.internal_tracker?.enable_time_tracker !== false,
              deps: repo.internal_tracker?.enable_issue_dependencies !== false,
              epics: true,
            },
          }
        : user && (user.status === 401 || user.status === 403)
          ? { kind: 'no-scope', missing: 'read:user' }
          : user
            ? { kind: 'error', message: `/user: HTTP ${user.status}` }
            : res.status === 401
              ? { kind: 'token-refused' }
              : res.status === 403
                ? { kind: 'no-scope' }
                : res.status === 404
                  ? { kind: 'not-found' }
                  : { kind: 'error', message: `${slug}: HTTP ${res.status}` }
      return { version, setup }
    } catch (err) {
      return { version, setup: { kind: 'error', message: message(err) } }
    }
  }

  // Forgejo or Gitea answers /api/v1/version without a token: its raw
  // version, or why there is none.
  async function askVersion(): Promise<string | Setup> {
    const res = await send(`${base}/version`, { method: 'GET', headers: { Accept: 'application/json' } })
      .catch((err: unknown) => message(err))
    if (typeof res === 'string') return { kind: 'not-forgejo', reason: 'no-answer', detail: res }
    let raw: unknown
    try {
      raw = res.ok ? (JSON.parse(res.text) as { version?: unknown }).version : undefined
    } catch {
      raw = undefined
    }
    return typeof raw === 'string' ? raw : { kind: 'not-forgejo', reason: 'other', detail: `HTTP ${res.status} for /api/v1/version` }
  }

  // Whether What's Next may assign and close: the token's scopes, from the list of the
  // account's tokens (the one ending in the same eight characters), and push
  // rights on the repo. A list Forgejo refuses leaves it unknown.
  async function mayAct(login: string, push: boolean): Promise<Actions> {
    const res = await get(`${base}/users/${encodeURIComponent(login)}/tokens?limit=50`).catch(() => null)
    let scopes: string[] | null = null
    try {
      const list = res?.ok ? (JSON.parse(res.text) as { token_last_eight?: string; scopes?: string[] | null }[]) : null
      scopes = list?.find(t => t.token_last_eight === (token ?? '').slice(-8))?.scopes ?? null
    } catch {
      scopes = null
    }
    if (scopes === null) return push ? { kind: 'unknown' } : { kind: 'read-only', reason: 'push' }
    if (!scopes.some(sc => sc === 'all' || sc === 'write:issue' || sc === 'write:all')) return { kind: 'read-only', reason: 'scope' }
    return push ? { kind: 'ok' } : { kind: 'read-only', reason: 'push' }
  }

  return {
    check,
    name: 'Forgejo',
    tokensUrl: `https://${r.host}/user/settings/applications`,
    scopes: 'write:issue, read:repository and read:user; read:issue instead of write:issue is read only',
    writeScope: 'write:issue',
    setting: 'Forgejo tokens',

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${api}/milestones?state=open`, 'milestones').catch(() => [])
      return raw.map(toMilestone)
    },

    async closedMilestones(n: number): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${api}/milestones?state=closed`, 'closed milestones').catch(() => [])
      return raw
        .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
        .slice(0, n)
        .map(toMilestone)
    },

    // Forgejo's search covers every repo the token sees, so it is narrowed
    // to this one.
    async mine(): Promise<IssueRow[]> {
      const found = await fetchAll<RawFound>(`${base}/repos/issues/search?assigned=true&state=open&type=issues`, 'your issues')
      return found.filter(i => i.repository.full_name === slug).map(toRow)
    },

    async open(): Promise<OpenIssue[]> {
      const found = await fetchAll<RawOpen>(`${api}/issues?state=open&type=issues`, 'open issues')
      return found.map(i => ({
        ...toRow(i),
        assignees: [...(i.assignee ? [i.assignee.login] : []), ...(i.assignees ?? []).map(a => a.login)],
      }))
    },

    async epics(): Promise<EpicRow[]> {
      const found = await fetchAll<RawEpic>(`${api}/issues?state=all&type=issues&labels=${encodeURIComponent(label)}`, 'epics')
      return found
        .filter(i => (i.labels ?? []).some(l => l.name === label))
        .map(i => ({ number: i.number, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', milestone: i.milestone?.title ?? null, due: i.due_date ?? null }))
    },

    async blockers(n: number): Promise<number[] | null> {
      const raw = await deps(n)
      return raw ? raw.filter(d => d.state === 'open').map(d => d.number) : null
    },

    // An epic's children are the issues it depends on, other epics left
    // out: an epic that depends on another waits for it, as any issue does.
    async children(n: number, me: string | null): Promise<EpicChild[] | null> {
      const raw = await deps(n)
      if (!raw) return null
      return Promise.all(
        raw
          .filter(c => !(c.labels ?? []).some(l => l.name === label))
          .map(async (c): Promise<EpicChild> => {
          const assignees = (c.assignees ?? []).map(a => a.login)
          const open = c.state !== 'closed'
          const mine = me !== null && assignees.includes(me)
          // Only an open child that is not yours is checked for what blocks it.
          const blockedBy = open && !mine ? ((await deps(c.number)) ?? []).filter(d => d.state !== 'closed').map(d => d.number) : []
          return {
            number: c.number,
            title: c.title,
            state: open ? 'open' : 'closed',
            assignees,
            mine,
            blocked: blockedBy.length > 0,
            labels: (c.labels ?? []).map(l => ({ name: l.name, color: l.color ?? '' })),
            milestone: c.milestone?.title ?? null,
            created: c.created_at ?? '',
            due: c.due_date ?? null,
            blockedBy,
          }
        }),
      )
    },

    issue(n: number, features: Features): Promise<IssueDetail> {
      return loadIssue(async path => {
        const res = await get(`${api}${path}`).catch(() => null)
        if (!res) return null
        let json: unknown = null
        try {
          json = res.ok ? JSON.parse(res.text) : null
        } catch {
          json = null
        }
        return { ok: res.ok, status: res.status, json }
      }, slug, n, features)
    },

    assign: (n, assignees) => patch(n, { assignees }),
    close: (n, closed) => patch(n, { state: closed ? 'closed' : 'open' }),
    closeMilestone: (m, closed) => patchAt(`${api}/milestones/${m.id}`, { state: closed ? 'closed' : 'open' }),
  }
}

// Whether a Forgejo or Gitea version is 1.19 or newer, the first with
// scoped tokens. Forgejo numbers from 7.0 on are all newer.
function supported(version: string): boolean {
  const [major, minor] = version.split(/[.+-]/).map(Number)
  if (major === undefined || Number.isNaN(major)) return false
  return major > 1 || (major === 1 && (minor ?? 0) >= 19)
}

type RawRepo = {
  open_issues_count: number
  permissions?: { push?: boolean }
  internal_tracker?: { enable_time_tracker?: boolean; enable_issue_dependencies?: boolean }
}

type RawListed = {
  number: number
  title: string
  created_at: string
  due_date?: string | null
  html_url: string
  body: string | null
  milestone: { title: string } | null
  labels: { name: string; color?: string }[] | null
}
type RawFound = RawListed & { repository: { full_name: string } }
type RawOpen = RawListed & { assignee?: { login: string } | null; assignees?: { login: string }[] | null }

const toRow = (i: RawListed): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: (i.labels ?? []).map(l => ({ name: l.name, color: l.color ?? '' })),
  created: i.created_at,
  due: i.due_date ?? null,
  url: i.html_url,
  body: i.body ?? '',
})

type RawDep = {
  number: number
  title: string
  state: string
  assignees?: { login: string }[] | null
  labels?: { name: string; color?: string }[] | null
  milestone?: { title: string } | null
  created_at?: string
  due_date?: string | null
}
type RawEpic = RawDep & { milestone: { title: string } | null; labels: { name: string }[] | null }
type RawMilestone = {
  id: number
  title: string
  description?: string | null
  due_on: string | null
  open_issues: number
  closed_issues: number
  closed_at?: string | null
}

// What one GET answered: its status and, when it was ok, its parsed body.
export type Got = { ok: boolean; status: number; json: unknown }
export type Get = (path: string) => Promise<Got | null>

type RawUser = { login: string } | null
type RawRef = {
  number: number
  title: string
  state: string
  pull_request?: { merged?: boolean } | null
  repository?: { full_name: string } | null
}
type RawIssue = RawRef & {
  html_url: string
  body: string | null
  user: RawUser
  created_at: string
  updated_at: string
  comments: number
  milestone: { title: string; due_on: string | null } | null
  due_date: string | null
  ref: string | null
  labels: { name: string; color: string }[] | null
  assignees?: { login: string }[] | null
}
type RawComment = { user: RawUser; created_at: string; body: string | null }
type RawTimeline = {
  type: string
  created_at: string
  body: string | null
  ref_commit_sha: string | null
  ref_issue: RawRef | null
}
type RawTime = { time: number }

// Every page of a list, 50 at a time, as one answer; the first page's
// failure is the answer's.
async function pages(get: Get, path: string): Promise<Got | null> {
  const all: unknown[] = []
  for (let page = 1; ; page++) {
    const got = await get(`${path}?limit=50&page=${page}`)
    if (!got?.ok || !Array.isArray(got.json)) return page === 1 ? got : { ok: true, status: 200, json: all }
    all.push(...got.json)
    if (got.json.length < 50) return { ok: true, status: 200, json: all }
  }
}

const list = <T>(got: Got | null): T[] | null => (got?.ok && Array.isArray(got.json) ? (got.json as T[]) : null)

const ref = (r: RawRef): Ref => ({
  number: r.number,
  title: r.title,
  state: r.pull_request?.merged ? 'merged' : r.state,
})

// A commit message as the timeline holds it: a link around the message,
// HTML-escaped. Its first line, as text.
function commitMessage(body: string): string {
  const text = body
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  return (text.split('\n')[0] ?? '').trim()
}

// Everything the detail view shows of issue `n`, read in one go: the issue,
// its comments, what blocks it and what it blocks, its timeline (pull
// requests and commits that refer to it) and its tracked time. Only the
// issue itself must answer; each other part is left out when it fails.
// What the repo turned off (time tracking, dependencies) is not asked for, and
// its lines are left out. The timeline is read page by page, to its end.
async function loadIssue(get: Get, slug: string, n: number, features: Features): Promise<IssueDetail> {
  const at = `/issues/${n}`
  const none = async (): Promise<Got | null> => null
  const [main, comments, deps, blocks, timeline, times] = await Promise.all([
    get(at),
    get(`${at}/comments`),
    features.deps ? get(`${at}/dependencies`) : none(),
    features.deps ? get(`${at}/blocks`) : none(),
    pages(get, `${at}/timeline`),
    features.time ? get(`${at}/times`) : none(),
  ])
  if (!main) throw new Error(`#${n}: no answer`)
  if (!main.ok) throw new Error(`#${n}: HTTP ${main.status}`)
  const i = main.json as RawIssue

  const last = list<RawComment>(comments)?.at(-1)
  const items = list<RawTimeline>(timeline)
  const pulls: Ref[] | null = items
    ? items
        .filter(t => t.type === 'pull_ref' && t.ref_issue)
        .map(t => ref(t.ref_issue as RawRef))
        .filter((p, k, all) => all.findIndex(q => q.number === p.number) === k)
    : null
  const commits: CommitRef[] | null = items
    ? items
        .filter(t => t.type === 'commit_ref' && t.ref_commit_sha)
        .map(t => ({ sha: (t.ref_commit_sha ?? '').slice(0, 7), message: commitMessage(t.body ?? ''), when: t.created_at }))
        .filter((c, k, all) => all.findIndex(d => d.sha === c.sha) === k)
        .reverse()
    : null
  const logged = list<RawTime>(times)
  // Only this repo's issues: What's Next shows this repo's numbers only.
  const ours = (got: Got | null) =>
    list<RawRef>(got)?.filter(d => !d.repository || d.repository.full_name.toLowerCase() === slug.toLowerCase()) ?? null
  const blockers = ours(deps)
  // Whether each open blocker is itself blocked by an open issue, one
  // request each; one that does not answer counts as not blocked.
  const blockedBy = blockers
    ? await Promise.all(
        blockers.map(async d => {
          if (d.state !== 'open') return ref(d)
          const theirs = list<RawRef>(await get(`/issues/${d.number}/dependencies`)) ?? []
          return { ...ref(d), blocked: theirs.some(x => x.state === 'open') }
        }),
      )
    : null

  return {
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    body: i.body ?? '',
    author: i.user?.login ?? 'someone',
    created: i.created_at,
    updated: i.updated_at,
    comments: i.comments,
    milestone: i.milestone ? { title: i.milestone.title, due: i.milestone.due_on } : null,
    due: i.due_date,
    branch: i.ref ? i.ref.replace(/^refs\/(heads|tags)\//, '') : null,
    logged: logged ? logged.reduce((sum, t) => sum + t.time, 0) : null,
    estimate: null,
    labels: (i.labels ?? []).map(l => ({ name: l.name, color: l.color })),
    assignees: (i.assignees ?? []).map(a => a.login),
    blockedBy,
    blocks: ours(blocks)?.map(ref) ?? null,
    pulls,
    commits,
    lastComment: last ? { author: last.user?.login ?? 'someone', when: last.created_at, body: last.body ?? '' } : null,
  }
}
