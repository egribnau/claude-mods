import type { IssueDetail, IssueRow, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName } from './forge'
import { message, type Checked, type EpicRow, type OpenIssue, type Send, type Tracker } from './tracker'

// GitLab behind the tracker the pane asks: every GitLab URL lives here.
// `token` is from the GitLab tokens setting, null when it has none for the
// host; `known`: the version detection found, null when it would not say.
// What's next only for now: no blockers, epics, time, assign or close.
export function gitlab(send: Send, r: Repo, token: string | null, known: string | null): Tracker {
  const slug = `${r.owner}/${r.name}`
  const base = `https://${r.host}/api/v4`
  // The owner may be a group path with slashes: GitLab takes the whole path
  // as one encoded id.
  const project = `${base}/projects/${encodeURIComponent(slug)}`
  const headers = { 'PRIVATE-TOKEN': token ?? '', Accept: 'application/json' }
  const get = (url: string) => send(url, { method: 'GET', headers })

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
  // reading the project.
  async function check(): Promise<Checked> {
    const version = forgeName({ kind: 'gitlab', version: known })
    const done = (setup: Setup): Checked => ({ version, setup })
    if (!token) return done({ kind: 'no-token' })
    const noScope: Setup = { kind: 'no-scope', missing: 'read_api' }

    try {
      // An older GitLab does not know this endpoint: its scopes stay unknown.
      const self = await get(`${base}/personal_access_tokens/self`)
      if (self.status === 401) return done({ kind: 'token-refused' })
      if (self.ok) {
        const scopes = (JSON.parse(self.text) as { scopes?: string[] }).scopes ?? []
        if (!scopes.includes('api') && !scopes.includes('read_api')) return done(noScope)
      }

      const user = await get(`${base}/user`)
      if (user.status === 401) return done({ kind: 'token-refused' })
      if (user.status === 403) return done(noScope)
      if (!user.ok) return done({ kind: 'error', message: `/user: HTTP ${user.status}` })
      const login = (JSON.parse(user.text) as { username: string }).username

      const res = await get(project)
      if (res.status === 401) return done({ kind: 'token-refused' })
      if (res.status === 403) return done({ kind: 'no-scope' })
      if (res.status === 404) return done({ kind: 'not-found' })
      if (!res.ok) return done({ kind: 'error', message: `${slug}: HTTP ${res.status}` })
      const repo = JSON.parse(res.text) as { open_issues_count?: number }
      return done({
        kind: 'ready',
        openIssues: repo.open_issues_count ?? 0,
        login,
        actions: { kind: 'read-only', reason: 'later' },
        features: { time: false, deps: false, epics: false },
      })
    } catch (err) {
      return done({ kind: 'error', message: message(err) })
    }
  }

  const cannot = async () => 'fj cannot change GitLab issues yet.'

  return {
    check,
    name: 'GitLab',
    tokensUrl: `https://${r.host}/-/user_settings/personal_access_tokens`,
    scopes: 'read_api',
    setting: 'GitLab tokens',

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${project}/milestones?state=active&include_ancestors=true`, 'milestones').catch(() => [])
      return raw.map(m => ({ title: m.title, due: m.due_date ?? null, closed: 0, total: 0 }))
    },

    async mine(): Promise<IssueRow[]> {
      const found = await fetchAll<RawIssue>(`${project}/issues?state=opened&scope=assigned_to_me&with_labels_details=true`, 'your issues')
      return found.map(toRow)
    },

    async open(): Promise<OpenIssue[]> {
      const found = await fetchAll<RawIssue>(`${project}/issues?state=opened&with_labels_details=true`, 'open issues')
      return found.map(i => ({ ...toRow(i), assignees: (i.assignees ?? []).map(a => a.username) }))
    },

    epics: async (): Promise<EpicRow[]> => [],
    blockers: async () => null,
    children: async () => null,

    // Only the issue itself for now: its links, time and comments are later.
    async issue(n: number): Promise<IssueDetail> {
      const res = await get(`${project}/issues/${n}`)
      if (!res.ok) throw new Error(`#${n}: HTTP ${res.status}`)
      const i = JSON.parse(res.text) as RawIssue
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
        logged: null,
        labels: labels(i),
        assignees: (i.assignees ?? []).map(a => a.username),
        blockedBy: null,
        blocks: null,
        pulls: null,
        commits: null,
        lastComment: null,
      }
    },

    assign: cannot,
    close: cannot,
  }
}

// An issue as GitLab lists it: `iid` is its number in the project, `id` one
// across the whole instance, which fj never shows.
type RawIssue = {
  iid: number
  title: string
  state: string
  web_url: string
  description: string | null
  author?: { username: string } | null
  created_at: string
  updated_at: string
  user_notes_count?: number
  milestone: { title: string; due_date?: string | null } | null
  due_date?: string | null
  // Objects with with_labels_details, else plain names.
  labels?: ({ name: string; color?: string } | string)[] | null
  assignees?: { username: string }[] | null
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
