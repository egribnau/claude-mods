import type { Actions, EpicChild, Features, IssueDetail, IssueRow, Ref, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName, gitlabSetting } from './forge'
import { message, type Checked, type EpicRow, type OpenIssue, type Send, type Tracker } from './tracker'

// GitLab behind the tracker the pane asks: every GitLab URL lives here.
// `token` is from the GitLab.com token setting for gitlab.com, else from the
// Private GitLab token setting, null when it has none for the host; `known`: the version detection found, null when it would not say;
// `label` is the Epic label setting.
// An epic is an issue with the Epic label; its children are the issues it
// links as related. Blocking links exist only on GitLab EE.
export function gitlab(send: Send, r: Repo, token: string | null, known: string | null, label = 'epic'): Tracker {
  const slug = `${r.owner}/${r.name}`
  const base = `https://${r.host}/api/v4`
  // The owner may be a group path with slashes: GitLab takes the whole path
  // as one encoded id.
  const project = `${base}/projects/${encodeURIComponent(slug)}`
  const headers = { 'PRIVATE-TOKEN': token ?? '', Accept: 'application/json' }
  const get = (url: string) => send(url, { method: 'GET', headers })
  const ids = idsAt(r.host)
  // Whether a linked issue's web_url is in this project: links may reach
  // into other projects, which What's Next leaves out. Newer GitLab names
  // an issue a work item in the URL.
  const here = [`https://${r.host}/${slug}/-/issues/`, `https://${r.host}/${slug}/-/work_items/`]
  const inProject = (url: string) => here.some(p => url.startsWith(p))
  const epicLabel = label.toLowerCase()
  const isEpic = (names: string[]) => names.some(l => l.toLowerCase() === epicLabel)

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

  // A milestone with how many of its issues are closed, of all: 0 of 0 when
  // GitLab would not say.
  async function counted(m: RawMilestone): Promise<MilestoneRow> {
    const s = await fetchJson<RawStatistics>(`${project}/issues_statistics?milestone=${encodeURIComponent(m.title)}`)
    const counts = s?.statistics?.counts
    return {
      title: m.title,
      due: m.due_date ?? null,
      closed: counts?.closed ?? 0,
      total: counts?.all ?? 0,
      description: m.description ?? '',
      url: m.web_url,
      // GitLab does not say when a milestone closed.
      closedAt: null,
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

  // A login's user id, from what was seen before or else from GitLab's exact
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
  function remember(i: Pick<RawIssue, 'author' | 'assignees'>) {
    for (const u of [i.author, ...(i.assignees ?? [])]) if (u?.id !== undefined) ids.set(u.username, u.id)
  }

  // Every page of a list, 100 at a time; a page that fails names `what`.
  // GitLab says in x-next-page whether there is another; without that
  // header, a full page means there may be.
  async function fetchAll<T>(url: string, what: string): Promise<T[]> {
    const found: T[] = []
    for (let page = 1; ; page++) {
      const res = await get(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
      const batch = JSON.parse(res.text) as T[]
      found.push(...batch)
      const next = res.headers['x-next-page']
      if (next !== undefined ? next.trim() === '' : batch.length < 100) break
    }
    return found
  }

  // The issues linked to issue `n` that are in this project, of one kind;
  // null when GitLab would not say. Their people's ids are kept.
  async function links(n: number, kind: RawLink['link_type']): Promise<RawLink[] | null> {
    const raw = await fetchJson<RawLink[]>(`${project}/issues/${n}/links`)
    if (!Array.isArray(raw)) return null
    raw.forEach(remember)
    return raw.filter(l => l.link_type === kind && inProject(l.web_url))
  }

  // The project's labels by name, with their colour as `rrggbb`, read once
  // per project for the run: links name labels without colours.
  function colours(): Promise<Map<string, string>> {
    const seen = coloursByProject.get(project)
    if (seen) return seen
    // A refused list is asked again next time; until then labels have no colour.
    const asked = fetchAll<{ name: string; color?: string }>(`${project}/labels`, 'labels').then(
      all => new Map(all.map(l => [l.name, (l.color ?? '').replace(/^#/, '')])),
      () => {
        coloursByProject.delete(project)
        return new Map<string, string>()
      },
    )
    coloursByProject.set(project, asked)
    return asked
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

      // GitLab EE says so in its metadata: only there can issues block
      // others (on a paid tier). Community Edition, or no answer, has none.
      const [res, meta] = await Promise.all([get(project), fetchJson<{ enterprise?: boolean }>(`${base}/metadata`)])
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
      const deps = meta?.enterprise === true
      depsByProject.set(project, deps)
      return done({
        kind: 'ready',
        openIssues: repo.open_issues_count ?? 0,
        login,
        actions,
        // GitLab always tracks time.
        features: { time: true, deps, epics: true },
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
    setting: gitlabSetting(r.host),

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${project}/milestones?state=active&include_ancestors=true`, 'milestones').catch(() => [])
      return Promise.all(raw.map(counted))
    },

    // GitLab does not say when a milestone closed: its last change stands in.
    async closedMilestones(n: number): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${project}/milestones?state=closed&include_ancestors=true`, 'closed milestones').catch(() => [])
      return Promise.all(raw.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')).slice(0, n).map(counted))
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

    // GitLab matches labels without regard to case; so does What's Next.
    async epics(): Promise<EpicRow[]> {
      const found = await fetchAll<RawIssue>(
        `${project}/issues?state=all&labels=${encodeURIComponent(label)}&with_labels_details=true`,
        'epics',
      )
      found.forEach(remember)
      return found
        .filter(i => isEpic(labels(i).map(l => l.name)))
        .map(i => ({ number: i.iid, title: i.title, state: i.state === 'opened' ? 'open' : 'closed', milestone: i.milestone?.title ?? null }))
    },

    async blockers(n: number): Promise<number[] | null> {
      const raw = await links(n, 'is_blocked_by')
      return raw ? raw.filter(l => l.state === 'opened').map(l => l.iid) : null
    },

    // An epic's children are the issues it links as related, other epics
    // left out: those are its peers.
    async children(n: number, me: string | null): Promise<EpicChild[] | null> {
      const raw = await links(n, 'relates_to')
      if (!raw) return null
      const kids = raw.filter(l => !isEpic(names(l)))
      const colour = kids.some(c => names(c).length > 0) ? await colours() : new Map<string, string>()
      const deps = depsByProject.get(project) ?? false
      return Promise.all(
        kids.map(async (c): Promise<EpicChild> => {
          const assignees = (c.assignees ?? []).map(a => a.username)
          const open = c.state === 'opened'
          const mine = me !== null && assignees.includes(me)
          // Only an open child that is not yours is checked for what blocks
          // it, and only where issues can block others.
          const blockedBy =
            deps && open && !mine ? ((await links(c.iid, 'is_blocked_by')) ?? []).filter(b => b.state === 'opened').map(b => b.iid) : []
          return {
            number: c.iid,
            title: c.title,
            state: open ? 'open' : 'closed',
            assignees,
            mine,
            blocked: blockedBy.length > 0,
            labels: names(c).map(name => ({ name, color: colour.get(name) ?? '' })),
            milestone: c.milestone?.title ?? null,
            created: c.created_at ?? '',
            blockedBy,
          }
        }),
      )
    },

    // The issue, its latest notes, the merge requests that mention it and,
    // where issues can block others, its links, read in one go. Only the
    // issue itself must answer; each other part is left out when it fails.
    async issue(n: number, features: Features): Promise<IssueDetail> {
      const at = `${project}/issues/${n}`
      const [res, notes, merges, linked] = await Promise.all([
        get(at),
        fetchJson<RawNote[]>(`${at}/notes?sort=desc&order_by=created_at&per_page=20`),
        fetchJson<RawRef[]>(`${at}/related_merge_requests`),
        features.deps ? fetchJson<RawLink[]>(`${at}/links`) : null,
      ])
      const ours = Array.isArray(linked) ? linked.filter(l => inProject(l.web_url)) : null
      ours?.forEach(remember)
      const of = (kind: RawLink['link_type']) => ours?.filter(l => l.link_type === kind).map(toRef) ?? null
      if (!res.ok) throw new Error(`#${n}: HTTP ${res.status}`)
      const i = JSON.parse(res.text) as RawIssue
      remember(i)
      // Whether each open blocker is itself blocked by an open issue here,
      // one request each; one that does not answer counts as not blocked.
      const blockers = of('is_blocked_by')
      const blockedBy = blockers
        ? await Promise.all(
            blockers.map(async b =>
              b.state === 'open'
                ? { ...b, blocked: ((await links(b.number, 'is_blocked_by')) ?? []).some(l => l.state === 'opened') }
                : b,
            ),
          )
        : null
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
        blockedBy,
        blocks: of('blocks'),
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
// across the whole instance, which What's Next never shows.
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
type RawMilestone = { title: string; description?: string | null; web_url: string; due_date?: string | null; updated_at?: string }
type RawStatistics = { statistics?: { counts?: { all?: number; closed?: number } | null } | null }

// An issue linked to another, as GitLab lists the links: labels as plain
// names, and how it is linked. `blocks` and `is_blocked_by` only on EE.
type RawLink = {
  iid: number
  title: string
  state: string
  web_url: string
  labels?: string[] | null
  assignees?: RawUser[] | null
  milestone?: { title: string } | null
  created_at?: string
  author?: RawUser | null
  link_type: 'relates_to' | 'blocks' | 'is_blocked_by'
}
const names = (l: RawLink) => l.labels ?? []

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

// Whether issues can block others in each project, by its API URL: what
// check found, false until it did.
const depsByProject = new Map<string, boolean>()

// Each project's label colours, by its API URL, read once for the run.
const coloursByProject = new Map<string, Promise<Map<string, string>>>()

// The user ids seen on each host, by username: assigning takes ids.
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
