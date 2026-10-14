import { atom, memberOf, read } from 'claude-code'
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { Comment, DetailFolds, Ref, Repo } from '../../types'
import { age, CLOSED_MARK, fit, FOLD_AT, ICON, whoOf } from '../draw'
import { isMine, markOf, standing, type Mark, type Standing } from '../epics'
import { duration, wrap } from '../issue'
import { slug } from '../tracker'
import * as step from '../where'
import { foldsOf } from '../where'
import { go } from '../panes'
import type { Action, Frame, Pane } from './frame'

// The state this view reads (the contract in types/index.d.ts).
const setup = atom({ plugin: 'whats-next', key: 'setup' } as const, { kind: 'checking' })
const detail = atom({ plugin: 'whats-next', key: 'detail' } as const, { kind: 'idle' })

// The issue detail (DRAWING-issue.md), in place of the list: issue `open`
// of repo `r`, as read from the forge.
export async function issueView($: EngineInterface, p: Pane, f: Frame, r: Repo, open: number) {
  const { id, draw: d, acts, known } = p
  const { Box, Text, Button } = p.look.ui
  const { columns } = p.look
  const t = p.tracker
  const s = await read($, setup)
  const dt = await read($, memberOf(detail, p.e))
  const now = p.look.today
  const folds = foldsOf(p.place)
  const setFolds = (change: (x: DetailFolds) => DetailFolds) => () => go($, id, w => step.fold(w, change))
  const body: RenderChildren[] = []
  const gapRow = (key: string) => <Box key={key} height={1} flexShrink={0} />
  // Lines of text that may run long, each cut to the pane: a detail counts its rows.
  const lines = (key: string, text: string, props: Record<string, unknown> = {}) =>
    wrap(text, columns).map((tl, k) => d.line(`${key}-${k}`, tl || ' ', props))
  let actions: Action[] = [f.refreshAction, f.helpAction]
  let note: string | undefined
  let prompt: RenderChildren = null
  if (dt.kind === 'loading' || dt.kind === 'idle') body.push(d.line('loading', `Loading #${open}…`, { dimColor: true }))
  if (dt.kind === 'error') body.push(...lines('error', `Could not load #${dt.number}: ${dt.message}.`, { color: 'error' }))
  if (dt.kind === 'ok') {
    const i = dt.issue
    // Every key of the detail in one gutter, as wide as the longest, Blocked by.
    const KEY = 11
    const keyed = (key: string, label: string, content: RenderChildren) => (
      <Box key={key} height={1} flexShrink={0}>
        <Text dimColor>{label.padEnd(KEY)}</Text>
        {content}
      </Box>
    )
    // The issue it is a child of, and what it blocks but that epic.
    const parent = dt.parent ?? null
    const blocks = (i.blocks ?? []).filter(x => !(parent?.epic && x.number === parent.number))
    // Its children, the open ones a line each, the closed ones counted; what
    // blocks it is then only what it waits on outside them: on Forgejo an
    // epic depends on each child (DRAWING-issue.md, Detail lines that name
    // an issue).
    const children = dt.children ?? []
    const openChildren = children.filter(x => x.state !== 'closed')
    const closedChildren = children.length - openChildren.length
    const blockedBy = (i.blockedBy ?? []).filter(x => !children.some(c => c.number === x.number))
    // Pull requests under the forge's word, and on GitLab its sign: !61 there is a merge request, #61 an issue.
    const gitlab = t?.name === 'GitLab'
    // One issue or pull request on a line: mark, number, title. An issue's
    // mark as the lists draw it, closed a grey ✓; a pull request has none
    // but ✓. Numbers sit at the right of one column, so titles start in one
    // column; at the right whom it is with, or merged. No state word: the
    // mark says it (DRAWING-issue.md, Detail lines that name an issue). All
    // but pull request lines are buttons that open their issue here.
    type RefKind = 'parent' | 'child' | 'blocker' | 'blocks' | 'pull'
    const numberOf = (x: Ref, kind: RefKind) => `${kind === 'pull' && gitlab ? '!' : '#'}${x.number}`
    const refs: [Ref, RefKind][] = [
      ...(parent ? [[parent, 'parent'] as [Ref, RefKind]] : []),
      ...openChildren.map((x): [Ref, RefKind] => [x, 'child']),
      ...blockedBy.map((x): [Ref, RefKind] => [x, 'blocker']),
      ...blocks.map((x): [Ref, RefKind] => [x, 'blocks']),
      ...(i.pulls ?? []).map((x): [Ref, RefKind] => [x, 'pull']),
    ]
    const login = known?.me ?? null
    const refStanding = (x: Ref, kind: RefKind): Standing | null =>
      kind === 'pull' || x.state !== 'open'
        ? null
        : standing({ mine: isMine(x.assignees ?? [], login), blocked: x.blocked === true, assignees: x.assignees ?? [] })
    const endOf = (x: Ref, kind: RefKind) => {
      const st = refStanding(x, kind)
      return kind === 'pull' ? (x.state === 'merged' ? 'merged' : '') : st ? whoOf({ assignees: x.assignees ?? [] }, st) : ''
    }
    const refNum = Math.max(0, ...refs.map(([x, kind]) => numberOf(x, kind).length))
    const refEnd = Math.max(0, ...refs.map(([x, kind]) => endOf(x, kind).length))
    const refLine = (key: string, label: string, x: Ref, kind: RefKind) => {
      const done = x.state === 'closed'
      const st = refStanding(x, kind)
      const mark: Mark = done ? CLOSED_MARK : st ? markOf(st, null) : { glyph: ' ' }
      const end = endOf(x, kind)
      const room = columns - KEY - 2 - refNum - 1 - (refEnd > 0 ? refEnd + 1 : 0)
      const row = (
        <Text wrap="truncate-end">
          {d.markText(mark)}
          <Text color={done ? 'inactive' : 'suggestion'}>{numberOf(x, kind).padStart(refNum)}</Text>
          <Text color={done ? 'inactive' : undefined} dimColor={st === 'blocked'}>{` ${fit(x.title, room).padEnd(room)}`}</Text>
          {refEnd > 0 ? (
            <Text color={x.state === 'merged' ? 'merged' : undefined} dimColor={x.state !== 'merged'}>
              {` ${end.padStart(refEnd)}`}
            </Text>
          ) : null}
        </Text>
      )
      return keyed(
        key,
        label,
        kind === 'pull' ? (
          row
        ) : (
          <Button key={`follow-${x.number}`} plain onPress={() => acts.followIssue(x.number)}>
            {row}
          </Button>
        ),
      )
    }
    // The facts, in the facts line's order, then what only the detail has
    // (DRAWING-issue.md, Detail lines that name an issue).
    const facts: RenderChildren[] = []
    if (parent) facts.push(refLine('parent', parent.epic ? 'Epic' : 'Parent', parent, 'parent'))
    openChildren.forEach((x, k) => facts.push(refLine(`child-${k}`, k === 0 ? 'Children' : '', x, 'child')))
    if (closedChildren > 0) {
      facts.push(keyed('children-closed', openChildren.length === 0 ? 'Children' : '', <Text color="inactive">{`✓ ${closedChildren} closed`}</Text>))
    }
    blockedBy.forEach((x, k) => facts.push(refLine(`blocked-${k}`, k === 0 ? 'Blocked by' : '', x, 'blocker')))
    blocks.forEach((x, k) => facts.push(refLine(`blocks-${k}`, k === 0 ? 'Blocks' : '', x, 'blocks')))
    if (i.due) facts.push(keyed('due', 'Due', d.dueDate('due-date', i.due, now, { form: 'long', bare: true })))
    if (i.milestone) {
      facts.push(keyed('milestone', 'Milestone', d.partsLine('milestone-parts', 0, [{ text: i.milestone.title }, ...d.duePart('milestone-due', i.milestone.due, now, { form: 'short' })])))
    }
    if (i.labels.length > 0) facts.push(keyed('labels', 'Labels', <Text wrap="truncate-end">{d.labelTexts(i.labels)}</Text>))
    if (i.branch) facts.push(keyed('branch', 'Branch', <Text>{i.branch}</Text>))
    const time = i.logged
      ? `${duration(i.logged)} logged${i.estimate ? ` of ${duration(i.estimate)} estimated` : ''}`
      : i.estimate
        ? `${duration(i.estimate)} estimated`
        : null
    if (time) facts.push(keyed('time', 'Time', <Text>{time}</Text>))
    ;(i.pulls ?? []).forEach((x, k) => facts.push(refLine(`pull-${k}`, k === 0 ? (gitlab ? 'MRs' : 'PRs') : '', x, 'pull')))
    // One text, as a line naming an issue: sha dim, message padded to its
    // room, age dim at the right. Pieces side by side were squeezed out.
    ;(i.commits ?? []).slice(0, 3).forEach((c, k) => {
      const ago = ` ${age(c.when, now)} ago`
      const room = Math.max(0, columns - KEY - c.sha.length - 1 - ago.length)
      facts.push(
        keyed(
          `commit-${k}`,
          k === 0 ? 'Commits' : '',
          <Text wrap="truncate-end">
            <Text dimColor>{`${c.sha} `}</Text>
            {fit(c.message, room).padEnd(room)}
            <Text dimColor>{ago}</Text>
          </Text>,
        ),
      )
    })

    // Assign and close, when What's Next may: setup's Actions step says so.
    const allowed = s.kind === 'ready' ? s.actions : ({ kind: 'read-only', reason: 'scope' } as const)
    const canAct = allowed.kind !== 'read-only'
    const me = known?.me ?? null
    const mine = isMine(i.assignees, me)
    const closed = i.state === 'closed'
    // Its mark before the number, as the lists draw it; closed a grey ✓.
    // Whom it is with at the right of the first line, dim.
    const ownStanding = closed ? null : standing({ mine, blocked: dt.blocked === true, assignees: i.assignees })
    const ownMark: Mark = ownStanding ? markOf(ownStanding, null) : CLOSED_MARK
    const who = ownStanding ? whoOf({ assignees: i.assignees }, ownStanding) : ''
    // The heading wraps over two lines at most, under the number; a longer
    // title ends the second in ….
    const headText = `#${i.number} ${i.title}`
    const headWidth = columns - 2 - (who ? who.length + 1 : 0)
    const wrapped = wrap(headText, headWidth)
    const titleLines =
      wrapped.length > 2 ? [wrapped[0] ?? '', fit(headText.slice((wrapped[0] ?? '').length).trimStart(), headWidth)] : wrapped
    actions = [
      ...(canAct
        ? [
            {
              key: 'assign',
              label: mine ? 'Unassign Me' : 'Assign Me',
              hotkey: 'a',
              onPress: () => acts.counted(`${mine ? 'unassign' : 'assign'} #${i.number}`, () => acts.assignMe(i, !mine)),
            },
            {
              key: 'close',
              label: closed ? 'Reopen' : 'Close',
              hotkey: 'c',
              onPress: () =>
                acts.counted(`${closed ? 'reopen' : 'close'} #${i.number}`, () =>
                  acts.writeIssue(i.number, tr => tr.close(i.number, !closed), closed ? 'reopen' : 'close'),
                ),
            },
          ]
        : []),
      { key: 'open', label: 'Open in Browser', hotkey: 'o', onPress: () => acts.openUrl(i.url) },
      f.refreshAction,
      f.helpAction,
    ]
    note = canAct
      ? undefined
      : allowed.kind === 'read-only' && allowed.reason === 'role'
        ? `Assign and close need Reporter or higher on ${slug(r)}.`
        : allowed.kind === 'read-only' && allowed.reason === 'push'
          ? `Assign and close need push rights on ${slug(r)}.`
          : `Assign and close need a token with ${t?.writeScope ?? 'write:issue'}: the setup guide's steps make one.`
    prompt = <Button key="prompt" label={d.say(ICON.work, 'Prompt')} hotkey="p" onPress={() => acts.workOn(i)} />

    // Closed: grey as a whole, number and title; blocked: the title dim.
    // Under it who opened it when (DRAWING-issue.md, The issue detail's
    // heading). No state word: the mark says it.
    titleLines.forEach((tl, k) =>
      body.push(
        <Text key={`t-${k}`} bold wrap="truncate-end" color={closed ? 'inactive' : undefined}>
          {k === 0 ? d.markText(ownMark) : '  '}
          {k === 0 && !closed ? <Text color="suggestion">{`#${i.number}`}</Text> : null}
          <Text dimColor={ownStanding === 'blocked'}>{k === 0 && !closed ? tl.slice(`#${i.number}`.length) : tl}</Text>
          {k === 0 && who ? <Text dimColor bold={false}>{`${' '.repeat(Math.max(1, headWidth - tl.length + 1))}${who}`}</Text> : null}
        </Text>,
      ),
    )
    body.push(d.partsLine('opened', 2, [{ text: `✎ ${age(i.created, now)} ${i.author}` }]))
    if (dt.error) body.push(gapRow('gap-error'), ...lines('action-error', dt.error, { color: 'error' }))
    if (facts.length > 0) body.push(gapRow('gap-facts'), ...facts)

    // Description folds from 5 lines on (FOLD_AT): folded, its first 3 and
    // how many more.
    const descLines = i.body.trim() === '' ? [] : wrap(i.body.trim(), columns)
    const descShown = folds.description || descLines.length <= FOLD_AT ? descLines.length : 3
    body.push(
      gapRow('gap-desc'),
      descLines.length > FOLD_AT
        ? d.rule('description-rule', 'Description', [], { key: 'description-section', open: folds.description, onPress: setFolds(x => ({ ...x, description: !x.description })) })
        : d.rule('desc', 'Description'),
    )
    if (descLines.length === 0) body.push(d.line('no-desc', 'No description.', { dimColor: true }))
    descLines.slice(0, descShown).forEach((tl, k) => body.push(d.line(`d-${k}`, tl || ' ')))
    if (descShown < descLines.length) body.push(d.moreLine('description-more', descLines.length - descShown, setFolds(x => ({ ...x, description: true }))))

    // Comments, newest first: the newest unfolded, each older one a dim
    // line that unfolds it (DRAWING-issue.md, The issue detail's comments).
    const said = i.commentList
    const count = said ? said.length : i.comments
    if (count > 0) {
      body.push(
        gapRow('gap-comments'),
        d.rule('comments-rule', 'Comments', [{ text: `${count}` }], { key: 'comments-section', open: !folds.commentsShut, onPress: setFolds(x => ({ ...x, commentsShut: !x.commentsShut })) }),
      )
    }
    if (count > 0 && !folds.commentsShut && !said) body.push(d.line('comments-unknown', 'comments unknown', { dimColor: true }))
    if (count > 0 && !folds.commentsShut && said) {
      const newest = [...said].reverse()
      const idOf = (c: Comment) => `${c.when} ${c.author}`
      const first = newest[0] ? [idOf(newest[0])] : []
      const unfoldedOnes = new Set(folds.comments ?? first)
      const fold = (cid: string, on: boolean) =>
        setFolds(x => {
          const was = (x.comments ?? first).filter(y => y !== cid)
          return { ...x, comments: on ? [...was, cid] : was }
        })
      newest.forEach((c, k) => {
        const cid = idOf(c)
        const ago = `${age(c.when, now)} ago`
        const author = fit(c.author, columns - 2)
        if (unfoldedOnes.has(cid)) {
          body.push(
            <Box key={`comment-row-${k}`} height={1} flexShrink={0}>
              <Button key={`comment-${k}`} plain onPress={fold(cid, false)}>
                <Text>
                  {'− '}
                  <Text bold>{author}</Text>
                  <Text dimColor>{fit(` · ${ago}`, columns - 2 - author.length)}</Text>
                </Text>
              </Button>
            </Box>,
          )
          // Its first 3 lines, and how many more: pressed, the rest.
          const text = wrap(c.body.trim(), columns)
          const whole = folds.whole.includes(cid) || text.length <= FOLD_AT
          text.slice(0, whole ? text.length : 3).forEach((tl, j) => body.push(d.line(`comment-${k}-${j}`, tl || ' ')))
          if (!whole) body.push(d.moreLine(`comment-more-${k}`, text.length - 3, setFolds(x => ({ ...x, whole: [...x.whole, cid] }))))
          return
        }
        const head = `+ ${author} · ${ago} · `
        const words = fit(c.body.replace(/\s+/g, ' ').trim(), columns - head.length)
        body.push(
          <Box key={`comment-row-${k}`} height={1} flexShrink={0}>
            <Button key={`comment-${k}`} plain onPress={fold(cid, true)}>
              <Text>
                <Text dimColor>{'+ '}</Text>
                <Text bold>{author}</Text>
                <Text dimColor>{fit(` · ${ago} · ${words}`, columns - 2 - author.length)}</Text>
              </Text>
            </Button>
          </Box>,
        )
      })
    }
  }
  // [ ← ] and the menu, with Prompt before it once the issue is read.
  return f.detailFrame(f.detailTop(actions, acts.goBack, prompt), body, f.menuLines(actions, note))
}
