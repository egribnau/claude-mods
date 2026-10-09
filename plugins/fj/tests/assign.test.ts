import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'epics',
  props: {
    title: 'Epics',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type Sent = { method: string; url: string; body?: unknown }

// One epic, #50, assigned to `assignees`; a PATCH replaces them.
function forgejo(on: On, sent: Sent[], assignees: string[], user: 'ok' | 'forbidden' = 'forbidden') {
  let now = [...assignees]
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'git@git.example.org:boats/radar.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'secret' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    sent.push({ method, url: e.url, body })
    const url = new URL(e.url)
    if (url.pathname.endsWith('/api/v1/user')) {
      return user === 'ok'
        ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ login: 'alice' }) } }
        : { value: { status: 403, ok: false, headers: {}, text: '{}' } }
    }
    if (method === 'PATCH') now = body.assignees
    const issue = {
      number: 50,
      title: 'E1 — Epic',
      state: 'open',
      body: '',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      comments: 0,
      user: { login: 'someone' },
      labels: [],
      milestone: { title: 'v1' },
      assignees: now.map(login => ({ login })),
    }
    const answer = /\/issues\/50$/.test(url.pathname)
      ? issue
      : url.pathname.endsWith('/milestones')
        ? [{ id: 1, title: 'v1', state: 'open' }]
        : url.searchParams.has('labels')
          ? [issue]
          : url.pathname.endsWith('/issues/search')
            ? []
            : url.searchParams.get('page') === '1'
              ? [issue]
              : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`assigns the selected issue to the login set in config on ${surface}`, { options: { login: 'alice' } }, async ($, on) => {
    const sent: Sent[] = []
    forgejo(on, sent, ['maria'])

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'pick-50' })
    await ui.press({ key: 'assign' })

    expect(sent.filter(s => s.method === 'PATCH')).toEqual([
      { method: 'PATCH', url: 'https://git.example.org/api/v1/repos/boats/radar/issues/50', body: { assignees: ['maria', 'alice'] } },
    ])
    expect(sent.some(s => s.url.endsWith('/api/v1/user'))).toBe(false)
    await expect(ui.find({ text: 'Assigned to you.' })).resolves.toBeDefined()
    await expect(ui.find({ key: 'assign' })).resolves.toBeUndefined()
  })
}

test('asks Forgejo who you are when no login is set', async ($, on) => {
  const sent: Sent[] = []
  forgejo(on, sent, [], 'ok')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'pick-50' })
  await ui.press({ key: 'assign' })

  expect(sent.find(s => s.method === 'PATCH')?.body).toEqual({ assignees: ['alice'] })
})

test('says why when it cannot tell who you are', async ($, on) => {
  const sent: Sent[] = []
  const toasts: string[] = []
  forgejo(on, sent, [])
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'pick-50' })
  await ui.press({ key: 'assign' })

  expect(sent.some(s => s.method === 'PATCH')).toBe(false)
  expect(toasts).toEqual([
    'Not assigned: who you are is unknown: set Login under fj in /config, or give FORGEJO_TOKEN read:user',
  ])
})
