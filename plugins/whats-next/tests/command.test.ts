import { expect, test } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'

const START = { cwd: '/Users/jdoe/Documents/notes', surface: 'terminal', isInteractive: true } as const

const RUN = {
  command: 'whats-next',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 170 },
} as const

type Seen = { registered: string[]; toasts: string[] }

// A session outside any git repo, whose command list answers `commands`
// (undefined: the engine's own list).
function world(on: On, commands?: CommandInfo[]): Seen {
  const seen: Seen = { registered: [], toasts: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  if (commands) on('command.list', () => ({ value: commands }))
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const out =
      e.argv.join(' ') === 'pwd'
        ? { exitCode: 0, stdout: '/Users/jdoe/Documents/notes\n', stderr: '' }
        : { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return seen
}

test('/next is registered', async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  expect(seen.registered).toEqual(['next'])
  expect(seen.toasts).toEqual([])
})

test("a next of What's Next's own, from before a reload, is not taken", async ($, on) => {
  const seen = world(on, [{ name: 'next', description: '', source: 'plugin', plugin: 'whats-next@egribnau-mods' }])
  await $.session.start(START)
  expect(seen.registered).toEqual(['next'])
  expect(seen.toasts).toEqual([])
})

test('with /next taken by another plugin, /whats-next is registered and runs', async ($, on) => {
  const seen = world(on, [{ name: 'next', description: 'Next slide', source: 'plugin', plugin: 'slides@elsewhere' }])
  await $.session.start(START)
  expect(seen.registered).toEqual(['whats-next'])
  expect(seen.toasts).toEqual(["/next is taken by another command: What's Next is /whats-next in this session."])
  const out = await $.command.run(RUN)
  expect(out).toEqual(expect.objectContaining({ text: "What's Next needs setting up: see its pane." }))
})

test('/whats-next names itself when it does not know a word', async ($, on) => {
  world(on, [{ name: 'next', description: '', source: 'user' }])
  await $.session.start(START)
  const out = await $.command.run({ ...RUN, args: 'milestones' })
  expect(out).toEqual(
    expect.objectContaining({ text: `/whats-next does not know "milestones". Try /whats-next for What's next in front, or /whats-next epics (or e) for Epics.` }),
  )
})
