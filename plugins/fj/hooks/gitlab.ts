import type { Actions, IssueDetail, IssueRow, Ref, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName } from './forge'
import { message, type Checked, type EpicRow, type OpenIssue, type Send, type Tracker } from './tracker'

// GitLab behind the tracker the pane asks: every GitLab URL lives here.
// `token` is from the GitLab tokens setting, null when it has none for the
// host; `known`: the version detection found, null when it would not say.
// No blockers or epics yet.
export function gitlab(send: Send, r: Repo, token: string | null, known: string | null): Tracker {
  const slug = `${r.owner}/${r.name}`
  const base = `https://${r.host}/api/v4`
  // The owner may be a group path with slashes: GitLab takes the whole path
  // as one encoded id.
  const project = `${base}/projects/${encodeURIComponent(slug)}`
  const headers = { 'PRIVATE-TOKEN': token ?? '', Accept: 'application/json' }
  const get = (url: string) => send(url, { method: 'GET', headers })
  const ids = idsAt(r.host)

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

  // A change to issue `n`: null when GitLab took it, else why not.
  async function put(n: number, body: object): Promise<string | null> {
    const res = await send(`${project}/issues/${n}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err: unknown) => message(err))
    if (typeof res === 'string') return res
    return res.ok ? null : refusal(res)
  }

  // A login's user id, from what fj saw before or else from GitLab's exact
  // match on the username; a string says why there is none.
  async function idOf(login: string): Promise<number | string> {
    const seen = ids.get(login)
    if (seen !== undefined) return seen
    const res = await get(`${base}/users?username=${encodeURIComponent(login)}`).catch((err: unknown) => message(err))
    if (typeof res === 'string') return res
    if (!res.ok) return refusal(res)
    let id: number | undefined
    try {
      id = (JSON.parse(res.text) as { id: number }[])[0]?.id
    } catch {
      id = undefined
    }
    if (id === undefined) return `no GitLab user ${login}`
    ids.set(login, id)
    return id
  }

  // The people an issue names carry their ids: kept for assigning later.
  function remember(i: RawIssue) {
    for (const u of [i.author, ...(i.assignees ?? [])]) if (u?.id !== undefined) ids.set(u.username, u.id)
  }

  // Every page of a list, 100 at a time; a page that fails names `what`.
  // GitLab says in x-next-page whether there is another; without that
  // header, a full page means there may be.
  async function fetchAll<T>(url: string, what: string): Promise<T[]> {
    const found: T[] = []
    for (let page = 1; ; page++) {
      const res = await get(`${url}&per_page=100&page=${page}`)
      if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
      const batch = JSON.parse(res.text) as T[]
      found.push(...batch)
      const next = res.headers['x-next-page']
      if (next !== undefined ? next.trim() === '' : batch.length < 100) break
    }
    return found
  }

  // Each step in turn, stopping at the first that fails: a token, its
  // scopes where GitLab lists them, who it belongs to, and the token
  // reading the project. The scopes and your role there decide the actions.
  async function check(): Promise<Checked> {
    const version = forgeName({ kind: 'gitlab', version: known })
    const done = (setup: Setup): Checked => ({ version, setup })
    if (!token) return done({ kind: 'no-token' })
    const noScope: Setup = { kind: 'no-scope', missing: 'read_api' }

    try {
      // An older GitLab does not know this endpoint: its scopes stay unknown.
      // null: the scopes are unknown.
      let write: boolean | null = null
      const self = await get(`${base}/personal_access_tokens/self`)
      if (self.status === 401) return done({ kind: 'token-refused' })
      if (self.ok) {
        const scopes = (JSON.parse(self.text) as { scopes?: string[] }).scopes ?? []
        if (!scopes.includes('api') && !scopes.includes('read_api')) return done(noScope)
        write = scopes.includes('api')
      }

      const user = await get(`${base}/user`)
      if (user.status === 401) return done({ kind: 'token-refused' })
      if (user.status === 403) return done(noScope)
      if (!user.ok) return done({ kind: 'error', message: `/user: HTTP ${user.status}` })
      const me = JSON.parse(user.text) as { id?: number; username: string }
      const login = me.username
      if (me.id !== undefined) ids.set(login, me.id)

      const res = await get(project)
      if (res.status === 401) return done({ kind: 'token-refused' })
      if (res.status === 403) return done({ kind: 'no-scope' })
      if (res.status === 404) return done({ kind: 'not-found' })
      if (!res.ok) return done({ kind: 'error', message: `${slug}: HTTP ${res.status}` })
      const repo = JSON.parse(res.text) as RawProject
      // The higher of your role in the project and in its group: Reporter (20)
      // or higher may assign and close.
      const access = Math.max(repo.permissions?.project_access?.access_level ?? 0, repo.permissions?.group_access?.access_level ?? 0)
      const actions: Actions =
        write === false
          ? { kind: 'read-only', reason: 'scope' }
          : access < 20
            ? { kind: 'read-only', reason: 'role' }
            : write === null
              ? { kind: 'unknown' }
              : { kind: 'ok' }
      return done({
        kind: 'ready',
        openIssues: repo.open_issues_count ?? 0,
        login,
        actions,
        // GitLab always tracks time.
        features: { time: true, deps: false, epics: false },
      })
    } catch (err) {
      return done({ kind: 'error', message: message(err) })
    }
  }

  return {
    check,
    name: 'GitLab',
    tokensUrl: `https://${r.host}/-/user_settings/personal_access_tokens`,
    scopes: 'api, or read_api for read only',
    writeScope: 'api',
    setting: 'GitLab tokens',

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${project}/milestones?state=active&include_ancestors=true`, 'milestones').catch(() => [])
      return raw.map(m => ({ title: m.title, due: m.due_date ?? null, closed: 0, total: 0 }))
    },

    async mine(): Promise<IssueRow[]> {
      const found = await fetchAll<RawIssue>(`${project}/issues?state=opened&scope=assigned_to_me&with_labels_details=true`, 'your issues')
      found.forEach(remember)
      return found.map(toRow)
    },

    async open(): Promise<OpenIssue[]> {
      const found = await fetchAll<RawIssue>(`${project}/issues?state=opened&with_labels_details=true`, 'open issues')
      found.forEach(remember)
      return found.map(i => ({ ...toRow(i), assignees: (i.assignees ?? []).map(a => a.username) }))
    },

    epics: async (): Promise<EpicRow[]> => [],
    blockers: async () => null,
    children: async () => null,

    // The issue, its latest notes and the merge requests that mention it,
    // read in one go. Only the issue itself must answer; each other part is
    // left out when it fails.
    async issue(n: number): Promise<IssueDetail> {
      const at = `${project}/issues/${n}`
      const [res, notes, merges] = await Promise.all([
        get(at),
        fetchJson<RawNote[]>(`${at}/notes?sort=desc&order_by=created_at&per_page=20`),
        fetchJson<RawRef[]>(`${at}/related_merge_requests`),
      ])
      if (!res.ok) throw new Error(`#${n}: HTTP ${res.status}`)
      const i = JSON.parse(res.text) as RawIssue
      remember(i)
      // GitLab's own notes (assigned, closed, labels) are no comments.
      const last = Array.isArray(notes) ? notes.find(c => c.system !== true) : undefined
      return {
        number: i.iid,
        title: i.title,
        state: i.state === 'opened' ? 'open' : i.state,
        url: i.web_url,
        body: i.description ?? '',
        author: i.author?.username ?? 'someone',
        created: i.created_at,
        updated: i.updated_at,
        comments: i.user_notes_count ?? 0,
        milestone: i.milestone ? { title: i.milestone.title, due: i.milestone.due_date ?? null } : null,
        due: i.due_date ?? null,
        branch: null,
        logged: i.time_stats?.total_time_spent ?? null,
        estimate: i.time_stats?.time_estimate || null,
        labels: labels(i),
        assignees: (i.assignees ?? []).map(a => a.username),
        blockedBy: null,
        blocks: null,
        pulls: Array.isArray(merges) ? merges.map(toRef) : null,
        commits: null,
        lastComment: last ? { author: last.author?.username ?? 'someone', when: last.created_at, body: last.body ?? '' } : null,
      }
    },

    // One assignee goes in assignee_id, which GitLab Free takes; several
    // only in assignee_ids, which only its paid tiers allow. 0 is none.
    async assign(n: number, assignees: string[]): Promise<string | null> {
      const found: number[] = []
      for (const login of assignees) {
        const id = await idOf(login)
        if (typeof id === 'string') return id
        found.push(id)
      }
      return put(n, found.length > 1 ? { assignee_ids: found } : { assignee_id: found[0] ?? 0 })
    },
    close: (n, closed) => put(n, { state_event: closed ? 'close' : 'reopen' }),
  }
}

// An issue as GitLab lists it: `iid` is its number in the project, `id` one
// across the whole instance, which fj never shows.
type RawUser = { id?: number; username: string }
type RawIssue = {
  iid: number
  title: string
  state: string
  web_url: string
  description: string | null
  author?: RawUser | null
  created_at: string
  updated_at: string
  user_notes_count?: number
  milestone: { title: string; due_date?: string | null } | null
  due_date?: string | null
  // Objects with with_labels_details, else plain names.
  labels?: ({ name: string; color?: string } | string)[] | null
  assignees?: RawUser[] | null
  // Both in seconds.
  time_stats?: { time_estimate?: number | null; total_time_spent?: number | null } | null
}
type RawMilestone = { title: string; due_date?: string | null }

// Labels with their colour as `rrggbb`, GitLab's without its `#`.
const labels = (i: RawIssue) =>
  (i.labels ?? []).map(l => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: (l.color ?? '').replace(/^#/, '') }))

const toRow = (i: RawIssue): IssueRow => ({
  number: i.iid,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: labels(i),
  created: i.created_at,
  url: i.web_url,
  body: i.description ?? '',
})

// The project as check reads it: your access level in it, and in its group.
type RawProject = {
  open_issues_count?: number
  permissions?: {
    project_access?: { access_level?: number } | null
    group_access?: { access_level?: number } | null
  } | null
}

// A note on an issue: `system` for the ones GitLab writes itself.
type RawNote = { author?: { username: string } | null; created_at: string; body: string | null; system?: boolean }

// A merge request as GitLab lists it for an issue.
type RawRef = { iid: number; title: string; state: string }

const toRef = (m: RawRef): Ref => ({ number: m.iid, title: m.title, state: m.state === 'opened' ? 'open' : m.state })

// The user ids fj saw on each host, by username: assigning takes ids.
const idsByHost = new Map<string, Map<string, number>>()
function idsAt(host: string): Map<string, number> {
  let ids = idsByHost.get(host)
  if (!ids) idsByHost.set(host, (ids = new Map()))
  return ids
}

// Why GitLab refused a request: its `message`, a text or an object of texts
// per field, or its `error`, else the status.
function refusal(res: { status: number; text: string }): string {
  let body: { message?: unknown; error?: unknown } | null = null
  try {
    body = JSON.parse(res.text) as { message?: unknown; error?: unknown }
  } catch {
    body = null
  }
  const m = body?.message
  if (typeof m === 'string' && m) return m
  if (m && typeof m === 'object') {
    const text = Object.values(m).flat().join(', ')
    if (text) return text
  }
  if (typeof body?.error === 'string' && body.error) return body.error
  return `HTTP ${res.status}`
}
