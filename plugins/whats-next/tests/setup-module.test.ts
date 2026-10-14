import { expect, test } from 'claude-code/testing'

import type { Forge } from '../hooks/forge'
import { anyToken, checkForge, findRepo, parseRemote, readToken, trackerFor, type Tokens } from '../hooks/setup'
import type { Send } from '../hooks/tracker'

// Setup's steps and which token a host gets, on the module, with no pane.

const NONE: Tokens = { 'Forgejo tokens': '', 'GitLab.com token': '', 'Private GitLab token': '', 'GitHub token': '' }
const R = { host: 'git.example.org', owner: 'boats', name: 'radar' }
const folder = async () => ({ inRepo: true, dir: '~/dev/radar' })

type Reply = { status: number; text: string; headers?: Record<string, string> }
const reply = (status: number, body: unknown): Reply => ({ status, text: JSON.stringify(body) })

// A fetch that answers by path and records each request's URL and headers.
function forge(answers: Record<string, Reply>) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const send: Send = async (url, init) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const path = Object.keys(answers).find(p => url.includes(p))
    const r: Reply = (path ? answers[path] : undefined) ?? reply(404, {})
    return { status: r.status, ok: r.status < 300, headers: r.headers ?? {}, text: r.text } as Awaited<ReturnType<Send>>
  }
  return { send, seen }
}

// parseRemote

test('parseRemote: names the host, owner and repo in every form git takes', () => {
  const want = { host: 'git.example.org', owner: 'boats', name: 'radar' }
  expect(parseRemote('ssh://git@git.example.org:2222/boats/radar.git')).toEqual(want)
  expect(parseRemote('git@git.example.org:boats/radar.git')).toEqual(want)
  expect(parseRemote('https://git.example.org/boats/radar')).toEqual(want)
  expect(parseRemote('https://git.example.org/a/b/radar/')).toEqual({ host: 'git.example.org', owner: 'a/b', name: 'radar' })
  expect(parseRemote('not a remote')).toBeNull()
})

// Step Repo

test('findRepo: the repo behind origin, and no question asked about the folder', async () => {
  let asked = false
  const found = await findRepo('git@git.example.org:boats/radar.git', async () => {
    asked = true
    return { inRepo: true, dir: '~' }
  })
  expect(found).toEqual({ repo: R, setup: null })
  expect(asked).toBe(false)
})

test('findRepo: outside a git repo, with no origin, and with an origin that names no host', async () => {
  expect(await findRepo(null, async () => ({ inRepo: false, dir: '~/dev' }))).toEqual({
    repo: null,
    setup: { kind: 'no-repo', reason: 'not-git', dir: '~/dev' },
  })
  expect(await findRepo(null, folder)).toEqual({ repo: null, setup: { kind: 'no-repo', reason: 'no-origin', dir: '~/dev/radar' } })
  expect(await findRepo('https://alice:s3cret@/nowhere', folder)).toEqual({
    repo: null,
    setup: { kind: 'no-repo', reason: 'bad-origin', dir: '~/dev/radar', origin: 'https:///nowhere' },
  })
})

// Which token a host gets

test('readToken: a pair for the host wins, and says it was one', () => {
  const tokens = { ...NONE, 'Forgejo tokens': 'bare git.example.org=pair' }
  expect(readToken(tokens, 'Forgejo tokens', 'git.example.org')).toEqual({ value: 'pair', from: { setting: 'Forgejo tokens', host: 'git.example.org' } })
  expect(readToken(tokens, 'Forgejo tokens', 'other.example.org')).toEqual({ value: 'bare', from: { setting: 'Forgejo tokens', host: null } })
  expect(readToken(NONE, 'GitHub token', 'github.com')).toEqual({ value: null, from: null })
})

test("a GitLab host's token: gitlab.com its own setting or an old pair, never the private bare token", async () => {
  const gitlab: Forge = { kind: 'gitlab', version: null }
  // What the tracker sends is shown by the requests of its check.
  async function sent(tokens: Tokens, host: string) {
    const { send, seen } = forge({ '/user': reply(401, { message: 'no' }) })
    await trackerFor(send, { ...R, host }, gitlab, tokens, 'epic').check()
    return seen.map(s => s.headers['PRIVATE-TOKEN']).find(Boolean) ?? null
  }
  expect(await sent({ ...NONE, 'GitLab.com token': 'com' }, 'gitlab.com')).toBe('com')
  expect(await sent({ ...NONE, 'Private GitLab token': 'gitlab.com=old' }, 'gitlab.com')).toBe('old')
  expect(await sent({ ...NONE, 'Private GitLab token': 'bare' }, 'gitlab.com')).toBeNull()
  expect(await sent({ ...NONE, 'Private GitLab token': 'bare', 'GitLab.com token': 'com' }, 'git.example.org')).toBe('bare')
  expect(await sent({ ...NONE, 'GitLab.com token': 'com' }, 'git.example.org')).toBeNull()
})

test('trackerFor: with no forge found the Forgejo tracker gets no token', async () => {
  const { send, seen } = forge({})
  const tokens = { ...NONE, 'Forgejo tokens': 'forgejo-token', 'GitHub token': 'github-token' }
  const t = trackerFor(send, R, undefined, tokens, 'epic')
  expect(t.name).toBe('Forgejo')
  await t.check()
  expect(seen.length).toBeGreaterThan(0)
  expect(JSON.stringify(seen)).not.toContain('-token')
})

// Steps Forge, Token, Access and Actions

test('checkForge: a host that answers as nothing known has no tracker and no token', async () => {
  const { send } = forge({ '/api/v1/version': reply(404, {}) })
  const found = await checkForge(send, R, { ...NONE, 'Forgejo tokens': 'secret' }, 'epic')
  expect(found.forge.kind).toBe('unknown')
  expect(found.token).toBeNull()
  expect(found.tracker).toBeNull()
  expect(found.setup).toMatchObject({ kind: 'not-forgejo', reason: 'other' })
})

test('checkForge: Forgejo with no token stops at the Token step', async () => {
  const { send } = forge({ '/api/v1/version': reply(200, { version: '12.0.1+gitea-1.22.0' }) })
  const found = await checkForge(send, R, NONE, 'epic')
  expect(found.forge).toEqual({ kind: 'forgejo', version: '12.0.1+gitea-1.22.0' })
  expect(found.setup).toEqual({ kind: 'no-token' })
  expect(found.token).toBeNull()
})

test('checkForge: the token of the forge found goes to that host, and says where it came from', async () => {
  const { send, seen } = forge({ '/api/v1/version': reply(200, { version: '12.0.1+gitea-1.22.0' }), '/user': reply(401, {}) })
  const tokens = { ...NONE, 'Forgejo tokens': 'git.example.org=secret', 'GitHub token': 'other' }
  const found = await checkForge(send, R, tokens, 'epic')
  expect(found.token).toEqual({ setting: 'Forgejo tokens', host: 'git.example.org' })
  expect(found.tracker?.name).toBe('Forgejo')
  const authed = seen.filter(s => JSON.stringify(s.headers).includes('secret'))
  expect(authed.length).toBeGreaterThan(0)
  expect(authed.every(s => s.url.startsWith('https://git.example.org/'))).toBe(true)
  expect(JSON.stringify(seen)).not.toContain('other')
})

test('checkForge: a known host is GitHub, with the GitHub token', async () => {
  const { send } = forge({})
  const found = await checkForge(send, { host: 'github.com', owner: 'boats', name: 'radar' }, { ...NONE, 'GitHub token': 'ghp_x' }, 'epic')
  expect(found.forge).toEqual({ kind: 'github', version: null })
  expect(found.token).toEqual({ setting: 'GitHub token', host: null })
  expect(found.tracker?.name).toBe('GitHub')
})

test('anyToken: the first token setting that has one, with no host; null when none has', () => {
  expect(anyToken({ ...NONE, 'GitHub token': 'ghp_x' })).toEqual({ setting: 'GitHub token', host: null })
  expect(anyToken({ ...NONE, 'GitHub token': 'ghp_x', 'Forgejo tokens': 'secret' })).toEqual({ setting: 'Forgejo tokens', host: null })
  expect(anyToken(NONE)).toBeNull()
})

test('checkForge: a known forge is not asked for again', async () => {
  const { send, seen } = forge({ '/api/v1/version': reply(200, { version: '12.0.1+gitea-1.22.0' }) })
  const known: Forge = { kind: 'forgejo', version: '12.0.1+gitea-1.22.0' }
  const found = await checkForge(send, R, NONE, 'epic', known)
  expect(found.forge).toEqual(known)
  expect(found.setup).toEqual({ kind: 'no-token' })
  expect(seen.filter(s => s.url.includes('/api/v1/version'))).toEqual([])
})

test('checkForge: a forge known as unknown is detected again', async () => {
  const { send, seen } = forge({ '/api/v1/version': reply(200, { version: '12.0.1+gitea-1.22.0' }) })
  const known: Forge = { kind: 'unknown', reason: 'other', detail: 'HTTP 404' } as Forge
  const found = await checkForge(send, R, NONE, 'epic', known)
  expect(found.forge.kind).toBe('forgejo')
  expect(seen.filter(s => s.url.includes('/api/v1/version')).length).toBe(1)
})
