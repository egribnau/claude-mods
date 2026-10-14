import { atom, read } from 'claude-code'
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { Repo, Setup } from '../../types'
import { ICON } from '../draw'
import { slug, type Tracker } from '../tracker'
import type { Frame, Pane } from './frame'

// The state this view reads (the contract in types/index.d.ts).
const repo = atom({ plugin: 'whats-next', key: 'repo' } as const, null)
const version = atom({ plugin: 'whats-next', key: 'version' } as const, null)
const token = atom({ plugin: 'whats-next', key: 'token' } as const, null)
const setup = atom({ plugin: 'whats-next', key: 'setup' } as const, { kind: 'checking' })
const overview = atom({ plugin: 'whats-next', key: 'overview' } as const, { kind: 'idle' })

// Setup: each step checked, and what to do about the one that failed; once
// it passes, the one-time Icons and Compact choices.

type Step = 'repo' | 'forge' | 'token' | 'access' | 'actions'
const STEPS: readonly Step[] = ['repo', 'forge', 'token', 'access', 'actions']
const LABEL: Record<Step, string> = { repo: 'Repo', forge: 'Forge', token: 'Token', access: 'Access', actions: 'Actions' }

// The step each outcome stopped at; `ready` is past them all.
const STOPPED_AT: Record<Setup['kind'], number> = {
  checking: -1,
  'no-repo': 0,
  'not-forgejo': 1,
  'no-token': 2,
  'token-refused': 3,
  'no-scope': 3,
  'not-found': 3,
  error: 3,
  ready: 5,
}

// What the pane says about the step that failed, before what to do. `v`:
// the forge, as the Forge step names it; `t`: the tracker, once there is a
// repo.
function intro(s: Setup, r: Repo | null, t: Tracker | null, v: string | null, tokenText: string): string | null {
  const name = t?.name ?? 'Forgejo'
  const what = "What's Next shows the issues of the repo this session runs in."
  switch (s.kind) {
    case 'no-repo':
      return s.reason === 'not-git'
        ? `${what} ${s.dir} is not a git repo, so there is nothing to show here.`
        : s.reason === 'no-origin'
          ? `${what} This repo has no remote origin.`
          : `${what} origin is ${s.origin}, which names no host.`
    case 'token-refused':
      return `${name} did not accept the token ${tokenText}: it may be mistyped, expired or revoked.`
    case 'no-scope':
      return s.missing === 'read_api'
        ? `The token ${tokenText} may not read ${r ? slug(r) : 'the repo'}: What's Next needs read_api.`
        : s.missing === 'Issues'
          ? `The token ${tokenText} reads ${r ? slug(r) : 'the repo'}, but not its issues: What's Next needs the Issues permission.`
          : s.missing
          ? `The token ${tokenText} reads ${r ? slug(r) : 'the repo'}, but not who it belongs to: What's Next needs ${s.missing} too.`
          : `The token ${tokenText} is valid but may not read this repo.`
    case 'not-found':
      return `${r ? slug(r) : 'The repo'}, from origin, was not found, or the token's owner cannot see it.`
    case 'error':
      return `${name} could not be asked: ${s.message}.`
    case 'not-forgejo': {
      const host = r?.host ?? 'This host'
      return s.reason === 'no-answer'
        ? `${host} did not answer (${s.detail}). Check that https://${host} opens from this computer.`
        : s.reason === 'too-old'
          ? `What's Next needs Forgejo or Gitea 1.19 or newer, the first with scoped tokens (read:issue, read:repository, read:user). ${host} runs ${s.detail}.`
          : `${host} does not answer as Forgejo, Gitea, GitLab or GitHub Enterprise (${s.detail}). What's Next has nothing to show for this repo.`
    }
    default:
      return null
  }
}

// What to do about the step that failed, one line per action.
// `t`: the tracker, which says where it makes tokens, once there is a repo;
// `configure`: the command that sets a token.
function todo(s: Setup, r: Repo | null, t: Tracker | null, configure: string): string[] {
  const page = t?.tokensUrl ?? 'Settings › Applications in Forgejo'
  const create = `Create a token at ${page} with ${t?.scopes ?? 'write:issue, read:repository and read:user; read:issue instead of write:issue is read only'}.`
  const host = r?.host ?? 'your-forge'
  // GitLab has a setting per kind of host, so no host=token hint there.
  const set = [
    t?.name === 'GitLab'
      ? `Run \`${configure}\` and paste it as ${t.setting}.`
      : `Run \`${configure}\` and paste it as ${t?.setting ?? 'Forgejo tokens'}, alone or as \`${host}=<token>\` next to tokens for other hosts.`,
  ]
  switch (s.kind) {
    case 'no-repo': {
      const remote = 'https://your-forge/owner/repo.git'
      return [
        s.reason === 'not-git'
          ? `If this folder belongs on a forge: \`git init\` and \`git remote add origin ${remote}\`, then press r.`
          : s.reason === 'no-origin'
            ? `If this repo is on a forge: \`git remote add origin ${remote}\`, then press r.`
            : `If this repo is on a forge: \`git remote set-url origin ${remote}\`, then press r.`,
      ]
    }
    case 'not-forgejo':
      return []
    case 'no-token':
      return [create, ...set]
    case 'token-refused':
    case 'no-scope':
      return [create, ...set]
    case 'not-found':
      return [
        `If origin points to the wrong repo: \`git remote set-url origin https://${host}/owner/repo.git\`.`,
        t?.name === 'GitHub'
          ? "If the repo is private, create the token as a user who can see it; a fine-grained token also needs it among its repositories."
          : 'If the repo is private, create the token as a user who can see it.',
        ...set,
      ]
    case 'error':
      return []
    default:
      return []
  }
}

// Setup's steps, each a line: ✓ and what it found, ✗ and why, or · when
// not reached.
async function stepsOf($: EngineInterface, p: Pane) {
  const { draw: d } = p
  const t = p.tracker
  const r = await read($, repo)
  const v = await read($, version)
  // Older code kept a word here: that counts as none found.
  const held = await read($, token)
  const from = held && typeof held === 'object' ? held : null
  const s = await read($, setup)
  const tokenText = from ? `${from.host ? `for ${from.host} ` : ''}from ${from.setting}` : 'none found'
  const doneText: Record<Step, string> = {
    repo: r ? slug(r) : '',
    forge: v && r ? `${v} at ${r.host}` : '',
    token: tokenText,
    access: s.kind === 'ready' ? `${s.openIssues} open issues, as ${s.login}` : '',
    actions: 'assign and close',
  }
  const failText: Record<Step, string> = {
    repo: 'no repo here',
    forge:
      s.kind === 'not-forgejo' && s.reason === 'no-answer'
        ? `no answer from ${r?.host ?? 'this host'}`
        : s.kind === 'not-forgejo' && s.reason === 'too-old'
          ? `${s.detail}, too old`
          : `no known forge at ${r?.host ?? 'this host'}`,
    token: 'none found',
    actions: '',
    access:
      s.kind === 'token-refused'
        ? 'token refused'
        : s.kind === 'no-scope'
          ? s.missing ? `no ${s.missing}` : 'no permission'
          : s.kind === 'not-found'
            ? 'not found'
            : 'no answer',
  }
  const at = STOPPED_AT[s.kind]
  // Without a repo, or on a Forgejo too old, the token is still checked: it
  // needs no answer from the forge. The steps that do say so; the token too,
  // where What's Next has no setting for the forge or knows none.
  const noRepo = s.kind === 'no-repo'
  const noForge = s.kind === 'not-forgejo'
  const tokenChecked = noRepo || (s.kind === 'not-forgejo' && s.reason === 'too-old')
  const steps = STEPS.map((step, i) => {
    const mark =
      s.kind === 'checking'
        ? '…'
        : noForge && !tokenChecked && step === 'token'
          ? '·'
          : tokenChecked && step === 'token'
            ? from ? '✓' : '✗'
            : i < at ? '✓' : i === at ? '✗' : '·'
    const color = mark === '✓' ? 'success' : mark === '✗' ? 'error' : 'inactive'
    const text =
      mark === '✓'
        ? doneText[step]
        : mark === '✗'
          ? failText[step]
          : noRepo
            ? 'needs a repo'
            : noForge
              ? 'needs a forge'
              : ''
    // Actions that cannot be done are no failure: setup passes, read only.
    if (step === 'actions' && s.kind === 'ready' && s.actions.kind !== 'ok') {
      const why =
        s.actions.kind === 'unknown'
          ? 'unknown, scopes not listed'
          : s.actions.reason === 'scope'
            ? `read only, token lacks ${t?.writeScope ?? 'write:issue'}`
            : s.actions.reason === 'role'
              ? `read only, ${s.login} is below Reporter here`
              : `read only, ${s.login} may not push here`
      return d.line(`step-${step}`, `· ${LABEL[step].padEnd(8)}${why}`, { color: 'inactive' })
    }
    return d.line(`step-${step}`, `${mark} ${LABEL[step].padEnd(8)}${text}`, { color })
  })
  return { steps, s, r, v, tokenText }
}

// Setup passed and Icons is still ask: the one-time choice, before the list.
export async function iconsChoice($: EngineInterface, p: Pane, f: Frame) {
  const { draw: d, acts } = p
  const { Box, Text, Button } = p.look.ui
  const { columns } = p.look
  const { steps } = await stepsOf($, p)
  const glyphs = [
    { icon: ICON.refresh, name: 'refresh' },
    { icon: ICON.work, name: 'prompt' },
    { icon: ICON.open, name: 'browser' },
    { icon: ICON.back, name: 'back' },
  ]
  return (
    <Box flexDirection="column" height={p.height}>
      <Box key="choice" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {f.heading("What's Next is ready!")}
        {steps}
        <Box key="gap" height={1} />
        {d.line('ask', 'One choice: icons on buttons', { bold: true })}
        {d.para(
          'why',
          "What's Next can show its buttons as Nerd Font icons, which keeps them narrow. Look at the four below: do they show as icons, or as boxes or question marks?",
        )}
        <Box key="gap-glyphs" height={1} />
        <Box key="glyphs" height={1}>
          {glyphs.map(g => (
            <Box key={`g-${g.name}`} width={Math.max(10, Math.floor(columns / 4))}>
              <Text>{`  ${g.icon}`}</Text>
            </Box>
          ))}
        </Box>
        <Box key="names" height={1}>
          {glyphs.map(g => (
            <Box key={`n-${g.name}`} width={Math.max(10, Math.floor(columns / 4))}>
              <Text dimColor>{g.name}</Text>
            </Box>
          ))}
        </Box>
        <Box key="gap-look" height={1} />
        {d.line('look', 'Buttons would look like this:', { dimColor: true })}
        <Text key="sample">{glyphs.map(g => `[ ${g.icon} ]`).join('  ')}</Text>
        <Box key="choose" height={1} marginTop={1}>
          <Button key="use-icons" label="Use Icons" onPress={() => acts.chooseIcons('icons')} />
          <Text>{'  '}</Text>
          <Button key="keep-text" label="Keep Text" onPress={() => acts.chooseIcons('text')} />
        </Box>
        <Box key="gap-later" height={1} />
        {d.para('later', "Asked once. Change it later in /config, under What's Next: Icons.", { dimColor: true })}
      </Box>
    </Box>
  )
}

// Icons chosen, Compact still ask: the second one-time choice, two rows
// each way to choose by.
export async function compactChoice($: EngineInterface, p: Pane, f: Frame) {
  const { draw: d, acts } = p
  const { Box, Text, Button } = p.look.ui
  const { steps } = await stepsOf($, p)
  const sample = (spaced: boolean) => [
    <Text key={`a-${spaced}`}>
      <Text color="suggestion">{'  #37 '}</Text>
      Token refresh on 401
    </Text>,
    <Text key={`a2-${spaced}`} dimColor>
      {'      ✎ 1w'}
    </Text>,
    ...(spaced ? [<Box key={`gap-${spaced}`} height={1} />] : []),
    <Text key={`b-${spaced}`}>
      <Text color="suggestion">{'  #51 '}</Text>
      Rate limit settings page
    </Text>,
    <Text key={`b2-${spaced}`} dimColor>
      {'      ✎ 6d'}
    </Text>,
  ]
  return (
    <Box flexDirection="column" height={p.height}>
      <Box key="choice" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {f.heading("What's Next is ready!")}
        {steps}
        <Box key="gap" height={1} />
        {d.line('ask', 'One more choice: space between rows', { bold: true })}
        {d.para('why', 'Lists can keep an empty line between issues, or sit compact. Two rows each way:')}
        <Box key="gap-space" height={1} />
        {d.line('with', 'With space', { dimColor: true })}
        {sample(true)}
        <Box key="gap-compact" height={1} />
        {d.line('without', 'Compact', { dimColor: true })}
        {sample(false)}
        <Box key="choose" height={1} marginTop={1}>
          <Button key="keep-space" label="Keep Space" onPress={() => acts.chooseCompact('off')} />
          <Text>{'  '}</Text>
          <Button key="compact" label="Compact" onPress={() => acts.chooseCompact('on')} />
        </Box>
        <Box key="gap-later" height={1} />
        {d.para('later', "Asked once, after Icons. Change it later in /config, under What's Next: Compact.", { dimColor: true })}
      </Box>
    </Box>
  )
}

// Setup itself, until it passes and What's next loads: the steps, and for
// the one that failed what it means and what to do. `configure`: the
// command that sets a token.
export async function setupView($: EngineInterface, p: Pane, f: Frame, configure: string) {
  const { draw: d, acts } = p
  const { Box, Button } = p.look.ui
  const t = p.tracker
  const { steps, s, r, v, tokenText } = await stepsOf($, p)
  const m = await read($, overview)
  const body: RenderChildren[] = []
  if (s.kind !== 'ready' && s.kind !== 'checking') {
    const about = intro(s, r, t, v, tokenText)
    if (about) body.push(d.para('intro', about), <Box key="gap-intro" height={1} />)
    const actions = todo(s, r, t, configure)
    if (actions.length > 0) body.push(d.line('todo', 'What to do', { bold: true }))
    actions.forEach((a, i) => body.push(d.para(`todo-${i}`, `${i + 1}. ${a}`)))
    // Checking again is the guide's last step, so its button ends it.
    body.push(
      <Box key="again" height={1} marginTop={1} paddingLeft={3}>
        <Button key="refresh" label="Check Again" hotkey="r" onPress={acts.refresh} />
      </Box>,
    )
  }
  return (
    <Box flexDirection="column" height={p.height}>
      <Box key="setup" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {m.kind === 'error' && d.para('overview-error', `Could not load the issues: ${m.message}.`, { color: 'error' })}
        {s.kind === 'ready' ? f.heading("What's Next is ready!", { label: 'Refresh' }) : f.heading("Set up What's Next")}
        {steps}
        <Box key="gap" height={1} />
        {body}
      </Box>
    </Box>
  )
}
