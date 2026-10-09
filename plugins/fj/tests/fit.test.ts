import { expect, test } from 'claude-code/testing'

// 12 rows: 2 for assigned, 6 for the detail, 4 for the milestone, of which
// 2 are its rule and picker, leaving 2 lines for a list far longer.
const PANE = {
  plugin: 'fj',
  component: 'Pane',
  requestId: 'epics',
  props: {
    title: 'Epics',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const RUN = {
  command: 'fj',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const KIDS = Array.from({ length: 30 }, (_, i) => 200 + i)
const EPIC = {
  number: 100,
  title: 'E1 — A title long enough that it would wrap onto a second row at forty columns',
  state: 'open',
  body: ['## Children', ...KIDS.map(n => `- [ ] #${n} child`)].join('\n'),
}

test('the three parts fit a short pane and the selected issue stays in view', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'git@git.example.org:boats/radar.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'secret' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const one = /\/issues\/(\d+)$/.exec(url.pathname)
    const body = one
      ? { number: Number(one[1]), title: `Child ${one[1]}`, state: 'open', body: '', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', comments: 0, user: { login: 'alice' }, labels: [], milestone: null, assignees: [] }
      : url.pathname.endsWith('/milestones')
        ? [{ id: 1, title: 'v1', state: 'open' }]
        : url.searchParams.has('labels')
          ? [EPIC]
          : url.pathname.endsWith('/issues/search')
            ? []
            : url.searchParams.get('page') === '1'
              ? KIDS.map(n => ({ number: n, title: `Child ${n}`, state: 'open' }))
              : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-100' })

  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const all = await texts()
  for (const name of ['Assigned to you', 'Milestone', 'Detail']) {
    expect(all.some(t => t.startsWith(`── ${name} `))).toBe(true)
  }
  expect(all.every(t => t.length <= 40)).toBe(true)
  expect((await ui.find({ key: 'pick-100' }))?.text).toMatch(/…\s*#100$/)
  // 31 lines, one row for them and one for the controls.
  expect(all).toContain(' 0 above · 30 below')
  await ui.press({ key: 'up' })
  expect(await texts()).toContain(' 0 above · 30 below')

  // Scrolled to the end, the last child can be selected.
  for (let i = 0; i < 40; i++) await ui.press({ key: 'down' })
  expect(await texts()).toContain(' 30 above · 0 below')
  expect(await ui.find({ key: 'pick-100' })).toBeUndefined()
  await ui.press({ key: 'pick-100-229' })
  expect((await texts()).filter(t => t === 'Child 229 #229')).toHaveLength(2)
})
