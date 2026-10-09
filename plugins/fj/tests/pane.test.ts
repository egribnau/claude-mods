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
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

type World = {
  remote?: string | null
  env?: string | null
  status?: number
  opened?: unknown[]
  asked?: { url: string; auth: string | undefined }[]
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
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: w.env === undefined ? 'secret' : (w.env ?? undefined) }))
  on('ui.open', (_$, e) => {
    w.opened?.push(e)
    return { value: { isPlaced: true } }
  })
  on('http.fetch', (_$, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.asked?.push({ url: e.url, auth: headers.Authorization })
    const status = w.status ?? 200
    const body = status === 200 ? { full_name: 'boats/radar', open_issues_count: 7 } : {}
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/fj opens the pane on the repo behind origin on ${surface}`, async ($, on) => {
    const opened: unknown[] = []
    const asked: World['asked'] = []
    world(on, { opened, asked })

    const out = await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)

    expect(opened).toEqual([expect.objectContaining({ id: 'fj', title: 'fj · boats/radar' })])
    expect(asked).toEqual([{ url: 'https://git.example.org/api/v1/repos/boats/radar', auth: 'token secret' }])
    expect(texts).toContain('Repo: boats/radar on git.example.org')
    expect(texts).toContain('Token: from FORGEJO_TOKEN')
    expect(texts).toContain('Connected · 7 open issues')
    expect(out).toEqual(expect.objectContaining({ text: 'fj opened for boats/radar (token: FORGEJO_TOKEN).' }))
  })
}

for (const remote of ['git@git.example.org:boats/radar.git', 'https://git.example.org/boats/radar', 'ssh://git@git.example.org/boats/radar.git']) {
  test(`reads the repo from ${remote}`, async ($, on) => {
    const asked: World['asked'] = []
    world(on, { remote, asked })

    await $.command.run(RUN)

    expect(asked[0]?.url).toBe('https://git.example.org/api/v1/repos/boats/radar')
  })
}

test('the Token setting goes before FORGEJO_TOKEN', { options: { token: 'from-config' } }, async ($, on) => {
  const asked: World['asked'] = []
  world(on, { asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(asked[0]?.auth).toBe('token from-config')
  await expect(ui.find({ text: 'Token: from the Token setting' })).resolves.toBeDefined()
})

test('says so when there is no origin', async ($, on) => {
  const asked: World['asked'] = []
  world(on, { remote: null, asked })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'no git remote "origin" here' })).resolves.toBeDefined()
  expect(asked).toEqual([])
})

test('says so when there is no token', async ($, on) => {
  world(on, { env: null })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'Token: none found' })).resolves.toBeDefined()
  await expect(ui.find({ text: /^no token: / })).resolves.toBeDefined()
})

test('shows what Forgejo answered when it refuses', async ($, on) => {
  world(on, { status: 404 })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'boats/radar: HTTP 404' })).resolves.toBeDefined()
})

test('Refresh checks again', async ($, on) => {
  const w: World = { status: 500, asked: [] }
  world(on, w)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await expect(ui.find({ text: 'boats/radar: HTTP 500' })).resolves.toBeDefined()

  w.status = 200
  await ui.press({ key: 'refresh' })

  await expect(ui.find({ text: 'Connected · 7 open issues' })).resolves.toBeDefined()
  expect(w.asked).toHaveLength(2)
})
