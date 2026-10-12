import type { Actions, CommitRef, EpicChild, Features, IssueDetail, IssueRow, Ref, Repo, Setup } from '../types'
import type { MilestoneRow } from './epics'
import { forgeName } from './forge'
import { message, type Checked, type Closed, type EpicRow, type OpenIssue, type Send, type Tracker } from './tracker'

// GitHub behind the tracker the pane asks: every GitHub URL lives here.
// `token` is from the GitHub token setting, null when it has none for the
// host; `known`: the GitHub Enterprise version detection found, null for
// github.com or when it would not say; `label` is the Epic label setting.
// Blockers are GitHub's own "blocked by" relations. An epic is an issue with
// the Epic label; its children are its sub-issues.
export function github(send: Send, r: Repo, token: string | null, known: string | null, label = 'epic'): Tracker {
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
  // Where this repo's issues live: links may reach into other repos.
  const here = `https://${r.host}/${slug}/issues/`.toLowerCase()

  // Every page of a list, 100 at a time, following the `next` link GitHub
  // gives in the Link header; a page that fails names `what`. The token goes
  // only to the API's own host: a link anywhere else fails the list.
  async function fetchAll<T>(url: string, what: string): Promise<T[]> {
    const found: T[] = []
    let at: string | null = `${url}${url.includes('?') ? '&' : '?'}per_page=100`
    while (at) {
      const res = await get(at)
      if (!res.ok) throw new Error(`${what}: ${refusal(res)}`)
      found.push(...(JSON.parse(res.text) as T[]))
      at = nextLink(res.headers.link)
      if (at !== null && !at.startsWith(`${base}/`)) throw new Error(`${what}: the next page is not on ${new URL(base).host}`)
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

  // A change to issue `n`: null when GitHub took it, else why not.
  const patch = (n: number, body: object) => patchAt(`${api}/issues/${n}`, body)

  // A change at `url`: null when GitHub took it, else why not.
  async function patchAt(url: string, body: object): Promise<string | null> {
    const res = await send(url, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err: unknown) => message(err))
    if (typeof res === 'string') return res
    return res.ok ? null : refusal(res)
  }

  // The issues issue `n` is blocked by, or blocks, in this repo; null when
  // GitHub would not say.
  async function dependencies(n: number, kind: 'blocked_by' | 'blocking'): Promise<RawDependency[] | null> {
    const raw = await fetchAll<RawDependency>(`${api}/issues/${n}/dependencies/${kind}`, kind).catch(() => null)
    return raw ? raw.filter(d => d.repository?.full_name === undefined || d.repository.full_name.toLowerCase() === slug.toLowerCase()) : null
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
      // A classic token lists its scopes in this header; a fine-grained one
      // has none, and GitHub does not say what it may do.
      const scopes = user.headers['x-oauth-scopes']

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
        get(`${api}/issues?state=open&per_page=20`),
        get(`${base}/search/issues?q=${q}&per_page=1`).catch(() => null),
      ])
      if (issues.status === 403 && !limited(issues)) return done({ kind: 'no-scope', missing: 'Issues' })
      if (!issues.ok) return done({ kind: 'error', message: `issues: ${refusal(issues)}` })
      // Issues can block others where GitHub lists their dependencies with
      // them. Pull requests come without, so the first issue that is none
      // tells; with no such issue, github.com has them, an Enterprise server
      // may not.
      let probe: RawIssue[] = []
      try {
        probe = JSON.parse(issues.text) as RawIssue[]
      } catch {
        probe = []
      }
      const first = probe.find(isIssue)
      const deps = first ? 'issue_dependencies_summary' in first : dotCom
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
        actions: mayAct(repo, scopes),
        features: { time: false, deps, epics: true },
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
    // Only a classic token's scopes are known, so only its lack is named.
    writeScope: 'repo',
    setting: 'GitHub token',

    async milestones(): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${api}/milestones?state=open`, 'milestones').catch(() => [])
      return raw.map(toMilestone)
    },

    // GitHub does not sort milestones by when they closed: all are read.
    async closedMilestones(n: number): Promise<MilestoneRow[]> {
      const raw = await fetchAll<RawMilestone>(`${api}/milestones?state=closed`, 'closed milestones').catch(() => [])
      return raw
        .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
        .slice(0, n)
        .map(toMilestone)
    },

    async mine(): Promise<IssueRow[]> {
      const me = await login()
      const found = await fetchAll<RawIssue>(`${api}/issues?state=open&assignee=${encodeURIComponent(me)}`, 'your issues')
      return found.filter(isIssue).map(toRow)
    },

    // How many open issues block each one is kept, so blockers asks only
    // for the ones that are blocked.
    async open(): Promise<OpenIssue[]> {
      const found = await fetchAll<RawIssue>(`${api}/issues?state=open`, 'open issues')
      const counts = new Map<number, number>()
      for (const i of found) if (i.issue_dependencies_summary) counts.set(i.number, i.issue_dependencies_summary.blocked_by ?? 0)
      blockedByRepo.set(api, counts)
      // How many open issues wait on each comes with it too.
      return found.filter(isIssue).map(i => ({
        ...toRow(i),
        ...(i.issue_dependencies_summary?.blocking !== undefined && { unblocks: i.issue_dependencies_summary.blocking }),
        assignees: (i.assignees ?? []).map(a => a.login),
      }))
    },

    // GitHub matches labels without regard to case; so does What's Next.
    async epics(): Promise<EpicRow[]> {
      const found = await fetchAll<RawIssue>(`${api}/issues?state=all&labels=${encodeURIComponent(label)}`, 'epics')
      return found
        .filter(i => isIssue(i) && labelNames(i).some(l => l.toLowerCase() === label.toLowerCase()))
        .map(i => ({
          number: i.number,
          title: i.title,
          state: i.state === 'closed' ? 'closed' : 'open',
          milestone: i.milestone?.title ?? null,
          due: null,
          assignees: (i.assignees ?? []).map(a => a.login),
        }))
    },

    async members(n: number): Promise<number[] | null> {
      const raw = await fetchAll<RawIssue>(`${api}/issues/${n}/sub_issues`, 'sub-issues').catch(() => null)
      return raw ? raw.filter(c => c.html_url.toLowerCase().startsWith(here)).map(c => c.number) : null
    },

    // Its parent issue, open and in this repo, label or not.
    async parentOf(n: number): Promise<number | null> {
      const raw = await fetchJson<RawIssue>(`${api}/issues/${n}/parent`)
      return raw && raw.state !== 'closed' && raw.html_url.toLowerCase().startsWith(here) ? raw.number : null
    },

    nested: true,

    // GitHub filters by a milestone's number, or none; sorted by the last
    // change, the latest closed of the first page is taken. Pull requests
    // are in the same list and left out.
    async lastClosed(within, me): Promise<Closed | null> {
      const milestone = typeof within === 'object' ? `&milestone=${within.id}` : within === 'none' ? '&milestone=none' : ''
      const raw = await fetchJson<RawIssue[]>(
        `${api}/issues?state=closed&assignee=${encodeURIComponent(me)}&sort=updated&direction=desc&per_page=20${milestone}`,
      )
      const last = (raw ?? [])
        .filter(i => isIssue(i) && i.closed_at)
        .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))[0]
      return last ? { number: last.number, title: last.title, closed: last.closed_at ?? '', milestone: last.milestone?.title ?? null } : null
    },

    // An issue's children are its sub-issues in this repo, an epic's or any
    // other's, each with how many sub-issues it has itself. Each open one not
    // assigned to `me` is checked for what blocks it, with a request only
    // when it says open issues block it.
    async children(n: number, me: string | null): Promise<EpicChild[] | null> {
      const raw = await fetchAll<RawIssue>(`${api}/issues/${n}/sub_issues`, 'sub-issues').catch(() => null)
      if (!raw) return null
      return Promise.all(
        raw
          .filter(c => c.html_url.toLowerCase().startsWith(here))
          .map(async (c): Promise<EpicChild> => {
            const assignees = (c.assignees ?? []).map(a => a.login)
            const open = c.state !== 'closed'
            const mine = me !== null && assignees.includes(me)
            const blockedBy =
              open && !mine && (c.issue_dependencies_summary?.blocked_by ?? 0) > 0
                ? ((await dependencies(c.number, 'blocked_by')) ?? []).filter(d => d.state === 'open').map(d => d.number)
                : []
            const row = toRow(c)
            return {
              number: c.number,
              title: c.title,
              state: open ? 'open' : 'closed',
              assignees,
              mine,
              blocked: blockedBy.length > 0,
              labels: row.labels,
              milestone: row.milestone,
              created: row.created,
              due: null,
              blockedBy,
              // Its own count, for the tree, without asking for its sub-issues.
              ...(c.sub_issues_summary && { subIssues: { closed: c.sub_issues_summary.completed, total: c.sub_issues_summary.total } }),
            }
          }),
      )
    },

    // No request for an issue the open issues said nothing blocks. Blockers
    // in other repos are left out: What's Next shows this repo's numbers.
    async blockers(n: number): Promise<number[] | null> {
      if (blockedByRepo.get(api)?.get(n) === 0) return []
      const raw = await dependencies(n, 'blocked_by')
      return raw ? raw.filter(d => d.state === 'open').map(d => d.number) : null
    },

    // The issue and its timeline, read in one go: the comments, the pull
    // requests that mention it and the commits that refer to it come from the
    // timeline. Only the issue itself must answer; the rest is left out when
    // the timeline fails. Commits carry no message there: the newest three,
    // which the detail view shows, are asked for theirs.
    async issue(n: number, features: Features): Promise<IssueDetail> {
      const at = `${api}/issues/${n}`
      const [res, timeline, blockedBy, blocking] = await Promise.all([
        get(at),
        fetchAll<RawEvent>(`${at}/timeline`, 'timeline').catch(() => null),
        features.deps ? dependencies(n, 'blocked_by') : null,
        features.deps ? dependencies(n, 'blocking') : null,
      ])
      if (!res.ok) throw new Error(`#${n}: ${refusal(res)}`)
      const i = JSON.parse(res.text) as RawIssue
      const said = timeline?.filter(e => e.event === 'commented') ?? null
      const pulls: Ref[] | null = timeline
        ? timeline
            .flatMap(e => (e.event === 'cross-referenced' && e.source?.issue?.pull_request ? [e.source.issue] : []))
            .filter(p => p.repository?.full_name === undefined || p.repository.full_name.toLowerCase() === slug.toLowerCase())
            .filter((p, k, all) => all.findIndex(q => q.number === p.number) === k)
            .map(p => ({ number: p.number, title: p.title, state: p.pull_request?.merged_at ? 'merged' : p.state }))
        : null
      const shas = timeline
        ? timeline
            .flatMap(e => (e.event === 'referenced' && e.commit_id ? [{ sha: e.commit_id, when: e.created_at }] : []))
            .filter((c, k, all) => all.findIndex(d => d.sha === c.sha) === k)
            .reverse()
        : null
      // Whether an open issue it names is itself blocked by an open issue:
      // from the count GitHub gives with it, else one request each; one that
      // does not answer counts as not blocked. What it blocks waits on it
      // while it is open: no need to ask.
      const withBlocked = (all: RawDependency[] | null, waits: boolean) =>
        all
          ? Promise.all(
              all.map(async d => {
                if (d.state !== 'open') return toRef(d)
                if (waits) return { ...toRef(d), blocked: true }
                const count = d.issue_dependencies_summary?.blocked_by
                const theirs = count === undefined ? ((await dependencies(d.number, 'blocked_by')) ?? []).filter(x => x.state === 'open').length : count
                return { ...toRef(d), blocked: theirs > 0 }
              }),
            )
          : null
      const [blockers, blocks] = await Promise.all([withBlocked(blockedBy, false), withBlocked(blocking, i.state === 'open')])
      const commits: CommitRef[] | null = shas
        ? await Promise.all(
            shas.slice(0, 3).map(async c => {
              const found = await fetchJson<{ commit?: { message?: string } }>(`${api}/commits/${c.sha}`)
              return { sha: c.sha.slice(0, 7), message: (found?.commit?.message ?? '').split('\n')[0]?.trim() ?? '', when: c.when }
            }),
          )
        : null
      return {
        ...toRow(i),
        state: i.state,
        author: i.user?.login ?? 'someone',
        updated: i.updated_at,
        comments: i.comments ?? 0,
        milestone: i.milestone ? { title: i.milestone.title, due: i.milestone.due_on ?? null } : null,
        due: null,
        branch: null,
        // GitHub tracks no time.
        logged: null,
        estimate: null,
        assignees: (i.assignees ?? []).map(a => a.login),
        blockedBy: blockers,
        blocks,
        pulls,
        commits,
        commentList: said ? said.map(c => ({ author: c.actor?.login ?? c.user?.login ?? 'someone', when: c.created_at, body: c.body ?? '' })) : null,
      }
    },

    // GitHub takes the whole list of assignees, and leaves out silently
    // whoever may not be assigned.
    assign: (n, assignees) => patch(n, { assignees }),
    close: (n, closed) => patch(n, { state: closed ? 'closed' : 'open' }),
    closeMilestone: (m, closed) => patchAt(`${api}/milestones/${m.id}`, { state: closed ? 'closed' : 'open' }),
  }
}

// Whether What's Next may assign and close: push rights on the repo, and
// for a classic token `repo` (or `public_repo` on a public repo). A
// fine-grained token's permissions are not listed: with push rights the
// buttons show and GitHub has the last word.
function mayAct(repo: RawRepo, scopes: string | undefined): Actions {
  if (repo.permissions?.push !== true) return { kind: 'read-only', reason: 'push' }
  if (scopes === undefined) return { kind: 'unknown' }
  const list = scopes.split(',').map(sc => sc.trim())
  return list.includes('repo') || (repo.private === false && list.includes('public_repo')) ? { kind: 'ok' } : { kind: 'read-only', reason: 'scope' }
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
type RawRepo = { has_issues?: boolean; open_issues_count?: number; private?: boolean; permissions?: { push?: boolean } }

type RawMilestone = {
  number: number
  title: string
  description?: string | null
  html_url: string
  due_on?: string | null
  open_issues: number
  closed_issues: number
  closed_at?: string | null
}

const toMilestone = (m: RawMilestone): MilestoneRow => ({
  title: m.title,
  due: m.due_on ?? null,
  closed: m.closed_issues,
  total: m.open_issues + m.closed_issues,
  description: m.description ?? '',
  url: m.html_url,
  closedAt: m.closed_at ?? null,
  id: m.number,
})

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
  closed_at?: string | null
  comments?: number
  milestone: { title: string; due_on?: string | null } | null
  labels?: ({ name: string; color?: string | null } | string)[] | null
  assignees?: { login: string }[] | null
  pull_request?: unknown
  // How many open issues block it (`blocked_by`), and how many it blocks
  // (`blocking`), where GitHub has dependencies.
  issue_dependencies_summary?: { blocked_by?: number; blocking?: number } | null
  // How many sub-issues it has, closed (`completed`) and in all, in any repo.
  sub_issues_summary?: { total: number; completed: number } | null
}

// An issue that blocks another, or is blocked by it.
type RawDependency = {
  number: number
  title: string
  state: string
  repository?: { full_name: string }
  issue_dependencies_summary?: { blocked_by?: number } | null
  assignees?: { login: string }[] | null
}
const toRef = (d: RawDependency): Ref => ({ number: d.number, title: d.title, state: d.state, assignees: (d.assignees ?? []).map(a => a.login) })

// How many open issues block each open issue, by the repo's API URL, from
// the last list of open issues.
const blockedByRepo = new Map<string, Map<number, number>>()

const isIssue = (i: RawIssue) => i.pull_request === undefined

const labelNames = (i: RawIssue) => (i.labels ?? []).map(l => (typeof l === 'string' ? l : l.name))

const toRow = (i: RawIssue): IssueRow => ({
  number: i.number,
  title: i.title,
  milestone: i.milestone?.title ?? null,
  labels: (i.labels ?? []).map(l => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: l.color ?? '' })),
  created: i.created_at,
  due: null,
  url: i.html_url,
  body: i.body ?? '',
  updated: i.updated_at ?? i.created_at,
})

// One event on an issue's timeline: a comment, another issue or pull
// request mentioning it (`source`), a commit referring to it (`commit_id`),
// and more What's Next does not show.
type RawEvent = {
  event: string
  created_at: string
  actor?: { login: string } | null
  user?: { login: string } | null
  body?: string | null
  commit_id?: string | null
  source?: {
    issue?: {
      number: number
      title: string
      state: string
      pull_request?: { merged_at?: string | null } | null
      repository?: { full_name: string }
    }
  } | null
}
