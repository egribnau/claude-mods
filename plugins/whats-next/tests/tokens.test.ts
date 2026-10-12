import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { github } from '../hooks/github'
import { withoutToken, type Send, type Tracker } from '../hooks/tracker'

// Token safety: a token never shows in what What's Next says, goes only to
// its own host, and comes only from the token settings.

const PANE = {
  plugin: 'whats-next',
  component: 'Pane',
  requestId: 'next',
  props: {
    title: "What's Next",
    isFocused: false,
    bodyColumns: 200,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const RUN = {
  command: 'next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

const TOKEN = 'ghp_S3cretS3cretS3cret0123'
// The GitHub token setting, with Debug on so its counter shows too.
const GH = { options: { githubTokens: TOKEN, debug: true, icons: 'text', compact: 'off' } }

type Reply = { status: number; text: string; headers?: Record<string, string> }
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, text: JSON.stringify(body), headers })

// A forge that echoes the request back in its refusal, headers and all.
const echo = (url: string, headers: Record<string, string>) => `Bad request: GET ${url} with ${JSON.stringify(headers)}`

const person = (login: string, id: number) => ({ login, id, type: 'User', html_url: `https://github.com/${login}` })

function issue(number: number, title = `Issue ${number}`) {
  return {
    number,
    title,
    body: `Body of ${number}`,
    html_url: `https://github.com/boats/radar/issues/${number}`,
    state: 'open',
    user: person('jdoe', 777),
    labels: [],
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: '2026-09-18T09:00:00Z',
    updated_at: '2026-10-08T09:30:00Z',
    closed_at: null,
  }
}

type World = {
  // A path answered as given, over GitHub's usual answer.
  answers?: Record<string, (url: string, headers: Record<string, string>, method: string) => Reply | null>
  title?: string
  origin?: string
  said?: string[]
}

// github.com with the boats/radar repo and its one open issue, #14. All the
// pane says, every toast and every prompt drafted end up in `said`.
function world(on: On, w: World) {
  const said = w.said ?? []
  mock.clock(on)
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git remote get-url origin' ? (w.origin ?? 'git@github.com:boats/radar.git') : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    said.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    said.push(e.text)
    return { isFilled: true }
  })
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    const u = new URL(e.url)
    const p = u.pathname
    const own = w.answers?.[p]?.(e.url, headers, e.init?.method ?? 'GET')
    const r: Reply = own
      ? own
      : p === '/user'
        ? json(200, person('alice', 991), { 'x-oauth-scopes': 'repo' })
        : p === '/repos/boats/radar'
          ? json(200, { full_name: 'boats/radar', private: true, has_issues: true, open_issues_count: 1, permissions: { push: true, pull: true } })
          : p === '/search/issues'
            ? json(200, { total_count: 1, items: [] })
            : p === '/repos/boats/radar/issues'
              ? json(200, u.searchParams.has('assignee') ? [] : [issue(14, w.title)])
              : p === '/repos/boats/radar/issues/14'
                ? json(200, issue(14, w.title))
                : p === '/repos/boats/radar/milestones'
                  ? json(200, [])
                  : json(404, { message: 'Not Found' })
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { 'content-type': 'application/json', ...r.headers }, text: r.text } }
  })
  return said
}

type Ui = {
  findAll: (q: { type: string }) => Promise<unknown[]>
  press: (q: { key: string }) => Promise<unknown>
}
const texts = async (ui: Ui) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)

async function shown($: Engine) {
  await $.command.run(RUN)
  return (await $.ui.mount({ ...PANE, surface: 'terminal' })) as Ui
}

// No part of the token in anything said: not whole, not its last eight.
const noToken = (said: string[]) => {
  for (const s of said) {
    expect(s).not.toContain(TOKEN)
    expect(s).not.toContain(TOKEN.slice(-8))
  }
}

// What's Next says no token.

test('setup: a refusal that echoes the request shows without the token', GH, async ($, on) => {
  const said = world(on, { answers: { '/user': (url, h) => json(500, { message: echo(url, h) }) } })
  const ui = await shown($)
  said.push(...(await texts(ui)))

  expect(said.some(s => s.includes('Bad request: GET https://api.github.com/user'))).toBe(true)
  expect(said.some(s => s.includes('Bearer <token>'))).toBe(true)
  noToken(said)
})

test('lists: a refusal that echoes the request shows without the token', GH, async ($, on) => {
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues': (url, h) =>
        url.includes('assignee=') ? json(500, { message: echo(url, h) }) : json(200, [issue(14)]),
    },
  })
  const ui = await shown($)
  said.push(...(await texts(ui)))

  expect(said.some(s => s.startsWith('Could not load the issues') && s.includes('Bearer <token>'))).toBe(true)
  noToken(said)
})

test('lists: a page that is not JSON, echoing the request, shows without the token', GH, async ($, on) => {
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues': (url, h) =>
        url.includes('assignee=') ? { status: 200, text: `<html>${echo(url, h)}</html>` } : json(200, [issue(14)]),
    },
  })
  const ui = await shown($)
  said.push(...(await texts(ui)))

  expect(said.some(s => s.startsWith('Could not load the issues'))).toBe(true)
  noToken(said)
})

test('Close: a refusal that echoes the request shows without the token', GH, async ($, on) => {
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues/14': (url, h, method) => (method === 'PATCH' ? json(422, { message: echo(url, h) }) : null),
    },
  })
  const ui = await shown($)
  await ui.press({ key: 'pick-14' })
  await ui.press({ key: 'close' })
  said.push(...(await texts(ui)))

  // The refusal in red, wrapped to the pane, each line its own Text: whole again, it still has no token.
  const red = ((await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]).filter(t => t.props.color === 'error')
  const refusal = red.map(t => t.text).join(' ')
  expect(refusal.startsWith('Could not close #14')).toBe(true)
  expect(refusal).toContain('Bearer <token>')
  noToken([...said, refusal])
})

test('Last closed: an issue whose title names the token, and the requests for where you work, carry no token', GH, async ($, on) => {
  const closed = { ...issue(41, `Rotate ${TOKEN}`), state: 'closed', closed_at: '2026-10-09T10:00:00Z' }
  const asked: { url: string; headers: Record<string, string> }[] = []
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues': (url, h) => {
        asked.push({ url, headers: h })
        const u = new URL(url)
        return u.searchParams.get('state') === 'closed' ? json(200, [closed]) : json(200, u.searchParams.has('assignee') ? [] : [issue(14)])
      },
      '/repos/boats/radar/issues/41/parent': (url, h) => {
        asked.push({ url, headers: h })
        return json(200, { ...issue(30, `Epic ${TOKEN}`), state: 'open' })
      },
    },
  })
  const ui = await shown($)
  said.push(...(await texts(ui)))

  expect(said).toContain('✓ #41 Rotate <token>')
  expect(said.some(s => s.startsWith('── Last closed') && s.includes('in epic #30'))).toBe(true)
  // The new requests go to GitHub's API host with the token, and say it nowhere else.
  expect(asked.some(a => new URL(a.url).searchParams.get('state') === 'closed')).toBe(true)
  expect(asked.some(a => a.url.endsWith('/issues/41/parent'))).toBe(true)
  for (const a of asked) {
    expect(new URL(a.url).host).toBe('api.github.com')
    expect(a.url).not.toContain(TOKEN)
    expect(a.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  }
  noToken(said)
})

test('Issue detail: whom a blocker is with, and the requests for what a closed issue blocks, carry no token', GH, async ($, on) => {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const ask = (body: unknown) => (url: string, h: Record<string, string>) => {
    asked.push({ url, headers: h })
    return json(200, body)
  }
  // The open issues come with GitHub's dependency summary: dependencies are on.
  const listed = { ...issue(14), issue_dependencies_summary: { blocked_by: 1, blocking: 1 } }
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues': url => json(200, new URL(url).searchParams.has('assignee') ? [] : [listed]),
      '/repos/boats/radar/issues/14': (_url, _h, method) => (method === 'GET' ? json(200, { ...listed, state: 'closed' }) : null),
      '/repos/boats/radar/issues/14/dependencies/blocked_by': ask([{ ...issue(24), assignees: [person(`anna-${TOKEN}`, 501)] }]),
      '/repos/boats/radar/issues/14/dependencies/blocking': ask([issue(31)]),
      '/repos/boats/radar/issues/24/dependencies/blocked_by': ask([]),
      '/repos/boats/radar/issues/31/dependencies/blocked_by': ask([]),
    },
  })
  const ui = await shown($)
  await ui.press({ key: 'pick-14' })
  said.push(...(await texts(ui)))

  expect(said.some(s => s.trim() === 'anna-<token>')).toBe(true)
  // #14 is closed: whether #31 still waits is asked, of GitHub's API host with the token.
  expect(asked.some(a => a.url.includes('/issues/31/dependencies/blocked_by'))).toBe(true)
  for (const a of asked) {
    expect(new URL(a.url).host).toBe('api.github.com')
    expect(a.url).not.toContain(TOKEN)
    expect(a.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  }
  noToken(said)
})

test("Issue detail: a child under Children, and whom it is with, carry no token", GH, async ($, on) => {
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues/14/sub_issues': () => json(200, [{ ...issue(30, `Rotate ${TOKEN}`), assignees: [person(`anna-${TOKEN}`, 501)] }]),
    },
  })
  const ui = await shown($)
  await ui.press({ key: 'pick-14' })
  said.push(...(await texts(ui)))

  expect(said).toContain('Children   ')
  expect(said.some(s => s.includes('Rotate <token>'))).toBe(true)
  expect(said.some(s => s.trim() === 'anna-<token>')).toBe(true)
  noToken(said)
})

test('Prompt: the prompt it drafts, its toast and the Debug counter carry no token, even from an issue that names it', GH, async ($, on) => {
  const said = world(on, { title: `Rotate ${TOKEN}` })
  const ui = await shown($)
  await ui.press({ key: 'pick-14' })
  await ui.press({ key: 'prompt' })
  said.push(...(await texts(ui)))

  expect(said.some(s => s.startsWith('Work on #14: Rotate <token>'))).toBe(true)
  expect(said.some(s => s.startsWith('#14 is yours and in the prompt'))).toBe(true)
  // The Debug counter, named after the action.
  expect(said.some(s => /^↯ .+: \d+ requests$/.test(s))).toBe(true)
  noToken(said)
})

test('Epics: a sub-issue unfolded in the tree, and the Debug counter after, carry no token', GH, async ($, on) => {
  const epic = { ...issue(20, 'Radar sweep'), labels: [{ name: 'epic', color: '' }] }
  const said = world(on, {
    answers: {
      '/repos/boats/radar/issues': url => (url.includes('labels=') ? json(200, [epic]) : null),
      '/repos/boats/radar/issues/20/sub_issues': () =>
        json(200, [{ ...issue(14), sub_issues_summary: { total: 1, completed: 0, percent_completed: 0 } }]),
      '/repos/boats/radar/issues/14/sub_issues': () => json(200, [issue(30, `Rotate ${TOKEN}`)]),
    },
  })
  await $.command.run(RUN)
  const ui = (await $.ui.mount({ ...PANE, requestId: 'next-epics', surface: 'terminal' })) as Ui
  await ui.press({ key: 'fold-20' })
  await ui.press({ key: 'fold-14' })
  said.push(...(await texts(ui)))

  expect(said.some(s => s.includes('#30 Rotate <token>'))).toBe(true)
  expect(said.some(s => s.startsWith('↯ #14'))).toBe(true)
  noToken(said)
})

test('Milestones: a sub-issue in the tree of a milestone detail carries no token', GH, async ($, on) => {
  const m = { number: 1, title: 'v1', description: '', html_url: 'https://github.com/boats/radar/milestone/1', due_on: null, open_issues: 1, closed_issues: 0, state: 'open' }
  const epic = { ...issue(20, 'Radar sweep'), labels: [{ name: 'epic', color: '' }], milestone: m }
  const said = world(on, {
    answers: {
      '/repos/boats/radar/milestones': url => (url.includes('state=closed') ? json(200, []) : json(200, [m])),
      '/repos/boats/radar/issues': url => (url.includes('labels=') ? json(200, [epic]) : url.includes('assignee=') ? json(200, []) : json(200, [epic])),
      '/repos/boats/radar/issues/20/sub_issues': () => json(200, [issue(30, `Rotate ${TOKEN}`)]),
    },
  })
  await $.command.run(RUN)
  const ui = (await $.ui.mount({ ...PANE, requestId: 'next-milestones', surface: 'terminal' })) as Ui
  await ui.press({ key: 'milestone-v1' })
  await ui.press({ key: 'fold-20' })
  said.push(...(await texts(ui)))

  expect(said.some(s => s.includes('#30 Rotate <token>'))).toBe(true)
  noToken(said)
})

test('withoutToken: answers and errors of every kind lose the token', async () => {
  const t = 'glpat-abcdefgh12345678'
  const raw = {
    name: 'GitLab',
    tokensUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    check: async () => ({ version: null, setup: { kind: 'error', message: `refused ${t}` } }),
    mine: async () => [{ number: 1, title: `about ${t}`, labels: [`l-${t}`] }],
    close: async () => `refused: PRIVATE-TOKEN: ${t}`,
    open: async () => {
      throw new Error(`whats-next: $.http.fetch: ${t} and ${t}`)
    },
  } as unknown as Tracker
  const sealed = withoutToken(raw, t)

  expect(sealed.name).toBe('GitLab')
  expect(sealed.tokensUrl).toBe(raw.tokensUrl)
  expect(await sealed.check()).toEqual({ version: null, setup: { kind: 'error', message: 'refused <token>' } })
  expect(await sealed.mine()).toEqual([{ number: 1, title: 'about <token>', labels: ['l-<token>'] }])
  expect(await sealed.close(1, true)).toBe('refused: PRIVATE-TOKEN: <token>')
  await expect(sealed.open()).rejects.toThrow('<token> and <token>')
})

// A token goes only to its own host.

test('GitHub: a next page on another host is not asked for, and the list fails', async () => {
  const asked: { url: string; auth: string | undefined }[] = []
  const send = (async (url: string, init?: { headers?: Record<string, string> }) => {
    asked.push({ url, auth: init?.headers?.Authorization })
    const first = asked.length === 1
    return { status: 200, ok: true, headers: first ? { link: '<https://evil.example/repos/boats/radar/issues?page=2>; rel="next"' } : {}, text: '[]' }
  }) as unknown as Send
  const t = github(send, { host: 'github.com', owner: 'boats', name: 'radar' }, TOKEN, null)

  await expect(t.open()).rejects.toThrow('the next page is not on api.github.com')
  expect(asked.map(a => new URL(a.url).host)).toEqual(['api.github.com'])
})

// Every token setting filled, with bare tokens and host=token pairs. Each
// host gets only the token meant for it; a host that runs no forge What's
// Next knows gets none, and detecting the forge sends none.
const ALL = {
  token: 'fj-bare git.example.org=fj-pair',
  gitlabComToken: 'gl-com',
  gitlabTokens: 'gl-private',
  githubTokens: 'gh-bare github.com=gh-pair',
  icons: 'text',
  compact: 'off',
}
const SECRETS = ['fj-bare', 'fj-pair', 'gl-com', 'gl-private', 'gh-bare', 'gh-pair']

for (const [origin, want] of [
  ['git@git.example.org:boats/radar.git', { 'git.example.org': 'token fj-pair' }],
  ['git@forge.example.net:boats/radar.git', { 'forge.example.net': 'token fj-bare' }],
  ['git@gitlab.com:boats/radar.git', { 'gitlab.com': 'gl-com' }],
  ['git@gitlab.example.org:boats/radar.git', { 'gitlab.example.org': 'gl-private' }],
  ['git@github.com:boats/radar.git', { 'api.github.com': 'Bearer gh-pair' }],
  ['git@ghe.example.org:boats/radar.git', { 'ghe.example.org': 'Bearer gh-bare' }],
  ['git@nothing.example.org:boats/radar.git', {}],
] as const) {
  test(`only its own token goes to ${origin.slice(4, origin.indexOf(':'))}`, { options: ALL }, async ($, on) => {
    mock.clock(on)
    const sent: { host: string; path: string; auth: string[] }[] = []
    on('process.run', (_$, e) => {
      const cmd = e.argv.join(' ')
      const stdout = cmd === 'git remote get-url origin' ? origin : cmd === 'pwd' ? '/Users/jdoe/dev/radar' : 'true'
      return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('http.fetch', (_$, e) => {
      const u = new URL(e.url)
      const headers = (e.init?.headers ?? {}) as Record<string, string>
      const auth = [headers.Authorization, headers['PRIVATE-TOKEN']].filter((v): v is string => !!v && v !== 'token ' && v !== 'Bearer ')
      sent.push({ host: u.host, path: u.pathname, auth })
      const reply = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })
      const forgejo = u.host === 'git.example.org' || u.host === 'forge.example.net'
      if (u.pathname === '/api/v1/version') return forgejo ? reply(200, { version: '12.0.1+gitea-1.22.0' }) : reply(404, {})
      if (u.pathname === '/api/v4/version') return u.host === 'gitlab.example.org' ? reply(200, { version: '17.4.0' }) : reply(404, {})
      if (u.pathname === '/api/v3/meta') return u.host === 'ghe.example.org' ? reply(200, { installed_version: '3.12.4' }) : reply(404, {})
      // Past detection, every forge refuses the token: setup stops there.
      return reply(401, { message: 'Unauthorized' })
    })

    await $.command.run(RUN)
    await $.ui.mount({ ...PANE, surface: 'terminal' })

    const authed = sent.filter(s => s.auth.length > 0)
    for (const s of authed) expect({ host: s.host, auth: s.auth }).toEqual({ host: s.host, auth: [want[s.host as keyof typeof want]] })
    expect(new Set(authed.map(s => s.host))).toEqual(new Set(Object.keys(want)))
    // Detection asks without a token.
    expect(sent.filter(s => /^\/api\/(v1\/version|v4\/version|v3\/meta)$/.test(s.path)).every(s => s.auth.length === 0)).toBe(true)
    // No other setting's token anywhere.
    const others = SECRETS.filter(x => !Object.values(want).some(v => v.endsWith(x)))
    expect(sent.flatMap(s => s.auth).filter(a => others.some(x => a.includes(x)))).toEqual([])
  })
}

test("setup: an origin with credentials in it is shown without them", GH, async ($, on) => {
  const said = world(on, { origin: `https://oauth2:${TOKEN}@github.com` })
  const ui = await shown($)
  said.push(...(await texts(ui)))

  expect(said.some(s => s.includes('origin is https://github.com, which names no host'))).toBe(true)
  noToken(said)
})

// Tokens come only from the token settings.

test('no environment variable and no file of another tool is read for a token', { options: { icons: 'text', compact: 'off' } }, async ($, on) => {
  const envRead: string[] = []
  const filesRead: string[] = []
  const auth: string[] = []
  mock.clock(on)
  on('process.run', (_$, e) => {
    const stdout = e.argv.join(' ') === 'git remote get-url origin' ? 'git@github.com:boats/radar.git' : 'true'
    return { value: { exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => {
    envRead.push(e.name)
    return { value: 'from-env' }
  })
  on('fs.read', (_$, e) => {
    filesRead.push(e.path)
    return e.path.endsWith('/.claude-plugin/plugin.json') ? { value: '{"version":"9.8.7"}' } : { value: 'oauth_token: from-file' }
  })
  on('http.fetch', (_$, e) => {
    const h = (e.init?.headers ?? {}) as Record<string, string>
    for (const v of [h.Authorization, h['PRIVATE-TOKEN']]) if (v) auth.push(v)
    return { value: { status: 401, ok: false, headers: {}, text: '{"message":"Requires authentication"}' } }
  })
  const ui = await shown($)

  expect(await texts(ui)).toContain('✗ Token   none found')
  expect(envRead).toEqual([])
  expect(filesRead.every(p => p.endsWith('/.claude-plugin/plugin.json') || p.endsWith('/plugin.json'))).toBe(true)
  expect(auth.filter(a => a.includes('from-'))).toEqual([])
})
