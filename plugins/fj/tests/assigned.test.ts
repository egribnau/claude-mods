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
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

function issue(number: number, repo: string, created: string) {
  return { number, title: `Issue ${number}`, state: 'open', body: '', created_at: created, repository: { full_name: repo } }
}

function forgejo(on: On, found: unknown[], asked: string[]) {
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'ssh://git@git.example.org:2222/boats/radar.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'secret' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    const isSearch = e.url.includes('/repos/issues/search')
    const page = new URL(e.url).searchParams.get('page')
    // Only the search answers; the milestones and epics come back empty.
    const body = isSearch && page === '1' ? found : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows the oldest issue in this repo assigned to me on ${surface}`, async ($, on) => {
    const asked: string[] = []
    forgejo(
      on,
      [
        issue(40, 'boats/radar', '2026-09-20T10:00:00Z'),
        issue(3, 'boats/other', '2026-01-01T10:00:00Z'),
        issue(12, 'boats/radar', '2026-08-01T10:00:00Z'),
        issue(55, 'boats/radar', '2026-10-01T10:00:00Z'),
      ],
      asked,
    )

    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...PANE, surface })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toMatch(/^── Assigned to you ─+$/)
    expect(texts[1]).toBe('Issue 12 #12')
    expect(texts.indexOf('no milestones')).toBeGreaterThan(0)
    expect(texts.indexOf('Issue 12 #12')).toBeLessThan(texts.indexOf('no milestones'))
    await expect(ui.find({ text: /Issue 3\b/ })).resolves.toBeUndefined()
    expect(asked).toContainEqual(
      expect.stringMatching(
        /^https:\/\/git\.example\.org\/api\/v1\/repos\/issues\/search\?assigned=true&state=open/,
      ),
    )
  })
}

test('says so when nothing is assigned', async ($, on) => {
  forgejo(on, [issue(3, 'boats/other', '2026-01-01T10:00:00Z')], [])

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await expect(ui.find({ text: 'Nothing assigned to you.' })).resolves.toBeDefined()
})
