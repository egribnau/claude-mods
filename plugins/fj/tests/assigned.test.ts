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
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

type Extra = { milestone?: number; due?: string; labels?: string[] }

function issue(number: number, repo: string, created: string, extra: Extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: '',
    created_at: created,
    due_date: extra.due ? `${extra.due}T00:00:00Z` : null,
    milestone: extra.milestone ? { id: extra.milestone } : null,
    labels: (extra.labels ?? []).map(name => ({ name })),
    repository: { full_name: repo },
  }
}

type World = { found: unknown[]; branch?: string; pulls?: unknown[]; asked?: string[]; status?: (string | undefined)[] }

function forgejo(on: On, w: World) {
  on('process.run', (_$, e) => {
    const isBranch = e.argv.join(' ') === 'git branch --show-current'
    const stdout = isBranch ? `${w.branch ?? 'main'}\n` : 'ssh://git@git.example.org:2222/boats/radar.git\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'secret' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    w.status?.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', (_$, e) => {
    w.asked?.push(e.url)
    const url = new URL(e.url)
    const page = url.searchParams.get('page')
    const body = url.pathname.endsWith('/repos/issues/search')
      ? page === '1'
        ? w.found
        : []
      : url.pathname.endsWith('/pulls')
        ? (w.pulls ?? [])
        : url.pathname.endsWith('/milestones')
          ? [{ id: 2, title: 'v1', state: 'open' }]
          : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
}

// The rows under `Assigned to you`, as `<mark> <title> #<n>`.
async function mineRows(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const start = texts.findIndex(t => t.startsWith('── Assigned to you'))
  const end = texts.findIndex((t, i) => i > start && t.startsWith('── '))
  const rows: string[] = []
  for (let i = start + 1; i < end; i += 2) rows.push(`${texts[i]}${texts[i + 1] ?? ''}`)
  return rows
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`ranks my issues in this repo on ${surface}`, async ($, on) => {
    const asked: string[] = []
    forgejo(on, {
      asked,
      found: [
        issue(40, 'boats/radar', '2026-09-20T10:00:00Z', { milestone: 2 }),
        issue(3, 'boats/other', '2026-01-01T10:00:00Z'),
        issue(12, 'boats/radar', '2026-08-01T10:00:00Z'),
        issue(55, 'boats/radar', '2026-10-01T10:00:00Z', { milestone: 2, due: '2026-10-05' }),
        issue(60, 'boats/radar', '2026-07-01T10:00:00Z', { labels: ['epic'] }),
      ],
    })

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    // In the milestone with a due date, in the milestone, then the oldest.
    expect(await mineRows(ui)).toEqual(['▸ Issue 55 #55', '  Issue 40 #40', '  Issue 12 #12'])
    await expect(ui.find({ text: /Issue (3|60)\b/ })).resolves.toBeUndefined()
    expect(asked).toContainEqual(
      expect.stringMatching(/^https:\/\/git\.example\.org\/api\/v1\/repos\/issues\/search\?assigned=true&state=open/),
    )
  })
}

test('the current branch and open PRs mark issues in progress', async ($, on) => {
  const status: (string | undefined)[] = []
  forgejo(on, {
    status,
    branch: 'feature/40-radar',
    pulls: [{ number: 61, body: 'Some work.\n\nCloses #12', head: { ref: 'docs' } }],
    found: [
      issue(40, 'boats/radar', '2026-09-20T10:00:00Z'),
      issue(12, 'boats/radar', '2026-08-01T10:00:00Z'),
      issue(55, 'boats/radar', '2026-10-01T10:00:00Z'),
      issue(70, 'boats/radar', '2026-10-02T10:00:00Z'),
    ],
  })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await mineRows(ui)).toEqual(['⎇ Issue 40 #40', '⎇ Issue 12 #12', '▸ Issue 55 #55', '  Issue 70 #70'])
  expect(status.at(-1)).toBe('fj on #40 · next #55')
})

test('more issues than fit end in a count', async ($, on) => {
  forgejo(on, {
    found: Array.from({ length: 9 }, (_, k) => issue(100 + k, 'boats/radar', `2026-09-0${k + 1}T10:00:00Z`)),
  })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // 24 rows: a quarter is 6, so 5 issues and the count.
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('  +4 more')
  await expect(ui.find({ key: 'mine-104' })).resolves.toBeDefined()
  await expect(ui.find({ key: 'mine-105' })).resolves.toBeUndefined()
})

test('says so when nothing is assigned', async ($, on) => {
  const status: (string | undefined)[] = []
  forgejo(on, { status, found: [issue(3, 'boats/other', '2026-01-01T10:00:00Z')] })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'Nothing assigned to you.' })).resolves.toBeDefined()
  expect(status.at(-1)).toBeUndefined()
})
