import { expect, test } from 'claude-code/testing'
import type { ConfigRow } from 'claude-code'

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

function row(field: string, label: string, value: string): ConfigRow {
  return { key: `fj.${field}`, label, kind: 'text', value, provider: { plugin: 'fj', tier: 'core' }, isLocked: false }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the settings screen edits fj's settings through /config on ${surface}`, async ($, on) => {
    const set: { key: string; value: unknown }[] = []
    on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: undefined }))
    on('config.list', () => ({
      value: [
        row('label', 'Epic label', 'epic'),
        row('login', 'Login', ''),
        { ...row('x', 'Theme', 'dark'), key: 'theme' },
      ],
    }))
    on('config.set', (_$, e) => {
      set.push({ key: e.key, value: e.value })
      return { value: e.value }
    })

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'settings' })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain("This session lists 2 of fj's settings.")
    expect(texts).toContain('childrenHeading: not offered to this session')
    expect(texts).toContain('Token: none found')

    await ui.input({ key: 'cfg-login', text: ' alice ' })
    expect(set).toEqual([{ key: 'fj.login', value: 'alice' }])

    await ui.press({ key: 'back' })
    await expect(ui.find({ key: 'settings' })).resolves.toBeDefined()
  })
}

test('a refused setting says why', async ($, on) => {
  const toasts: string[] = []
  on('env.get', { name: 'FORGEJO_TOKEN' }, () => ({ value: 'x' }))
  on('config.list', () => ({ value: [row('login', 'Login', '')] }))
  on('config.set', () => ({ deny: 'managed by your organization' }))
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'settings' })
  await expect(ui.find({ text: 'Token: from FORGEJO_TOKEN' })).resolves.toBeDefined()
  await ui.input({ key: 'cfg-login', text: 'alice' })

  expect(toasts).toEqual(['Not saved: managed by your organization'])
})
