import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

// The Token setting, as /plugin configure stores it.
const TOKEN = { options: { token: 'secret' } }

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

type World = {
  remote?: string | null
  // What /api/v1/version answers: a status, or 'down' for no answer at all.
  forge?: number | 'down'
  // What /repos/<o>/<r> answers.
  repo?: number
  opened?: { id: string; title?: string }[]
  asked?: { url: string; auth: string | undefined }[]
  envRead?: string[]
}

function world(on: On, w: World) {
  on('process.run', () => {
    const remote = w.remote === undefined ? 'ssh://git@git.example.org:2222/boats/radar.git' : w.remote
    return {
      value: {
        exitCode: remote === null ? 2 : 0,
        stdout: remote === null ? '' : `${remote}\n`,
        stderr: remote === null ? "error: No such remote 'origin'" : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // A FORGEJO_TOKEN in the environment, which fj must not read.
  on('env.get', (_$, e) => {
    w.envRead?.push(e.name)
    return { value: 'from-env' }
  })
  on('ui.open', (_$, e) => {
    w.opened?.push(e)
    return { value: { isPlaced: true } }
  })
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.asked?.push({ url: e.url, auth: headers.Authorization })
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) },
    })
    if (e.url.endsWith('/api/v1/version')) {
      if (w.forge === 'down') return { deny: 'connect ECONNREFUSED' }
      const status = w.forge ?? 200
      return reply(status, status === 200 ? { version: '12.0.1+gitea-1.22.0' } : { message: 'Not Found' })
    }
    const status = w.repo ?? 200
    return reply(status, status === 200 ? { full_name: 'boats/radar', open_issues_count: 7 } : {})
  })
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`all four steps pass and the pane says ready on ${surface}`, TOKEN, async ($, on) => {
    const opened: World['opened'] = []
    const asked: World['asked'] = []
    world(on, { opened, asked })

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(opened.at(-1)).toEqual(expect.objectContaining({ id: 'fj', title: 'fj · boats/radar' }))
    expect(asked).toEqual([
      { url: 'https://git.example.org/api/v1/version', auth: undefined },
      { url: 'https://git.example.org/api/v1/repos/boats/radar', auth: 'token secret' },
    ])
    expect(all).toEqual(
      expect.arrayContaining([
        '✓ Repo    boats/radar on git.example.org',
        '✓ Forgejo version 12.0.1',
        '✓ Token   from the Token setting',
        '✓ Access  7 open issues',
        'Ready.',
      ]),
    )
    expect(all).not.toContain('What to do')
    expect(out).toEqual(expect.objectContaining({ text: 'fj is ready for boats/radar.' }))
  })
}

test('no origin: says to start claude in a clone, and asks nothing', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { remote: null, asked })

  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('Set up Forgejo for Claude')
  expect(all).toContain('✗ Repo    not found')
  expect(all).toContain('· Forgejo ')
  expect(all).toContain('1. fj found no git remote "origin" in this directory.')
  expect(all).toContain('2. Start claude in a clone of a repo hosted on Forgejo or Gitea.')
  expect(all).toContain('3. Press r to check again.')
  expect(asked).toEqual([])
  expect(out).toEqual(expect.objectContaining({ text: 'fj needs setting up: see its pane.' }))
})

test('an origin that names no repo is quoted', async ($, on) => {
  world(on, { remote: '/srv/git/radar' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('1. fj could not read a repo from origin: /srv/git/radar.')
})

test('a host that is not Forgejo is named', TOKEN, async ($, on) => {
  world(on, { remote: 'git@github.com:boats/radar.git', forge: 404 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Repo    boats/radar on github.com')
  expect(all).toContain('✗ Forgejo not at github.com')
  expect(all).toContain('1. github.com does not answer as Forgejo or Gitea (HTTP 404 for /api/v1/version).')
})

test('a host that does not answer is named', TOKEN, async ($, on) => {
  world(on, { forge: 'down' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('1. git.example.org does not answer as Forgejo or Gitea (connect ECONNREFUSED).')
})

test('no token: links the token page and both ways to set it', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forgejo version 12.0.1')
  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('· Access  ')
  expect(all).toContain(
    '1. Create a token at https://git.example.org/user/settings/applications with read:issue and read:repository.',
  )
  expect(all).toContain('2. Run /plugin configure fj@egribnau-mods and paste it as Token.')
  expect(all).toContain('3. Press r to check again.')
  expect(all.some(t => t.includes('FORGEJO_TOKEN'))).toBe(false)
  expect(asked.map(a => a.url)).toEqual(['https://git.example.org/api/v1/version'])
})

for (const [status, first] of [
  [401, '1. Forgejo did not accept the token from the Token setting: it may be mistyped, expired or revoked.'],
  [403, '1. The token from the Token setting is valid but may not read this repo.'],
  [404, "1. boats/radar was not found, or the token's owner cannot see it."],
  [500, '1. Forgejo could not be asked: boats/radar: HTTP 500.'],
] as const) {
  test(`access answered ${status}: says why`, TOKEN, async ($, on) => {
    world(on, { repo: status })

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)

    expect(all).toContain('✓ Token   from the Token setting')
    expect(all).toContain('✗ Access  refused')
    expect(all).toContain(first)
  })
}

test('FORGEJO_TOKEN in the environment is not read', async ($, on) => {
  const asked: World['asked'] = []
  const read: string[] = []
  world(on, { asked, envRead: read })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await texts(ui)).toContain('✗ Token   none found')
  expect(read).toEqual([])
  expect(asked.some(a => a.auth !== undefined)).toBe(false)
})

test('r checks again and the guide goes once it passes', TOKEN, async ($, on) => {
  const w: World = { forge: 'down' }
  world(on, w)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).toContain('What to do')

  w.forge = 200
  await ui.press({ key: 'refresh' })

  const all = await texts(ui)
  expect(all).toContain('Ready.')
  expect(all).not.toContain('What to do')
})
