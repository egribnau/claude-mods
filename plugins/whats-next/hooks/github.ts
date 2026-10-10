import type { IssueDetail, IssueRow, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName } from './forge'
import { message, type Checked, type OpenIssue, type Send, type Tracker } from './tracker'

// GitHub behind the tracker the pane asks: every GitHub URL lives here.
// `token` is from the GitHub token setting, null when it has none for the
// host; `known`: the GitHub Enterprise version detection found, null for
// github.com or when it would not say.
// No blockers, epics or actions yet: check turns them off.
export function github(send: Send, r: Repo, token: string | null, known: string | null): Tracker {
  const slug = `${r.owner}/${r.name}`
  const dotCom = r.host.toLowerCase() === 'github.com'
  // github.com has an API host of its own; GitHub Enterprise answers under /api/v3.
  const base = dotCom ? 'https://api.github.com' : `https://${r.host}/api/v3`
  const api = `${base}/repos/${slug}`
  const headers = {
    Authorization: `Bearer ${token ?? ''}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const get = (url: string) => send(url, { method: 'GET', headers })

  // Every page of a list, 100 at a time, following the `next` link GitHub
  // gives in the Link header; a page that fails names `what`.
  async function fetchAll<T>(url: string, what: string): Promise<T[]> {
    const found: T[] = []
    let at: string | null = `${url}${url.includes('?') ? '&' : '?'}per_page=100`
    while (at) {
      const res = await get(at)
      if (!res.ok) throw new Error(`${what}: ${refusal(res)}`)
      found.push(...(JSON.parse(res.text) as T[]))
      at = nextLink(res.headers.link)
    }
    return found
  }

  // Who the token belongs to: from check, else asked.
  async function login(): Promise<string> {
    const seen = loginByToken.get(token ?? '')
    if (seen !== undefined) return seen
    const res = await get(`${base}/user`)
    if (!res.ok) throw new Error(`/user: ${refusal(res)}`)
    const me = (JSON.parse(res.text) as { login: string }).login
    loginByToken.set(token ?? '', me)
    return me
  }

  // Each step in turn, stopping at the first that fails: a token, who it
  // belongs to, the token reading the repo, and the token reading its issues,
  // which a fine-grained token needs the Issues permission for.
  async function check(): Promise<Checked> {
    const version = forgeName({ kind: 'github', version: known })
    const done = (setup: Setup): Checked => ({ version, setup })
    if (!token) return done({ kind: 'no-token' })

    try {
      const user = await get(`${base}/user`)
      if (user.status === 401) return done({ kind: 'token-refused' })
      if (!user.ok) return done({ kind: 'error', message: `/user: ${refusal(user)}` })
      const me = (JSON.parse(user.text) as { login: string }).login
      loginByToken.set(token, me)

      // A private repo the token may not see answers 404, as one that is not there.
      const res = await get(api)
      if (res.status === 401) return done({ kind: 'token-refused' })
      if (res.status === 404) return done({ kind: 'not-found' })
      if (!res.ok) return done(res.status === 403 && !limited(res) ? { kind: 'no-scope' } : { kind: 'error', message: `${slug}: ${refusal(res)}` })
      const repo = JSON.parse(res.text) as RawRepo
      if (repo.has_issues === false) return done({ kind: 'error', message: `${slug} has its issues turned off` })

      // The repo's count includes pull requests: the search counts issues
      // only, and its refusal says the token may not read them.
      const q = encodeURIComponent(`repo:${slug} is:issue is:open`)
      const [issues, counted] = await Promise.all([
        get(`${api}/issues?state=open&per_page=1`),
        get(`${base}/search/issues?q=${q}&per_page=1`).catch(() => null),
      ])
      if (issues.status === 403 && !limited(issues)) return done({ kind: 'no-scope', missing: 'Issues' })
      if (!issues.ok) return done({ kind: 'error', message: `issues: ${refusal(issues)}` })
      let total: number | undefined
      try {
        total = counted?.ok ? (JSON.parse(counted.text) as { total_count?: number }).total_count : undefined
      } catch {
        total = undefined
      }
      return done({
        kind: 'ready',
        openIssues: total ?? repo.open_issues_count ?? 0,
        login: me,
        actions: { kind: 'read-only', reason: 'later' },
        features: { time: false, deps: false, epics: false },
      })
    } catch (err) {
      return done({ kind: 'error', message: message(err) })
    }
  }

  return {
    check,
    name: 'GitHub',
    tokensUrl: `https://${r.host}/settings/personal-access-tokens`,
    scopes: 'Issues read and write, or read for read only; a classic token needs repo',
    writeScope: 'Issues read and write',
    setting: 'GitHub token',

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${api}/milestones?state=open`, 'milestones').catch(() => [])
      return raw.map(m => ({ title: m.title, due: m.due_on ?? null, closed: m.closed_issues, total: m.open_issues + m.closed_issues }))
    },

    async mine(): Promise<IssueRow[]> {
      const me = await login()
      const found = await fetchAll<RawIssue>(`${api}/issues?state=open&assignee=${encodeURIComponent(me)}`, 'your issues')
      return found.filter(isIssue).map(toRow)
    },

    async open(): Promise<OpenIssue[]> {
      const found = await fetchAll<RawIssue>(`${api}/issues?state=open`, 'open issues')
      return found.filter(isIssue).map(i => ({ ...toRow(i), assignees: (i.assignees ?? []).map(a => a.login) }))
    },

    // Turned off by check: never asked.
    epics: async () => [],
    blockers: async () => null,
    children: async () => null,

    // The issue itself, for the detail view.
    async issue(n: number): Promise<IssueDetail> {
      const res = await get(`${api}/issues/${n}`)
      if (!res.ok) throw new Error(`#${n}: ${refusal(res)}`)
      const i = JSON.parse(res.text) as RawIssue
      return {
        ...toRow(i),
        state: i.state,
        author: i.user?.login ?? 'someone',
        updated: i.updated_at,
        comments: i.comments ?? 0,
        milestone: i.milestone ? { title: i.milestone.title, due: i.milestone.due_on ?? null } : null,
        due: null,
        branch: null,
        logged: null,
        estimate: null,
        assignees: (i.assignees ?? []).map(a => a.login),
        blockedBy: null,
        blocks: null,
        pulls: null,
        commits: null,
        lastComment: null,
      }
    },

    assign: async () => "What's Next cannot assign GitHub issues yet",
    close: async () => "What's Next cannot close GitHub issues yet",
  }
}

// The URL of the next page from a Link header, or null on the last page.
export function nextLink(link: string | undefined): string | null {
  for (const part of (link ?? '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (m?.[1]) return m[1]
  }
  return null
}

// Whether a refusal is GitHub's rate limit rather than the token's rights.
const limited = (res: { headers: Record<string, string> }) => res.headers['x-ratelimit-remaining'] === '0'

// Why GitHub refused a request: its rate limit, its `message`, else the status.
function refusal(res: { status: number; text: string; headers: Record<string, string> }): string {
  if (limited(res)) {
    const reset = Number(res.headers['x-ratelimit-reset'])
    const at = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ''
    return `GitHub's rate limit is used up${at}`
  }
  try {
    const m = (JSON.parse(res.text) as { message?: unknown }).message
    if (typeof m === 'string' && m) return `HTTP ${res.status}, ${m}`
  } catch {
    // The status says enough.
  }
  return `HTTP ${res.status}`
}

// Who each token belongs to, from check: your issues are asked by login.
const loginByToken = new Map<string, string>()

// The repo as check reads it. `open_issues_count` counts pull requests too.
type RawRepo = { has_issues?: boolean; open_issues_count?: number }

type RawMilestone = { title: string; due_on?: string | null; open_issues: number; closed_issues: number }

// An issue as GitHub lists it. Pull requests are in the same lists, marked
// by `pull_request`.
type RawIssue = {
  number: number
  title: string
  state: string
  html_url: string
  body: string | null
  user?: { login: string } | null
  created_at: string
  updated_at: string
  comments?: number
  milestone: { title: string; due_on?: string | null } | null
  labels?: ({ name: string; color?: string | null } | string)[] | null
  assignees?: { login: string }[] | null
  pull_request?: unknown
}

const isIssue = (i: RawIssue) => i.pull_request === undefined

const toRow = (i: RawIssue): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: (i.labels ?? []).map(l => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: l.color ?? '' })),
  created: i.created_at,
  url: i.html_url,
  body: i.body ?? '',
})
