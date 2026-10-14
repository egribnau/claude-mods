import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { Epic, Milestone, MilestoneIssue, Repo, Setup } from '../../types'
import { CLOSED_END, COUNT, fit, FOLD_AT, whoOf, type Part } from '../draw'
import { dueFirst, forYou, inMilestone, markOf, openChildren, standing, tally, tree } from '../epics'
import { wrap } from '../issue'
import { slug } from '../tracker'
import { milestoneShown, MILESTONES_PANE } from '../panes'
import { treeKnown, type Action, type Frame, type Pane } from './frame'

// The state this view reads and writes (the contract in types/index.d.ts).
const milestones = atom({ plugin: 'whats-next', key: 'milestones' } as const, null)
const milestonesUnfolded = atom({ plugin: 'whats-next', key: 'milestonesUnfolded' } as const, [])
const msIssues = atom({ plugin: 'whats-next', key: 'milestoneIssues' } as const, {})
const closedMilestones = atom({ plugin: 'whats-next', key: 'closedMilestones' } as const, [])
const closedShown = atom({ plugin: 'whats-next', key: 'closedShown' } as const, false)
const unfolded = atom({ plugin: 'whats-next', key: 'unfolded' } as const, [])
const milestoneError = atom({ plugin: 'whats-next', key: 'milestoneError' } as const, null)
const issuesFolded = atom({ plugin: 'whats-next', key: 'issuesFolded' } as const, false)
const descriptionUnfolded = atom({ plugin: 'whats-next', key: 'descriptionUnfolded' } as const, false)

// The Milestones pane, once setup passes (`s`, for repo `r`): each open
// milestone folded, due first, with how far it is from its own counts;
// then the last closed. A milestone open shows its detail instead.
export async function milestonesView($: EngineInterface, p: Pane, f: Frame, s: Extract<Setup, { kind: 'ready' }>, r: Repo) {
  const { draw: d, acts, known } = p
  const { Box, Text } = p.look.ui
  const { columns } = p.look
  const gap = d.gap
  const now = p.look.today
  const openOnes = await read($, milestones)
  const folds = new Set(await read($, milestonesUnfolded))
  const rows: RenderChildren[] = []
  if (openOnes === null) rows.push(d.line('loading', 'Loading the milestones…', { dimColor: true }))
  if (openOnes !== null && openOnes.length === 0) rows.push(d.para('none', `No open milestones in ${slug(r)}.`, { dimColor: true }))
  const issuesOf = await read($, msIssues)
  const closedOnes = await read($, closedMilestones)
  const showClosed = await read($, closedShown)
  const epicFolds = new Set(await read($, unfolded))
  const { kidsOf, openEpics } = await treeKnown($, p)
  const openIssue = (n: number) => acts.openIssue(MILESTONES_PANE, n)
  // A milestone's issues as a tree, in its row folded open or in its
  // detail: its epics at the top of the tree, each with its fold mark, bar
  // and closed/total, folded the line under it and unfolded its tree; then
  // the issues no open epic in it holds, its closed epics grey (in a closed
  // milestone), and how many of its issues are closed.
  const treeOf = (issues: readonly MilestoneIssue[]) => {
    const parts = inMilestone(issues)
    const top = parts.epics.map((e): Epic => ({ number: e.number, title: e.title, state: e.state, due: e.due, children: e.children ?? null }))
    return { ...parts, lines: tree(top, kidsOf, epicFolds, openEpics).lines }
  }
  const milestoneNumbers = (issues: readonly MilestoneIssue[]) => {
    const { lines } = treeOf(issues)
    return [...issues.map(c => c.number), ...[...lines.values()].flat().flatMap(l => (l.kind === 'child' ? [l.child.number] : []))]
  }
  const milestoneRows = (ms: Milestone, issues: readonly MilestoneIssue[], isClosed: boolean, numWidth: number, drawn: Map<number, number>) => {
    const { epics: tops, plain, closedEpics, lines } = treeOf(issues)
    // An issue drawn twice in the pane needs another address the second time.
    const at = (n: number) => {
      const times = (drawn.get(n) ?? 0) + 1
      drawn.set(n, times)
      return times === 1 ? `${n}` : `${n}@${times}`
    }
    const out: RenderChildren[] = []
    for (const c of tops) {
      const isUnfolded = epicFolds.has(c.number)
      const key = at(c.number)
      const asEpic: Epic = {
        number: c.number,
        title: c.title,
        state: 'open',
        due: c.due,
        children: c.children ?? null,
        labels: c.labels,
        milestone: c.milestone,
        created: c.created,
        blockedBy: c.blockedBy,
      }
      out.push(
        d.epicRow(asEpic, {
          key: `ms-epic-${key}`,
          foldKey: `fold-${key}`,
          openKey: `ms-issue-${key}`,
          lead: 2,
          numWidth,
          open: isUnfolded,
          noMilestone: true,
          onFold: () => acts.foldIssue(c.number),
          onOpen: () => openIssue(c.number),
        }),
      )
      if (!isUnfolded) continue
      const under = lines.get(c.number) ?? []
      out.push(
        <Box key={`ms-tree-${key}`} flexDirection="column" flexShrink={0} marginBottom={under.at(-1)?.kind === 'child' ? 0 : gap}>
          {d.tree(under, { lead: 4, numWidth, button: 'ms-issue', drawn, at: `${ms.title}-${key}`, onOpen: openIssue, onFold: acts.foldIssue })}
        </Box>,
      )
    }
    for (const c of openChildren(plain)) {
      const st = standing(c)
      const key = at(c.number)
      out.push(
        d.issueRow(c, {
          key: `ms-row-${key}`,
          buttonKey: `ms-issue-${key}`,
          numWidth,
          lead: 2,
          standing: st,
          who: whoOf(c, st),
          blockedBy: st === 'blocked' ? c.blockedBy : undefined,
          noMilestone: true,
          onPress: () => openIssue(c.number),
        }),
      )
    }
    if (isClosed) {
      for (const c of closedEpics) {
        const key = at(c.number)
        out.push(d.closedRow(`ms-epic-${key}`, `ms-issue-${key}`, 4, c.number, numWidth, c.title, () => openIssue(c.number)))
      }
    }
    if (ms.closed > 0) out.push(d.closedLine(`closed-${ms.title}`, 2, ms.closed))
    return out
  }

  // A milestone open: its detail in place of the list. One no longer
  // listed after a Refresh shows the list.
  const inDetail = await milestoneShown($)
  const shownMs = inDetail === null ? undefined : [...(openOnes ?? []), ...closedOnes].find(m => m.title === inDetail)
  if (shownMs) {
    const isClosed = !(openOnes ?? []).includes(shownMs)
    const issues = issuesOf[shownMs.title]
    const plain = (issues ?? []).filter(c => c.children === undefined)
    const parts = issues ? forYou(tally(plain)) : []
    // The heading wraps over two lines at most; a longer title ends the
    // second in ….
    // Closed: ✓ in front, as the lists draw closed; open has no sign.
    const headText = isClosed ? `✓ ${shownMs.title}` : shownMs.title
    const wrapped = wrap(headText, columns)
    const titleLines = wrapped.length > 2 ? [wrapped[0] ?? '', fit(headText.slice((wrapped[0] ?? '').length).trimStart(), columns)] : wrapped
    const when = isClosed && shownMs.closedAt ? Math.round((now - Date.parse(shownMs.closedAt)) / 86400000) : null
    const closedWhen = when === null ? null : when === 0 ? 'today' : when === 1 ? 'yesterday' : `${when} days ago`
    // All closed is amber while the milestone is still open: close it.
    const allClosed = shownMs.total > 0 && shownMs.closed === shownMs.total
    const progress: Part[] = [
      { text: `${shownMs.closed}/${shownMs.total}` },
      allClosed ? { text: 'all closed', ...(isClosed ? {} : { color: 'warning' }) } : { text: `${shownMs.total - shownMs.closed} open` },
    ]
    // Description, folded, shows its first three lines.
    const text = (shownMs.description ?? '').trim()
    const descLines = text === '' ? [] : wrap(text, columns)
    const descOpen = await read($, descriptionUnfolded)
    const descShown = descOpen || descLines.length <= FOLD_AT ? descLines.length : 3
    // The title, when it closed under it, then its due date as a fact
    // under Due, in the issue detail's gutter (DRAWING-issue.md, The issue
    // detail's heading): the long form while open, short and dim once closed.
    const body: RenderChildren[] = [
      ...titleLines.map((tl, k) => (
        <Text key={`t-${k}`} bold wrap="truncate-end" color={isClosed ? 'inactive' : undefined}>
          {tl}
        </Text>
      )),
      ...(closedWhen ? [d.partsLine('state', 0, [{ text: closedWhen }])] : []),
    ]
    if (shownMs.due) {
      body.push(
        <Box key="due" height={1} flexShrink={0} marginTop={1}>
          <Text dimColor>{'Due'.padEnd(11)}</Text>
          {d.dueDate('due-date', shownMs.due, now, { form: isClosed ? 'short' : 'long', bare: true, done: isClosed })}
        </Box>,
      )
    }
    body.push(
      <Box key="progress" flexDirection="column" flexShrink={0} marginTop={1}>
        <Text wrap="truncate-end">
          {d.barText(shownMs.closed, shownMs.total)}
          {' '}
          {d.joined(progress)}
        </Text>
        {issues === undefined && d.line('ms-loading', 'Loading the issues…', { dimColor: true })}
        {issues === null && d.line('ms-unknown', 'issues unknown', { dimColor: true })}
        {issues && d.partsLine('for-you', 0, parts)}
      </Box>,
    )
    // No Prompt or Assign: a milestone is not work you pick up. Close and
    // Reopen as on Issue detail, not where the token is read only; all in
    // the menu (DRAWING.md, The menu).
    const url = shownMs.url
    const canClose = shownMs.id !== undefined && s.actions.kind !== 'read-only'
    const actions: Action[] = [
      ...(url ? [{ key: 'open', label: 'Open in Browser', hotkey: 'o', onPress: () => acts.openUrl(url) }] : []),
      ...(canClose
        ? [
            {
              key: 'close',
              label: isClosed ? 'Reopen' : 'Close',
              hotkey: 'c',
              onPress: () => acts.counted(`${isClosed ? 'reopen' : 'close'} ${shownMs.title}`, () => acts.closeMilestone(shownMs, !isClosed)),
            },
          ]
        : []),
      f.refreshAction,
      f.helpAction,
    ]
    const error = await read($, milestoneError)
    if (error) {
      body.push(<Box key="gap-error" height={1} flexShrink={0} />, ...wrap(error, columns).map((tl, k) => d.line(`action-error-${k}`, tl, { color: 'error' })))
    }
    // Two sections, each folding on its rule as Closed does: Issues, the
    // milestone's issues as a tree, unfolded at first; then Description.
    const issuesShut = await read($, issuesFolded)
    body.push(
      <Box key="gap-issues" height={1} flexShrink={0} />,
      d.rule('issues-section-rule', 'Issues', [{ text: `${shownMs.total - shownMs.closed} open` }], {
        key: 'issues-section',
        open: !issuesShut,
        onPress: () => update($, issuesFolded, x => !x),
      }),
    )
    if (!issuesShut) {
      const list: RenderChildren[] = []
      if (issues === undefined) list.push(d.line('ms-list-loading', '  Loading the issues…', { dimColor: true }))
      if (issues === null) list.push(d.line('ms-list-unknown', '  issues unknown', { dimColor: true }))
      if (issues) {
        const width = Math.max(0, ...milestoneNumbers(issues).map(n => `#${n}`.length)) + 1
        list.push(...milestoneRows(shownMs, issues, isClosed, width, new Map()))
      }
      body.push(
        <Box key="issues" flexDirection="column" flexShrink={0}>
          {list}
        </Box>,
      )
    }
    // Four lines or fewer: nothing to fold, the rule as on Issue detail.
    // One empty line before it: the last issue row leaves one without Compact.
    const endsInRow = !issuesShut && shownMs.closed === 0 && Array.isArray(issues) && issues.length > 0
    body.push(
      ...(endsInRow ? d.sectionEnd('desc') : [<Box key="gap-desc" height={1} flexShrink={0} />]),
      descLines.length > FOLD_AT
        ? d.rule('description-section-rule', 'Description', [], { key: 'description-section', open: descOpen, onPress: () => update($, descriptionUnfolded, o => !o) })
        : d.rule('desc', 'Description'),
    )
    if (descLines.length === 0) body.push(d.line('no-desc', 'No description.', { dimColor: true }))
    descLines.slice(0, descShown).forEach((tl, k) => body.push(d.line(`d-${k}`, tl || ' ')))
    if (descShown < descLines.length) {
      body.push(d.moreLine('description-more', descLines.length - descShown, () => update($, descriptionUnfolded, () => true)))
    }
    return f.detailFrame(f.detailTop(actions, () => acts.openMilestone(null)), body, f.menuLines(actions))
  }
  // Bar and count at the right of a row.
  const titleWidth = Math.max(0, columns - 2 - COUNT)
  // One number column for every milestone folded open, so all titles line up.
  const numbers = [...folds].flatMap(t => milestoneNumbers(issuesOf[t] ?? []))
  const numWidth = Math.max(0, ...numbers.map(n => `#${n}`.length)) + 1
  const drawn = new Map<number, number>()
  // A milestone's row and, folded open, its issues. A closed one is a grey
  // row ending in ✓, its closed epics grey under its open issues.
  const draw = (ms: Milestone, isClosed: boolean) => {
    const open = folds.has(ms.title)
    // Once asked: its open issues, its epics first, and what there is for
    // you among the issues that are not epics.
    const issues = issuesOf[ms.title]
    const plain = (issues ?? []).filter(c => c.children === undefined)
    // Folded and never asked: only what is known without asking (yours,
    // the rest once every issue not yours was checked).
    const seen = issues || !known ? null : known.forYou(ms.title)
    const parts = issues
      ? forYou(tally(plain))
      : seen
        ? forYou({ closed: 0, total: 0, ...(seen.checked ? seen : { yours: seen.yours, available: 0, withOthers: 0, blocked: 0 }) })
        : []
    // Two targets, as an epic's: the mark folds, the rest opens its detail.
    const fold = { foldKey: `ms-fold-${ms.title}`, onFold: () => acts.foldMilestone(ms.title), openKey: `milestone-${ms.title}`, onOpen: () => acts.openMilestone(ms.title) }
    const mark = markOf(null, open ? 'unfolded' : 'folded', isClosed)
    if (isClosed) {
      rows.push(
        <Box key={`ms-${ms.title}`} flexShrink={0}>
          {d.foldRow({ lead: 0, mark, ...fold, color: 'inactive', body: [`${fit(ms.title, titleWidth).padEnd(titleWidth)} ${CLOSED_END}`] })}
        </Box>,
      )
    } else {
      // One line, as under a folded epic: its due date, then all closed,
      // amber (the milestone is done, close it), or what there is for you.
      // Folded, issues it could not list say so; folded open, the list does.
      const allClosed = ms.total > 0 && ms.closed === ms.total
      const unknown = !open && (issues === null || (issues === undefined && known !== null && !known.listed))
      const under: Part[] = [
        ...d.duePart('due', ms.due, now, { form: 'short' }),
        ...(allClosed ? [{ text: 'all closed', color: 'warning' }] : unknown ? [{ text: 'issues unknown' }] : parts),
      ]
      rows.push(
        <Box key={`ms-${ms.title}`} flexDirection="column" flexShrink={0} marginBottom={open ? 0 : gap}>
          {d.foldRow({
            lead: 0,
            mark,
            ...fold,
            body: [
              <Text key="title" bold>
                {`${fit(ms.title, titleWidth).padEnd(titleWidth)} `}
              </Text>,
              ...d.countText(ms.closed, ms.total, true),
            ],
          })}
          {under.length > 0 && d.partsLine(`under-${ms.title}`, 2, under)}
        </Box>,
      )
    }
    if (!open) return
    // Folded open: its issues, or that they are loading or unknown.
    const kids: RenderChildren[] = []
    if (issues === undefined) kids.push(d.line(`loading-${ms.title}`, '  Loading the issues…', { dimColor: true }))
    if (issues === null) kids.push(d.line(`unknown-${ms.title}`, '  issues unknown', { dimColor: true }))
    if (issues) kids.push(...milestoneRows(ms, issues, isClosed, numWidth, drawn))
    // The last issue row brings its own empty line; a closing line needs one.
    const endsInRow = ms.closed === 0 && issues !== undefined && issues !== null && issues.length > 0
    rows.push(
      <Box key={`ms-kids-${ms.title}`} flexDirection="column" flexShrink={0} marginBottom={endsInRow ? 0 : gap}>
        {kids}
      </Box>,
    )
  }
  for (const ms of dueFirst(openOnes ?? [])) draw(ms, false)
  if (closedOnes.length > 0) {
    // The open milestones' rows leave an empty line only without Compact.
    if ((openOnes ?? []).length > 0) rows.push(...d.sectionEnd('closed'))
    rows.push(
      <Box key="closed-rule" flexShrink={0} marginBottom={showClosed ? 0 : gap}>
        {d.rule('closed-rule-line', 'Closed', [{ text: `${closedOnes.length}` }], {
          key: 'closed-section',
          open: showClosed,
          onPress: () => update($, closedShown, o => !o),
        })}
      </Box>,
    )
    if (showClosed) for (const ms of closedOnes) draw(ms, true)
  }
  return f.listFrame(f.titleRow('Milestones', false), rows, await f.listOverlay(false))
}
