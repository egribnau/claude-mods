import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

// The Forgejo tokens setting, as /plugin configure stores it.
const TOKEN = { options: { token: 'secret', icons: 'text', compact: 'off' } }

const RUN = {
  command: 'next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

type World = {
  remote?: string | null
  // false: the session runs outside any git repo.
  inGit?: boolean
  pwd?: string
  // What /api/v1/version answers: a status, or 'down' for no answer at all.
  forge?: number | 'down'
  // The version /api/v1/version names.
  version?: string
  // What /repos/<o>/<r> answers.
  repo?: number
  // What /user answers: who the token belongs to, with read:user.
  user?: number
  // Push rights on the repo, and the token's scopes as the tokens list
  // gives them (null: the list is refused).
  push?: boolean
  scopes?: string[] | null
  opened?: { id: string; title?: string }[]
  asked?: { url: string; auth: string | undefined }[]
  envRead?: string[]
  // What the issue search answers: its status, and the issues on page 1.
  search?: number
  issues?: unknown[]
}

function world(on: On, w: World) {
  mock.clock(on)
  on('process.run', (_$, e) => {
    const remote = w.remote === undefined ? 'ssh://git@git.example.org:2222/boats/radar.git' : w.remote
    const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n`, stderr: '' })
    const fail = (stderr: string) => ({ exitCode: 128, stdout: '', stderr })
    const cmd = e.argv.join(' ')
    const out =
      cmd === 'pwd'
        ? ok(w.pwd ?? '/Users/jdoe/Documents/notes')
        : w.inGit === false
          ? fail('fatal: not a git repository (or any of the parent directories): .git')
          : cmd === 'git rev-parse --is-inside-work-tree'
            ? ok('true')
            : cmd === 'git remote get-url origin'
              ? remote === null
                ? fail("error: No such remote 'origin'")
                : ok(remote)
              : fail(`unexpected: ${cmd}`)
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A FORGEJO_TOKEN in the environment, which What's Next must not read.
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
      return reply(status, status === 200 ? { version: w.version ?? '12.0.1+gitea-1.22.0' } : { message: 'Not Found' })
    }
    // Neither GitLab nor GitHub Enterprise.
    if (e.url.includes('/api/v4/') || e.url.includes('/api/v3/')) return reply(404, { message: 'Not Found' })
    if (e.url.includes('/repos/issues/search')) {
      const page = new URL(e.url).searchParams.get('page')
      const status = w.search ?? 200
      return reply(status, status === 200 ? (page === '1' ? (w.issues ?? []) : []) : {})
    }
    if (new URL(e.url).pathname.endsWith('/repos/boats/radar/issues')) return reply(200, [])
    if (new URL(e.url).pathname.endsWith('/api/v1/users/alice/tokens')) {
      if (w.scopes === null) return reply(401, { message: 'basic auth required' })
      return reply(200, [{ name: 'whats-next', token_last_eight: 'secret', scopes: w.scopes ?? ['read:issue'] }])
    }
    if (new URL(e.url).pathname.endsWith('/api/v1/user')) {
      const status = w.user ?? 200
      return reply(status, status === 200 ? { login: 'alice' } : { message: 'token does not have at least one of required scope(s): [read:user]' })
    }
    const status = w.repo ?? 200
    return reply(status, status === 200 ? { full_name: 'boats/radar', open_issues_count: 7, permissions: { push: w.push ?? false } } : {})
  })
}

type Ui = { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }
const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`all four steps pass and the pane says ready on ${surface}`, TOKEN, async ($, on) => {
    const opened: World['opened'] = []
    const asked: World['asked'] = []
    world(on, { opened, asked, search: 500 })

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(opened.at(-1)).toEqual(expect.objectContaining({ id: 'next', title: "What's next" }))
    expect(asked.slice(0, 2)).toEqual([
      { url: 'https://git.example.org/api/v1/version', auth: undefined },
      { url: 'https://git.example.org/api/v1/repos/boats/radar', auth: 'token secret' },
    ])
    expect(asked[2]).toEqual({ url: 'https://git.example.org/api/v1/user', auth: 'token secret' })
    // With the list failing to load, the ready screen shows, with why.
    expect(all[0]).toBe('Could not load the issues: your issues: HTTP 500.')
    expect(all[1]).toBe("What's Next is ready!")
    expect(all).toEqual(
      expect.arrayContaining([
        '✓ Repo    boats/radar',
        '✓ Forge   Forgejo 12.0.1 at git.example.org',
        '✓ Token   from Forgejo tokens',
        '✓ Access  7 open issues, as alice',
      ]),
    )
    expect(all).not.toContain('What to do')
    expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar, but could not load its issues." }))
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`not a git repo: names the folder and asks nothing on ${surface}`, TOKEN, async ($, on) => {
    const asked: World['asked'] = []
    const opened: World['opened'] = []
    world(on, { inGit: false, asked, opened })

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(all).toEqual([
      "Set up What's Next",
      '✗ Repo    no repo here',
      '· Forge   needs a repo',
      '✓ Token   from Forgejo tokens',
      '· Access  needs a repo',
      '· Actions needs a repo',
      "What's Next shows the issues of the repo this session runs in. ~/Documents/notes is not a git repo, so there is nothing to show here.",
      'What to do',
      '1. If this folder belongs on a forge: git init and git remote add origin https://your-forge/owner/repo.git, then press r.',
      // The commands, drawn in their own color inside that line.
      'git init',
      'git remote add origin https://your-forge/owner/repo.git',
    ])
    const cmd = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'git init')
    expect(cmd?.props.color).toBe('warning')
    await expect(ui.find({ key: 'refresh' })).resolves.toBeDefined()
    expect(asked).toEqual([])
    expect(opened.map(o => o.title)).toEqual(["What's Next"])
    expect(out).toEqual(expect.objectContaining({ text: "What's Next needs setting up: see its pane." }))
  })
}

test('not a git repo, and no token: the token step says so too', async ($, on) => {
  world(on, { inGit: false, pwd: '/home/jdoe/scratch' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Token   none found')
  expect(all.some(t => t.includes('~/scratch is not a git repo'))).toBe(true)
})

test('a repo without origin', TOKEN, async ($, on) => {
  world(on, { remote: null })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain("What's Next shows the issues of the repo this session runs in. This repo has no remote origin.")
  expect(all).toContain('1. If this repo is on a forge: git remote add origin https://your-forge/owner/repo.git, then press r.')
})

test('an origin that names no host is quoted', TOKEN, async ($, on) => {
  world(on, { remote: '/srv/git/radar' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain("What's Next shows the issues of the repo this session runs in. origin is /srv/git/radar, which names no host.")
  expect(all).toContain('1. If this repo is on a forge: git remote set-url origin https://your-forge/owner/repo.git, then press r.')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a host that runs no forge What's Next knows: says so, with nothing to do, on ${surface}`, TOKEN, async ($, on) => {
    const asked: World['asked'] = []
    world(on, { forge: 404, asked })

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)

    expect(all).toEqual([
      "Set up What's Next",
      '✓ Repo    boats/radar',
      '✗ Forge   no known forge at git.example.org',
      '· Token   needs a forge',
      '· Access  needs a forge',
      '· Actions needs a forge',
      "git.example.org does not answer as Forgejo, Gitea, GitLab or GitHub Enterprise (HTTP 404 for /api/v1/version). What's Next has nothing to show for this repo.",
    ])
    await expect(ui.find({ key: 'refresh' })).resolves.toBeDefined()
    // The token goes to no host that is not Forgejo.
    expect(asked.map(a => a.url)).toEqual([
      'https://git.example.org/api/v1/version',
      'https://git.example.org/api/v4/version',
      'https://git.example.org/api/v3/meta',
    ])
    expect(asked.every(a => a.auth === undefined)).toBe(true)
  })
}

test('github.com: known without asking; the Forgejo token is not for GitHub', TOKEN, async ($, on) => {
  const asked: World['asked'] = []
  world(on, { remote: 'git@github.com:boats/radar.git', asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all.slice(0, 5)).toEqual([
    "Set up What's Next",
    '✓ Repo    boats/radar',
    '✓ Forge   GitHub at github.com',
    '✗ Token   none found',
    '· Access  ',
  ])
  expect(all).toContain(
    '2. Run /plugin configure whats-next@egribnau-mods and paste it as GitHub token, alone or as github.com=<token> next to tokens for other hosts.',
  )
  expect(asked).toEqual([])
})

test('gitlab.com: the token step reads an old gitlab.com= pair in Private GitLab token, and GitLab is asked with it', {
  options: { token: 'secret', gitlabTokens: 'gitlab.com=glpat-1', icons: 'text', compact: 'off' },
}, async ($, on) => {
  const asked: World['asked'] = []
  world(on, { remote: 'https://gitlab.com/boats/radar.git', asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   GitLab at gitlab.com')
  expect(all).toContain('✓ Token   for gitlab.com from Private GitLab token')
  expect(all).toContain('✗ Access  no answer')
  expect(all).toContain('GitLab could not be asked: /user: HTTP 404.')
  expect(all).not.toContain('What to do')
  expect(asked.map(a => a.url)).toEqual([
    'https://gitlab.com/api/v4/personal_access_tokens/self',
    'https://gitlab.com/api/v4/user',
  ])
})

test("a host=token pair wins over a bare token, and the pane names the host", {
  options: { token: 'bare other.org=elsewhere git.example.org=secret', icons: 'text', compact: 'off' },
}, async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked, search: 500 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Token   for git.example.org from Forgejo tokens')
  expect(asked[1]).toEqual({ url: 'https://git.example.org/api/v1/repos/boats/radar', auth: 'token secret' })
})

test('a host that does not answer is named, with how to check it', TOKEN, async ($, on) => {
  world(on, { forge: 'down' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Forge   no answer from git.example.org')
  expect(all).toContain(
    'git.example.org did not answer (connect ECONNREFUSED). Check that https://git.example.org opens from this computer.',
  )
})

test('a version older than 1.19 is too old', TOKEN, async ($, on) => {
  world(on, { version: '1.18.5' })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Forge   Gitea 1.18.5, too old')
  expect(all).toContain(
    "What's Next needs Forgejo or Gitea 1.19 or newer, the first with scoped tokens (read:issue, read:repository, read:user). git.example.org runs Gitea 1.18.5.",
  )
})

for (const [version, shown] of [
  ['1.19.0', 'Gitea 1.19.0'],
  ['1.22.6', 'Gitea 1.22.6'],
  ['1.21.11-2+gitea-1.21.11', 'Forgejo 1.21.11-2'],
  ['7.0.0+gitea-1.21.0', 'Forgejo 7.0.0'],
  ['16.0.5+gitea-1.22.0', 'Forgejo 16.0.5'],
] as const) {
  test(`${version} is new enough, shown as ${shown}`, async ($, on) => {
    world(on, { version })

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect(await texts(ui)).toContain(`✓ Forge   ${shown} at git.example.org`)
  })
}

test('no token: links the token page and both ways to set it', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✓ Forge   Forgejo 12.0.1 at git.example.org')
  expect(all).toContain('✗ Token   none found')
  expect(all).toContain('· Access  ')
  expect(all).toContain(
    '1. Create a token at https://git.example.org/user/settings/applications with write:issue, read:repository and read:user; read:issue instead of write:issue is read only.',
  )
  // The address is a link, the command a command; neither keeps punctuation.
  expect(all).toContain('https://git.example.org/user/settings/applications')
  expect(all).toContain('/plugin configure whats-next@egribnau-mods')
  expect(all).toContain('2. Run /plugin configure whats-next@egribnau-mods and paste it as Forgejo tokens, alone or as git.example.org=<token> next to tokens for other hosts.')
  expect(all.some(t => t.includes('Press r'))).toBe(false)
  // Checking again ends the guide, as a button of its own.
  await expect(ui.find({ key: 'refresh' })).resolves.toBeDefined()
  expect(all.some(t => t.includes('FORGEJO_TOKEN'))).toBe(false)
  expect(asked.map(a => a.url)).toEqual(['https://git.example.org/api/v1/version'])
})

for (const [name, w, want] of [
  ['write:issue and push', { push: true, scopes: ['write:issue', 'read:repository', 'read:user'] }, '✓ Actions assign and close'],
  ['all scopes and push', { push: true, scopes: ['all'] }, '✓ Actions assign and close'],
  ['no write:issue', { push: true, scopes: ['read:issue'] }, '· Actions read only, token lacks write:issue'],
  ['no push', { push: false, scopes: ['write:issue'] }, '· Actions read only, alice may not push here'],
  ['scopes not listed', { push: true, scopes: null }, '· Actions unknown, scopes not listed'],
] as const) {
  test(`the Actions step with ${name}, and setup passes`, TOKEN, async ($, on) => {
    // The list failing keeps the steps on screen.
    world(on, { ...w, scopes: w.scopes === null ? null : [...w.scopes], search: 500 })
    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await texts(ui)).toContain(want)
    expect(out).toEqual(expect.objectContaining({ text: "What's Next is ready for boats/radar, but could not load its issues." }))
  })
}

test('a token without read:user: says it needs that scope too', TOKEN, async ($, on) => {
  world(on, { user: 403 })
  const out = await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)

  expect(all).toContain('✗ Access  no read:user')
  expect(all).toContain(
    "The token from Forgejo tokens reads boats/radar, but not who it belongs to: What's Next needs read:user too.",
  )
  expect(all).toContain(
    '1. Create a token at https://git.example.org/user/settings/applications with write:issue, read:repository and read:user; read:issue instead of write:issue is read only.',
  )
  expect(out).toEqual(expect.objectContaining({ text: "What's Next needs setting up: see its pane." }))
})

for (const [status, label, about, first] of [
  [
    401,
    'token refused',
    'Forgejo did not accept the token from Forgejo tokens: it may be mistyped, expired or revoked.',
    '1. Create a token at https://git.example.org/user/settings/applications with write:issue, read:repository and read:user; read:issue instead of write:issue is read only.',
  ],
  [
    403,
    'no permission',
    'The token from Forgejo tokens is valid but may not read this repo.',
    '1. Create a token at https://git.example.org/user/settings/applications with write:issue, read:repository and read:user; read:issue instead of write:issue is read only.',
  ],
  [
    404,
    'not found',
    "boats/radar, from origin, was not found, or the token's owner cannot see it.",
    '1. If origin points to the wrong repo: git remote set-url origin https://git.example.org/owner/repo.git.',
  ],
  [500, 'no answer', 'Forgejo could not be asked: boats/radar: HTTP 500.', null],
] as const) {
  test(`access answered ${status}: says what happened, then what to do`, TOKEN, async ($, on) => {
    world(on, { repo: status })

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const all = await texts(ui)

    expect(all).toContain('✓ Token   from Forgejo tokens')
    expect(all).toContain(`✗ Access  ${label}`)
    expect(all.indexOf(about)).toBeGreaterThan(0)
    if (first === null) {
      // Nothing to do but check again.
      expect(all).not.toContain('What to do')
    } else {
      expect(all.indexOf(about)).toBeLessThan(all.indexOf('What to do'))
      expect(all[all.indexOf('What to do') + 1]).toBe(first)
    }
    await expect(ui.find({ key: 'refresh' })).resolves.toBeDefined()
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

test('r checks again and the list follows once setup passes', TOKEN, async ($, on) => {
  const w: World = { forge: 'down' }
  world(on, w)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).toContain('✗ Forge   no answer from git.example.org')

  w.forge = 200
  await ui.press({ key: 'refresh' })

  const all = await texts(ui)
  expect(all[0]).toBe("What's next")
  expect(all).toContain('No open issues in boats/radar.')
})
