import type { CommitRef, IssueDetail, Ref } from '../types'

// What one GET answered: its status and, when it was ok, its parsed body.
export type Got = { ok: boolean; status: number; json: unknown }
export type Get = (path: string) => Promise<Got | null>

type RawUser = { login: string } | null
type RawRef = {
  number: number
  title: string
  state: string
  pull_request?: { merged?: boolean } | null
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
export async function loadIssue(get: Get, n: number): Promise<IssueDetail> {
  const at = `/issues/${n}`
  const [main, comments, deps, blocks, timeline, times] = await Promise.all([
    get(at),
    get(`${at}/comments`),
    get(`${at}/dependencies`),
    get(`${at}/blocks`),
    get(`${at}/timeline`),
    get(`${at}/times`),
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
    labels: (i.labels ?? []).map(l => ({ name: l.name, color: l.color })),
    assignees: (i.assignees ?? []).map(a => a.login),
    blockedBy: list<RawRef>(deps)?.map(ref) ?? null,
    blocks: list<RawRef>(blocks)?.map(ref) ?? null,
    pulls,
    commits,
    lastComment: last ? { author: last.user?.login ?? 'someone', when: last.created_at, body: last.body ?? '' } : null,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A date as a day and month: 14 Oct. Another year adds it: 14 Oct 2025.
export function day(iso: string, now: number): string {
  const d = new Date(iso)
  const year = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`
}

// A due date and how far off it is, and whether it has passed.
export function dueText(iso: string, now: number): { text: string; passed: boolean } {
  const days = Math.round((Date.parse(iso) - now) / 86400000)
  const when =
    days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : days === -1 ? 'yesterday' : `${-days} days ago`
  return { text: `${day(iso, now)}, ${when}`, passed: days < 0 }
}

// Seconds as hours and minutes: 1h 20m, 45m.
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

// A label's `rrggbb` colour as text on a dark terminal: as Forgejo has it,
// made lighter when it is too dark to read; undefined for no colour.
export function readable(color: string): string | undefined {
  const hex = color.replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined
  let [r, g, b] = [0, 2, 4].map(k => Number.parseInt(hex.slice(k, k + 2), 16)) as [number, number, number]
  // Toward white a fifth at a time, so the hue stays.
  while (0.299 * r + 0.587 * g + 0.114 * b < 110) [r, g, b] = [r, g, b].map(v => v + (255 - v) * 0.2) as [number, number, number]
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

// `text` broken into lines of at most `width` characters, at spaces where
// it can; blank lines are kept.
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  if (width <= 0) return out
  for (const line of text.replace(/\r/g, '').split('\n')) {
    let rest = line.trimEnd()
    if (rest === '') {
      out.push('')
      continue
    }
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > 0 ? cut : width
      out.push(rest.slice(0, at))
      rest = rest.slice(at).trimStart()
    }
    out.push(rest)
  }
  return out
}
