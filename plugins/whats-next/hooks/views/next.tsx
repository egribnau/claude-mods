import type { RenderChildren } from 'claude-code'

import type { IssueRow, Overview, Repo, Scope } from '../../types'
import { age, fit, type Part } from '../draw'
import { within as withinFilter } from '../filter'
import { waitingText } from '../next'
import { slug } from '../tracker'
import { PANE } from '../panes'
import type { Frame, Pane } from './frame'


// What's next, once setup passes and it has loaded or is loading (`m`), for
// repo `r`: In progress, Next and the Queue, then Last closed above the
// bottom line.
export async function nextView(p: Pane, f: Frame, m: Exclude<Overview, { kind: 'idle' | 'error' }>, r: Repo) {
  const { draw: d, acts } = p
  const { Box, Text, Button } = p.look.ui
  const { columns, compact } = p.look
  const gap = d.gap
  const today = p.look.today
  const openIssue = (n: number) => acts.openIssue(PANE, n)
  // What the milestone filter is set to, for a sentence: "in v1.2",
  // "without a milestone", or nothing for All. The section rules leave it
  // out: the milestone filter shows it.
  const within = p.look.filter ? withinFilter(p.look.filter.set) : ''
  const rows: RenderChildren[] = []
  // Last closed, above the bottom line: its rule and its row.
  const lastRows: RenderChildren[] = []
  // Whether the list ends without an empty line, for Last closed's rule.
  let lastOpen = false
  if (m.kind === 'loading') rows.push(d.line('loading', 'Loading the issues…', { dimColor: true }))
  if (m.kind === 'ok') {
    const later = [...m.queue, ...m.blocked.map(b => b.issue)]
    const listed = [...m.inProgress, ...(m.next ? [m.next] : []), ...later]
    // The number column: the longest number and a space, so titles and
    // the lines under them line up whatever the numbers. Numbers sit at
    // its right, their last digits in line. Last closed shares it.
    const numWidth = Math.max(...[...listed, ...(m.lastClosed ? [m.lastClosed] : [])].map(i => `#${i.number}`.length), 0) + 1
    // Where an issue of Next or the Queue was taken from, after the
    // section's name in its rule (ORDERING.md, Scopes): `in epic #30`, the
    // number blue, or `in v1.2`; nothing for the rest of the milestone filter.
    const scopePart = (sc: Scope | undefined): Part[] =>
      sc === undefined
        ? []
        : sc.kind === 'milestone'
          ? [{ text: `in ${sc.title}` }]
          : [
              {
                text: `in epic #${sc.number}`,
                node: [
                  <Text key="in" dimColor>
                    {'in epic '}
                  </Text>,
                  <Text key="epic" color="suggestion">{`#${sc.number}`}</Text>,
                ],
              },
            ]
    const sameScope = (a: Scope | undefined, b: Scope | undefined) =>
      a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))
    // The mark says how a row stands for you: yours in In progress,
    // available in Next and the Queue, blocked at the Queue's end. Next is
    // also bold; nothing has the focus until Tab or an arrow moves it.
    const STANDING = { progress: 'yours', next: 'available', queue: 'available', blocked: 'blocked' } as const
    const row = (i: IssueRow, section: keyof typeof STANDING, blockedBy?: number[]) => {
      return d.issueRow(i, {
        key: `issue-${i.number}`,
        buttonKey: `pick-${i.number}`,
        numWidth,
        standing: STANDING[section],
        bold: section === 'next',
        blockedBy,
        onPress: () => openIssue(i.number),
      })
    }
    // Exactly one empty line before every rule but the first, Compact or
    // not (DRAWING.md, Rules): a row leaves one only without Compact, a
    // paragraph always does. `open`: what was pushed last ends without one.
    let open = false
    const pushRow = (...items: RenderChildren[]) => {
      rows.push(...items)
      open = compact
    }
    const pushBlock = (item: RenderChildren) => {
      rows.push(item)
      open = false
    }
    const pushRule = (item: RenderChildren) => {
      if (open) rows.push(<Box key={`end-${rows.length}`} height={1} flexShrink={0} />)
      rows.push(item)
      open = false
    }
    if (listed.length === 0) {
      rows.push(d.para('none', within ? `No open issues${within}.` : `No open issues in ${slug(r)}.`, { dimColor: true }))
      open = true
    } else {
      pushRule(d.rule('in-progress', 'In progress', [{ text: `${m.inProgress.length}` }]))
      if (m.inProgress.length === 0) {
        pushBlock(
          <Box key="no-progress" flexDirection="column" marginBottom={1} flexShrink={0}>
            {d.para('no-progress-text', 'Nothing in progress. Assign yourself an issue to start.', { dimColor: true })}
          </Box>,
        )
      }
      for (const i of m.inProgress) pushRow(row(i, 'progress'))
      pushRule(d.rule('next', 'Next', scopePart(m.next ? m.scopes[m.next.number] : undefined)))
      if (m.next) pushRow(row(m.next, 'next'))
      else if (m.blocked.length > 0) {
        pushBlock(
          <Box key="nothing-available" flexDirection="column" marginBottom={1} flexShrink={0}>
            {d.line('nothing-available-title', 'Nothing available', { bold: true })}
            {d.para('nothing-available-why', waitingText(m.blocked), { dimColor: true })}
          </Box>,
        )
      } else {
        pushBlock(
          <Box key="nothing-else" flexDirection="column" marginBottom={1} flexShrink={0}>
            {d.para('nothing-else-text', 'No other open issues.', { dimColor: true })}
          </Box>,
        )
      }
      // The Queue shows up to its limit, a rule for each scope it takes
      // from and no count (DRAWING.md, Rules); the issues past the limit
      // are counted on one line under the available ones.
      if (later.length > 0) {
        if (m.queue.length === 0) pushRule(d.rule('queue', 'Queue'))
        m.queue.forEach((i, k) => {
          const sc = m.scopes[i.number]
          const before = k > 0 ? m.queue[k - 1] : undefined
          if (k === 0 || !sameScope(sc, before && m.scopes[before.number])) {
            pushRule(d.rule(k === 0 ? 'queue' : `queue-${i.number}`, 'Queue', scopePart(sc)))
          }
          pushRow(row(i, 'queue'))
        })
        if (m.more > 0) {
          pushRow(
            <Box key="more" flexDirection="column" marginBottom={gap} flexShrink={0}>
              {d.line('more-text', `${' '.repeat(2)}and ${m.more} more`, { dimColor: true })}
            </Box>,
          )
        }
        for (const b of m.blocked) pushRow(row(b.issue, 'blocked', b.by))
      }
    }
    lastOpen = open
    // The issue you closed last within the milestone filter, as What's next
    // follows on from it: a rule saying how long ago and the epic it was in,
    // then one grey closed row, ✓ in the mark column, that opens it.
    const last = m.lastClosed
    if (last) {
      lastRows.push(
        d.rule('last-closed', 'Last closed', [{ text: `${age(last.closed, today)} ago` }, ...(last.epic !== null ? scopePart({ kind: 'epic', number: last.epic }) : [])]),
      )
      lastRows.push(
        <Box key="last-closed-row" flexShrink={0}>
          <Button key="last-closed-open" plain onPress={() => openIssue(last.number)}>
            <Text wrap="truncate-end" color="inactive">
              {'✓ '}
              {d.numberText(last.number, numWidth, true)}
              {fit(last.title, columns - 2 - numWidth)}
            </Text>
          </Button>
        </Box>,
      )
    }
  }
  const last = lastRows.length > 0 && (
    <Box key="last" flexDirection="column" flexShrink={0} marginTop={lastOpen ? 1 : 0}>
      {lastRows}
    </Box>
  )
  return f.listFrame(f.titleRow("What's next"), rows, await f.listOverlay(), last)
}
