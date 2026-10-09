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
  plugin: 'fj',
  component: 'Pane',
  requestId: 'fj',
  props: {
    title: 'fj',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const opts = (token: string, gitlabTokens = '') => ({ options: { token, gitlabTokens, icons: 'text', compact: 'off' } })

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
    asked.push({ url: e.url, auth: headers.Authorization })
    const path = new URL(e.url).pathname
    const r = replies[path]
    if (r === 'down') return { deny: 'connect ECONNREFUSED' }
    const reply = (status: number, body: unknown, h: Record<string, string> = {}) => ({
      value: { status, ok: status === 200, headers: h, text: JSON.stringify(body) },
    })
    if (r) return reply(r.status, r.body ?? {}, r.headers)
    if (path.endsWith('/api/v1/user')) return reply(200, { login: 'alice' })
    if (path.endsWith('/api/v1/users/alice/tokens')) return reply(200, [{ name: 'fj', scopes: ['read:issue'] }])
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

test('gitlab.com: not supported, asked nothing, its token from GitLab tokens', opts('bare', 'gitlab.example.com=glpat-a gitlab.com=glpat-b'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(asked).toEqual([])
  expect(all).toEqual(
    expect.arrayContaining([
      '✓ Repo    boats/radar',
      '✗ Forge   GitLab at gitlab.com, not supported',
      '✓ Token   for gitlab.com from GitLab tokens',
      '· Access  needs Forgejo',
      '· Actions needs Forgejo',
      'gitlab.com runs GitLab. fj does not show GitLab repos yet, only Forgejo and Gitea ones, so it has nothing to show for this repo.',
    ]),
  )
  expect(all).not.toContain('What to do')
})

test('gitlab.com with no GitLab token: none found', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@gitlab.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('✗ Token   none found')
  expect(asked).toEqual([])
})

test('github.com: not supported, asked nothing, the token needs Forgejo', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@github.com:boats/radar.git', {}, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(asked).toEqual([])
  expect(all).toEqual(
    expect.arrayContaining([
      '✗ Forge   GitHub at github.com, not supported',
      '· Token   needs Forgejo',
      '· Access  needs Forgejo',
      '· Actions needs Forgejo',
      'github.com runs GitHub. fj does not show GitHub repos yet, only Forgejo and Gitea ones, so it has nothing to show for this repo.',
    ]),
  )
})

test('self-hosted GitLab: found by probing, with no token sent', opts('bare git.example.org=x', 'glpat-a'), async ($, on) => {
  const asked: Asked = []
  world(on, 'https://gitlab.example.com/boats/radar.git', { '/api/v4/version': { status: 200, body: { version: '17.2.1' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Forge   GitLab 17.2.1 at gitlab.example.com, not supported')
  expect(all).toContain('✓ Token   from GitLab tokens')
  expect(all).toContain(
    'gitlab.example.com runs GitLab 17.2.1. fj does not show GitLab repos yet, only Forgejo and Gitea ones, so it has nothing to show for this repo.',
  )
  expect(asked.map(a => a.url)).toEqual([
    'https://gitlab.example.com/api/v1/version',
    'https://gitlab.example.com/api/v4/version',
  ])
  expect(asked.every(a => a.auth === undefined)).toBe(true)
})

test('GitHub Enterprise: found by probing, with no token sent', opts('bare'), async ($, on) => {
  const asked: Asked = []
  world(on, 'git@github.example.com:boats/radar.git', { '/api/v3/meta': { status: 200, body: { installed_version: '3.12.4' } } }, asked)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Forge   GitHub Enterprise 3.12.4 at github.example.com, not supported')
  expect(all).toContain('· Token   needs Forgejo')
  expect(all).toContain(
    'github.example.com runs GitHub Enterprise 3.12.4. fj does not show GitHub repos yet, only Forgejo and Gitea ones, so it has nothing to show for this repo.',
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
      '· Token   needs Forgejo',
      '· Access  needs Forgejo',
      '· Actions needs Forgejo',
      'code.example.com does not answer as Forgejo, Gitea, GitLab or GitHub Enterprise (HTTP 404 for /api/v1/version). fj has nothing to show for this repo.',
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
