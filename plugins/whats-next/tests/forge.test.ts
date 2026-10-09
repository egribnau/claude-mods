import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detect, forgeName, tokenFor, type Forge } from '../hooks/forge'
import type { Send } from '../hooks/tracker'

// tokenFor

test('tokenFor: a bare token is for every host', () => {
  expect(tokenFor('bare', 'git.example.org')).toEqual({ value: 'bare', host: false })
})

test('tokenFor: a pair for the host wins over a bare token', () => {
  expect(tokenFor('bare git.example.org=pairtok', 'git.example.org')).toEqual({ value: 'pairtok', host: true })
  expect(tokenFor('git.example.org=pairtok bare', 'git.example.org')).toEqual({ value: 'pairtok', host: true })
})

test('tokenFor: a pair for another host falls back to the bare token', () => {
  expect(tokenFor('other.host=x bare', 'git.example.org')).toEqual({ value: 'bare', host: false })
})

test('tokenFor: only pairs for other hosts gives none', () => {
  expect(tokenFor('other.host=x third.host=y', 'git.example.org')).toBeNull()
  expect(tokenFor('', 'git.example.org')).toBeNull()
})

test('tokenFor: the host matches whatever its case', () => {
  expect(tokenFor('Git.Example.ORG=pairtok', 'git.example.org')).toEqual({ value: 'pairtok', host: true })
  expect(tokenFor('git.example.org=pairtok', 'GIT.example.org')).toEqual({ value: 'pairtok', host: true })
})

test('tokenFor: with no host, the bare token, else the first pair', () => {
  expect(tokenFor('a.host=x bare', null)).toEqual({ value: 'bare', host: false })
  expect(tokenFor('a.host=x b.host=y', null)).toEqual({ value: 'x', host: true })
  expect(tokenFor('', null)).toBeNull()
})

test('tokenFor: extra whitespace between and around entries', () => {
  expect(tokenFor('  \n bare \t  git.example.org=pairtok  \n', 'git.example.org')).toEqual({ value: 'pairtok', host: true })
  expect(tokenFor('  bare  ', 'git.example.org')).toEqual({ value: 'bare', host: false })
})

// detect

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'down'

// A Send answering by path, recording each URL; paths it does not know answer 404.
function fakeSend(replies: Record<string, Reply>, urls: string[]): Send {
  return (async (url: string) => {
    urls.push(url)
    const r = replies[new URL(url).pathname] ?? { status: 404, body: { message: 'Not Found' } }
    if (r === 'down') throw new Error('connect ECONNREFUSED')
    return { status: r.status, ok: r.status === 200, headers: r.headers ?? {}, text: JSON.stringify(r.body ?? {}) }
  }) as unknown as Send
}

test('detect: github.com and gitlab.com are known without a request', async () => {
  const urls: string[] = []
  const send = fakeSend({}, urls)
  expect(await detect(send, 'github.com')).toEqual({ kind: 'github', version: null })
  expect(await detect(send, 'gitlab.com')).toEqual({ kind: 'gitlab', version: null })
  expect(await detect(send, 'GitHub.com')).toEqual({ kind: 'github', version: null })
  expect(urls).toEqual([])
})

test('detect: Forgejo answers the first request', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v1/version': { status: 200, body: { version: '12.0.1+gitea-1.22.0' } } }, urls)
  expect(await detect(send, 'git.example.org')).toEqual({ kind: 'forgejo', version: '12.0.1+gitea-1.22.0' })
  expect(urls).toEqual(['https://git.example.org/api/v1/version'])
})

test('detect: GitLab names its version', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v4/version': { status: 200, body: { version: '17.2.1' } } }, urls)
  expect(await detect(send, 'gitlab.example.com')).toEqual({ kind: 'gitlab', version: '17.2.1' })
  expect(urls).toEqual(['https://gitlab.example.com/api/v1/version', 'https://gitlab.example.com/api/v4/version'])
})

test('detect: a GitLab JSON refusal is GitLab with no version', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v4/version': { status: 401, body: { message: '401 Unauthorized' } } }, urls)
  expect(await detect(send, 'gitlab.example.com')).toEqual({ kind: 'gitlab', version: null })
  expect(urls).toHaveLength(2)
})

test('detect: GitHub Enterprise by /api/v3/meta', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v3/meta': { status: 200, body: { installed_version: '3.12.4' } } }, urls)
  expect(await detect(send, 'github.example.com')).toEqual({ kind: 'github', version: '3.12.4' })
  expect(urls).toEqual([
    'https://github.example.com/api/v1/version',
    'https://github.example.com/api/v4/version',
    'https://github.example.com/api/v3/meta',
  ])
})

test('detect: GitHub Enterprise by its version header', async () => {
  const urls: string[] = []
  const send = fakeSend(
    { '/api/v3/meta': { status: 200, body: {}, headers: { 'x-github-enterprise-version': '3.11.0' } } },
    urls,
  )
  expect(await detect(send, 'github.example.com')).toEqual({ kind: 'github', version: '3.11.0' })
})

test('detect: nothing matches, unknown with the status of the first', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v1/version': { status: 502, body: {} } }, urls)
  expect(await detect(send, 'nothing.example.org')).toEqual({
    kind: 'unknown',
    reason: 'other',
    detail: 'HTTP 502 for /api/v1/version',
  })
  expect(urls).toHaveLength(3)
})

test('detect: a host that does not answer is asked once', async () => {
  const urls: string[] = []
  const send = fakeSend({ '/api/v1/version': 'down' }, urls)
  const f = await detect(send, 'git.example.org')
  expect(f.kind).toBe('unknown')
  expect(f).toEqual(expect.objectContaining({ reason: 'no-answer' }))
  expect((f as { detail: string }).detail).toContain('ECONNREFUSED')
  expect(urls).toEqual(['https://git.example.org/api/v1/version'])
})

// forgeName

for (const [f, name] of [
  [{ kind: 'forgejo', version: '12.0.1+gitea-1.22.0' }, 'Forgejo 12.0.1'],
  [{ kind: 'forgejo', version: '1.22.0' }, 'Gitea 1.22.0'],
  [{ kind: 'gitlab', version: '17.2.1' }, 'GitLab 17.2.1'],
  [{ kind: 'gitlab', version: null }, 'GitLab'],
  [{ kind: 'github', version: '3.12.4' }, 'GitHub Enterprise 3.12.4'],
  [{ kind: 'github', version: null }, 'GitHub'],
] as [Forge, string][]) {
  test(`forgeName: ${name}`, () => {
    expect(forgeName(f)).toBe(name)
  })
}

// The pane

const PANE = {
  plugin: 'whats-next',
  component: 'Pane',
  requestId: 'next',
  props: {
    title: "What's Next",
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = {
  command: 'next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

// `gitlabTokens` is the Private GitLab token setting, `gitlabComToken` the
// GitLab.com token setting.
const opts = (token: string, gitlabTokens = '', gitlabComToken = '') => ({
  options: { token, gitlabTokens, gitlabComToken, icons: 'text', compact: 'off' },
})

type Asked = { url: string; auth: string | undefined }[]

// A repo with `remote` as origin; http answers by path from `replies`, the
// rest as a Forgejo with boats/radar and no issues would.
function world(on: On, remote: string, replies: Record<string, Reply>, asked: Asked) {
  mock.clock(on)
  on('process.run', (_$, e) => {
    const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n`, stderr: '' })
    const cmd = e.argv.join(' ')
    const out =
      cmd === 'pwd'
        ? ok('/Users/jdoe/dev/radar')
        : cmd === 'git rev-parse --is-inside-work-tree'
          ? ok('true')
          : cmd === 'git remote get-url origin'
            ? ok(remote)
            : { exitCode: 128, stdout: '', stderr: `unexpected: ${cmd}` }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    asked.push({ url: e.url, auth: headers.Authorization ?? headers['PRIVATE-TOKEN'] })
    const path = new URL(e.url).pathname
    const r = replies[path]
    if (r === 'down') return { deny: 'connect ECONNREFUSED' }
    const reply = (status: number, body: unknown, h: Record<string, string> = {}) => ({
      value: { status, ok: status === 200, headers: h, text: JSON.stringify(body) },
    })
    if (r) return reply(r.status, r.body ?? {}, r.headers)
    if (path.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (path.endsWith('/api/v1/users/alice/tokens')) return reply(200, [{ name: 'whats-next', scopes: ['read:issue'] }])
    if (path.endsWith('/repos/issues/search')) return reply(500, {})
    if (path.endsWith('/repos/boats/radar/issues')) return reply(200, [])
    if (path.endsWith('/api/v1/repos/boats/radar')) {
      return reply(200, { full_name: 'boats/radar', open_issues_count: 7, permissions: { push: false } })
    }
    return reply(404, { message: 'Not Found' })
  })
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

const FORGEJO: Record<string, Reply> = { '/api/v1/version': { status: 200, body: { version: '12.0.1+gitea-1.22.0' } } }

const GITLAB: Record<string, Reply> = {
  '/api/v4/personal_access_tokens/self': { status: 200, body: { scopes: ['read_api'] } },
  '/api/v4/user': { status: 200, body: { username: 'alice' } },
  '/api/v4/projects/boats%2Fradar': { status: 200, body: { open_issues_count: 3 } },
  // The list failing keeps the steps on screen.
  '/api/v4/projects/boats%2Fradar/issues': { status: 500 },
}

test('gitlab.com: ready, its token from an old gitlab.com= pair in Private GitLab token, read only with read_api', opts('bare', 'gitlab.example.com=glpat-a gitlab.com=glpat-b'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', GITLAB, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toEqual(
    expect.arrayContaining([
      '✓ Repo    boats/radar',
      '✓ Forge   GitLab at gitlab.com',
      '✓ Token   for gitlab.com from Private GitLab token',
      '✓ Access  3 open issues, as alice',
      '· Actions read only, token lacks api',
    ]),
  )
  expect(asked.slice(0, 3).map(a => a.url)).toEqual([
    'https://gitlab.com/api/v4/personal_access_tokens/self',
    'https://gitlab.com/api/v4/user',
    'https://gitlab.com/api/v4/projects/boats%2Fradar',
  ])
  expect(asked.every(a => a.auth === 'glpat-b')).toBe(true)
})

test('gitlab.com with no GitLab token: none found, and how to make one', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('1. Create a token at https://gitlab.com/-/user_settings/personal_access_tokens with api, or read_api for read only.')
  expect(all).toContain(
    '2. Run /plugin configure whats-next@egribnau-mods and paste it as GitLab.com token.',
  )
  expect(asked).toEqual([])
})

test('gitlab.com: its token from GitLab.com token, which wins over an old gitlab.com= pair', opts('bare', 'glpat-p gitlab.com=glpat-old', 'glpat-com'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', GITLAB, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Token   from GitLab.com token')
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.every(a => a.auth === 'glpat-com')).toBe(true)
})

test('gitlab.com: the bare token in Private GitLab token is not for gitlab.com', opts('bare', 'glpat-p gitlab.example.com=glpat-b'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', GITLAB, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('2. Run /plugin configure whats-next@egribnau-mods and paste it as GitLab.com token.')
  expect(asked).toEqual([])
})

test('gitlab.com: a token GitLab refuses is named as GitLab refusing it', opts('', '', 'glpat-a'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', { '/api/v4/personal_access_tokens/self': { status: 401 } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Access  token refused')
  expect(all).toContain('GitLab did not accept the token from GitLab.com token: it may be mistyped, expired or revoked.')
  expect(asked).toHaveLength(1)
})

test('gitlab.com: a token without read_api says it needs that scope', opts('', '', 'glpat-a'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', { '/api/v4/personal_access_tokens/self': { status: 200, body: { scopes: ['read_user'] } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Access  no read_api')
  expect(all).toContain("The token from GitLab.com token may not read boats/radar: What's Next needs read_api.")
  expect(asked).toHaveLength(1)
})

test('github.com: not supported, asked nothing, the token needs a forge', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@github.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(asked).toEqual([])
  expect(all).toEqual(
    expect.arrayContaining([
      '✗ Forge   GitHub at github.com, not supported',
      '· Token   needs a forge',
      '· Access  needs a forge',
      '· Actions needs a forge',
      "github.com runs GitHub. What's Next does not show GitHub repos yet, only Forgejo, Gitea and GitLab ones, so it has nothing to show for this repo.",
    ]),
  )
})

test('self-hosted GitLab: found by probing with no token, then asked with the bare Private GitLab token', opts('bare git.example.org=x', 'glpat-a', 'glpat-com'), async ($, on) => {
  const asked: Asked = []
  world(on, 'https://gitlab.example.com/boats/radar.git', { '/api/v4/version': { status: 200, body: { version: '17.2.1' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   GitLab 17.2.1 at gitlab.example.com')
  expect(all).toContain('✓ Token   from Private GitLab token')
  // An older GitLab without personal_access_tokens/self goes on to /user.
  expect(all).toContain('GitLab could not be asked: /user: HTTP 404.')
  expect(asked).toEqual([
    { url: 'https://gitlab.example.com/api/v1/version', auth: undefined },
    { url: 'https://gitlab.example.com/api/v4/version', auth: undefined },
    { url: 'https://gitlab.example.com/api/v4/personal_access_tokens/self', auth: 'glpat-a' },
    { url: 'https://gitlab.example.com/api/v4/user', auth: 'glpat-a' },
  ])
})

test('self-hosted GitLab: a host=token pair in Private GitLab token wins over its bare token', opts('', 'glpat-a gitlab.example.com=glpat-b'), async ($, on) => {
  const asked: Asked = []
  world(on, 'https://gitlab.example.com/boats/radar.git', { '/api/v4/version': { status: 200, body: { version: '17.2.1' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Token   for gitlab.example.com from Private GitLab token')
  expect(asked.slice(2).every(a => a.auth === 'glpat-b')).toBe(true)
})

test('self-hosted GitLab with no token: GitLab.com token is not used, and the guide names Private GitLab token', opts('bare', '', 'glpat-com'), async ($, on) => {
  const asked: Asked = []
  world(on, 'https://gitlab.example.com/boats/radar.git', { '/api/v4/version': { status: 200, body: { version: '17.2.1' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('1. Create a token at https://gitlab.example.com/-/user_settings/personal_access_tokens with api, or read_api for read only.')
  expect(all).toContain('2. Run /plugin configure whats-next@egribnau-mods and paste it as Private GitLab token.')
  expect(asked.map(a => a.url)).toEqual([
    'https://gitlab.example.com/api/v1/version',
    'https://gitlab.example.com/api/v4/version',
  ])
})

test('GitHub Enterprise: found by probing, with no token sent', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@github.example.com:boats/radar.git', { '/api/v3/meta': { status: 200, body: { installed_version: '3.12.4' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Forge   GitHub Enterprise 3.12.4 at github.example.com, not supported')
  expect(all).toContain('· Token   needs a forge')
  expect(all).toContain(
    "github.example.com runs GitHub Enterprise 3.12.4. What's Next does not show GitHub repos yet, only Forgejo, Gitea and GitLab ones, so it has nothing to show for this repo.",
  )
  expect(asked).toHaveLength(3)
  expect(asked.every(a => a.auth === undefined)).toBe(true)
})

test('a host no known forge answers for: says so, with no token sent', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@code.example.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toEqual(
    expect.arrayContaining([
      '✗ Forge   no known forge at code.example.com',
      '· Token   needs a forge',
      '· Access  needs a forge',
      '· Actions needs a forge',
      "code.example.com does not answer as Forgejo, Gitea, GitLab or GitHub Enterprise (HTTP 404 for /api/v1/version). What's Next has nothing to show for this repo.",
    ]),
  )
  expect(asked.every(a => a.auth === undefined)).toBe(true)
})

test('Forgejo: a pair for the host wins, and the version is asked once', opts('bare git.example.org=pairtok'), async ($, on) => {
  const asked: Asked = []
  world(on, 'ssh://git@git.example.org:2222/boats/radar.git', FORGEJO, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   Forgejo 12.0.1 at git.example.org')
  expect(all).toContain('✓ Token   for git.example.org from Forgejo tokens')
  expect(asked.filter(a => a.url.endsWith('/api/v1/version'))).toEqual([
    { url: 'https://git.example.org/api/v1/version', auth: undefined },
  ])
  const authed = asked.filter(a => a.auth !== undefined)
  expect(authed.length).toBeGreaterThan(0)
  expect(authed.every(a => a.auth === 'token pairtok')).toBe(true)
})

test('Forgejo: only a pair for another host is no token', opts('other.host=x'), async ($, on) => {
  const asked: Asked = []
  world(on, 'ssh://git@git.example.org:2222/boats/radar.git', FORGEJO, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   Forgejo 12.0.1 at git.example.org')
  expect(all).toContain('✗ Token   none found')
  expect(asked.some(a => a.auth !== undefined)).toBe(false)
})
