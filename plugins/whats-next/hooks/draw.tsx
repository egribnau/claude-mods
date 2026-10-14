import type { Elements, RenderChildren, RenderSurface } from 'claude-code'

import type { Epic, FilterShown, IssueRow } from '../types'
import { bar, markOf, standing, summary, tally, type Folding, type Mark, type Standing, type TreeLine } from './epics'
import { ofMilestone, sameFilter } from './filter'
import { day, dueSoon, dueText, readable } from './issue'

// How every row and line is drawn (docs/whats-next/DRAWING.md and
// DRAWING-issue.md): the issue row and its facts line, the epic row and its
// for-you line, rules, marks, due dates, trees and the bottom line. Each
// reads the look and its arguments, nothing else; what a press does is
// handed in as `onPress`, so drawing changes no state.

// What the drawing reads, once per render: the surface's elements, the
// pane's width, Compact, Icons, today, the milestone filter, and how many
// open issues wait on each issue as far as What's next knows.
export type Look = {
  ui: Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>
  columns: number
  compact: boolean
  icons: boolean
  today: number
  filter: FilterShown | null
  unblocks: Readonly<Record<number, number>>
}

// Text cut to its first 3 lines and `… n more lines` is cut only from 5
// lines on: a 4th line takes the row the button would.
export const FOLD_AT = 4

// Nerd Font icons (Material Design set): Prompt's, and three more the
// one-time choice shows, so a font that lacks them is seen to.
export const ICON = {
  refresh: '\u{F0450}',
  work: '\u{F0674}',
  open: '\u{F03CC}',
  back: '\u{F004D}',
} as const

// `text` cut to `width` characters, ending in … when it was longer. A Text
// inside a Button wraps rather than truncates, so titles are cut here.
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// Pieces of one line, each with its look, cut once at `width` as `fit` cuts
// a text: the pieces past the cut are left out, the one it falls in ends in ….
type Piece = { text: string; bold?: boolean; color?: string; dim?: boolean }
function fitParts(pieces: readonly Piece[], width: number): Piece[] {
  const whole = fit(pieces.map(p => p.text).join(''), width)
  let at = 0
  return pieces.flatMap(p => {
    const text = whole.slice(at, at + p.text.length)
    at += p.text.length
    return text ? [{ ...p, text }] : []
  })
}

// A due date's colour: red once passed, amber within 7 days, dim otherwise.
function dueLook(iso: string, now: number): { color?: string; dimColor?: boolean } {
  const soon = dueSoon(iso, now)
  return soon === 'passed' ? { color: 'error' } : soon === 'soon' ? { color: 'warning' } : { dimColor: true }
}

// How a place shows its due date (docs/whats-next/DRAWING.md): the short form (30 Oct) or
// the long one (30 Oct, in 19 days); `bare` leaves out the ⧗ before it, `done`
// draws it dim, and `width` pads it to a column. No due date shows nothing.
export type DueShown = { form: 'short' | 'long'; bare?: boolean; done?: boolean; width?: number }

// The words of a due date as `o` shows it; null where nothing is shown.
function dueWords(iso: string | null, now: number, o: DueShown): string | null {
  const words = iso ? `${o.bare ? '' : '⧗ '}${o.form === 'short' ? day(iso, now) : dueText(iso, now).text}` : null
  if (words === null) return o.width ? ''.padEnd(o.width) : null
  return o.width ? words.padEnd(o.width) : words
}

// How long ago `iso` was, as a short age: 5m, 3h, 6d, 3w, 4mo, 2y.
export function age(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)
  if (d < 14) return `${d}d`
  if (d < 60) return `${Math.floor(d / 7)}w`
  if (d < 730) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

// Whom a child is with, for the right of its row: the first assignee of
// one with others, or of one blocked that someone holds.
export const whoOf = (c: { assignees: string[] }, st: Standing) =>
  st === 'withOthers' || (st === 'blocked' && c.assignees.length > 0) ? (c.assignees[0] ?? '') : ''

// One part of a line made of parts: its words, dim unless it has a
// colour, or drawn as `node` where it is more than one text.
export type Part = { text: string; color?: string; node?: RenderChildren }

// A row's mark and the space after it (DRAWING-issue.md, Marks).
// Closed in a detail: a grey ✓ where the mark goes.
export const CLOSED_MARK: Mark = { glyph: '✓', color: 'inactive' }

// The bar and count take 15 columns at the end of a row, the count alone 6;
// a closed row ends in ✓ where an open one's count ends.
export const COUNT = 15
export const CLOSED_END = '✓'.padStart(COUNT - 1)

// One issue as every list shows it (DRAWING-issue.md): its mark, number
// and title on a button that opens it, and under it the facts line: what
// blocks it, how many it unblocks, its due date, its milestone (unless the
// milestone filter is set to it), its labels in colour and its age. `lead` indents it in a tree; `who` names
// whom it is with, dim at the right.
export type RowIssue = Pick<IssueRow, 'number' | 'title' | 'labels' | 'milestone' | 'created' | 'due'>
export type RowLook = {
  key: string
  buttonKey: string
  numWidth: number
  standing: Standing
  bold?: boolean
  lead?: number
  who?: string
  blockedBy?: number[]
  // Leaves the milestone out of the facts, where the list is one milestone's.
  noMilestone?: boolean
  // A row with children of its own, in the tree: its fold mark, coloured by
  // its standing, a target of its own (none for one shown above), and how
  // many of its children are closed, of all, at the right.
  fold?: { state: Folding; key: string; onPress?: () => unknown }
  count?: string
  // Said dim on the second line, in place of the facts.
  note?: string
  onPress: () => unknown
}

// How a tree is drawn in a pane: its first level `lead` columns in, each
// level two more; its rows are addressed `button`-n, open their issue with
// `onOpen` and fold it with `onFold`. `drawn` counts each issue drawn in the
// pane so far, so one shown again gets another address; `at` sets its
// closing lines apart.
export type TreeLook = {
  lead: number
  numWidth: number
  button: string
  drawn: Map<number, number>
  at: string
  onOpen: (n: number) => unknown
  onFold: (n: number) => unknown
}

// An open epic at the top of a tree: where it sits, its addresses, whether
// it is folded open, and what pressing its mark or the rest of it does.
export type EpicLook = {
  key: string
  foldKey: string
  openKey: string
  lead: number
  numWidth: number
  open: boolean
  noMilestone?: boolean
  onFold: () => unknown
  onOpen: () => unknown
}

// With Debug on: what the last action and the session asked the forge.
export type Requests = { label: string; count: number; total: number }

// The drawing for one render, made from its look.
export type Draw = ReturnType<typeof draw>

export function draw(look: Look) {
  const { Box, Text, Button } = look.ui
  const { columns, today } = look

  // A button's label: its icon when icons are on, else its words.
  const say = (icon: string, words: string) => (look.icons ? icon : words)

  // A due date, drawn: every due date in the panes is drawn by this.
  const dueDate = (key: string, iso: string | null, now: number, o: DueShown): RenderChildren | null => {
    const words = dueWords(iso, now, o)
    if (words === null) return null
    return (
      <Text key={key} {...(iso && !o.done ? dueLook(iso, now) : { dimColor: true })}>
        {words}
      </Text>
    )
  }
  const line = (key: string, text: string, props: Record<string, unknown> = {}) => (
    <Text key={key} wrap="truncate-end" {...props}>
      {text}
    </Text>
  )
  // `… n more lines` under text cut to its first lines, Description's or a
  // comment's: a dim button that shows the rest (DRAWING-issue.md).
  const moreLine = (key: string, n: number, onPress: () => unknown) => (
    <Box key={`${key}-row`} height={1} flexShrink={0}>
      <Button key={key} plain dimColor onPress={onPress}>
        {`… ${n} more lines`}
      </Button>
    </Box>
  )
  // Parts joined by a dim ` · ` (DRAWING.md, Lines that hold several parts).
  const joined = (parts: readonly Part[]): RenderChildren[] =>
    parts.flatMap((p, k) => [
      ...(k > 0 ? [<Text key={`sep-${k}`} dimColor>{' · '}</Text>] : []),
      p.node ?? (
        <Text key={`part-${k}`} color={p.color} dimColor={!p.color}>
          {p.text}
        </Text>
      ),
    ])
  // How many open issues block an issue, and how many wait on it, on its
  // facts line: each a count, dim; which ones, the issue detail
  // (DRAWING-issue.md, The facts line). ↦: the bar this issue, the arrow
  // what it opens.
  const blockedPart = (n: number): Part => ({ text: `⊘ ${n}` })
  const unblocksPart = (n: number): Part => ({ text: `↦ ${n}` })
  // A due date as one part of a line: none where there is no due date, so
  // a line never starts with ` · `.
  const duePart = (key: string, iso: string | null, now: number, o: DueShown): Part[] =>
    iso ? [{ text: dueWords(iso, now, o) ?? '', node: dueDate(key, iso, now, o) }] : []
  // A line of parts `lead` columns in: one text, cut once at its end, so a
  // narrow pane cuts its last parts and never squeezes them one by one.
  const partsLine = (key: string, lead: number, parts: readonly Part[]) => (
    <Text key={key} wrap="truncate-end">
      {' '.repeat(lead)}
      {joined(parts)}
    </Text>
  )
  // A rule (DRAWING.md, Rules): `── ` dim, its name bold, what belongs to it
  // after ` · `, and the line to the pane's edge, in one text. One that is a
  // target is one Button: one that folds starts with its + or − instead,
  // plain; one that opens something (`open` absent) keeps its `── `.
  const rule = (key: string, name: string, after: readonly Part[] = [], press?: { key: string; open?: boolean; onPress: () => unknown }) => {
    const folds = press?.open !== undefined
    const lead = folds ? `${press.open ? '−' : '+'} ` : '── '
    const used = lead.length + name.length + after.reduce((n, p) => n + 3 + p.text.length, 0) + 1
    // Text inside a Button wraps instead of truncating: there a rule too
    // long for the pane is cut here, once at its end, its parts as words.
    const cut = press && used > columns
    const shown = cut ? fitParts([{ text: lead, dim: !folds }, { text: name, bold: true }, ...after.flatMap(p => [{ text: ' · ', dim: true }, { text: p.text, color: p.color, dim: !p.color }])], columns) : null
    const text = shown ? (
      <Text wrap="truncate-end">
        {shown.map((p, i) => (
          <Text key={`piece-${i}`} bold={p.bold} color={p.color} dimColor={p.dim}>
            {p.text}
          </Text>
        ))}
      </Text>
    ) : (
      <Text wrap="truncate-end">
        <Text dimColor={!folds}>{lead}</Text>
        <Text bold>{name}</Text>
        {after.length > 0 && <Text dimColor>{' · '}</Text>}
        {joined(after)}
        <Text dimColor>{` ${'─'.repeat(Math.max(0, columns - used))}`}</Text>
      </Text>
    )
    return (
      <Box key={key} height={1} flexShrink={0}>
        {press ? (
          <Button key={press.key} plain onPress={press.onPress}>
            {text}
          </Button>
        ) : (
          text
        )}
      </Box>
    )
  }
  const markText = (m: Mark) => (
    <Text key="mark" color={m.color} dimColor={m.dim}>
      {`${m.glyph} `}
    </Text>
  )
  // An issue's number at the right of its column, and a space: blue, grey
  // once closed (DRAWING-issue.md, Number and title).
  const numberText = (n: number, width: number, closed = false) => (
    <Text key="number" color={closed ? 'inactive' : 'suggestion'}>{`${`#${n}`.padStart(width - 1)} `}</Text>
  )
  // How many are closed, of all, at the end of a row: the bar where the row
  // has room for one, then the count, dim in 6 columns (DRAWING.md, Counts).
  const barText = (closed: number, total: number): RenderChildren[] => {
    const b = bar(closed, total)
    return [
      b.filled ? (
        <Text key="filled" color="success">
          {b.filled}
        </Text>
      ) : null,
      b.empty ? (
        <Text key="empty" dimColor>
          {b.empty}
        </Text>
      ) : null,
    ]
  }
  const countText = (closed: number, total: number, withBar: boolean): RenderChildren[] => [
    ...(withBar ? barText(closed, total) : []),
    <Text key="count" dimColor>
      {`${closed}/${total}`.padStart(6)}
    </Text>,
  ]
  // A closed epic: one grey row, `lead` columns in, ending in ✓ where an open
  // one's count ends; it opens its detail.
  const closedRow = (key: string, buttonKey: string, lead: number, n: number, numWidth: number, title: string, onPress: () => unknown) => {
    const width = Math.max(0, columns - lead - numWidth - COUNT)
    return (
      <Box key={key} flexShrink={0}>
        <Button key={buttonKey} plain onPress={onPress}>
          <Text wrap="truncate-end" color="inactive">
            {`${' '.repeat(lead)}${`#${n}`.padStart(numWidth - 1)} ${fit(title, width).padEnd(width)} ${CLOSED_END}`}
          </Text>
        </Button>
      </Box>
    )
  }
  // How many children or issues under an unfolded row are closed: one grey
  // line in the mark column, `lead` columns in.
  const closedLine = (key: string, lead: number, n: number) => line(key, `${' '.repeat(lead)}✓ ${n} closed`, { color: 'inactive' })
  // A row at the top of a tree that folds (DRAWING.md, Rows that fold): its
  // mark, a target that folds it, then the rest of the row, `body`, a target
  // that opens its detail.
  const foldRow = (o: {
    lead: number
    mark: Mark
    foldKey: string
    onFold: () => unknown
    openKey: string
    onOpen: () => unknown
    body: RenderChildren[]
    color?: string
  }) => (
    <Box height={1}>
      {o.lead > 0 && <Text>{' '.repeat(o.lead)}</Text>}
      <Button key={o.foldKey} plain onPress={o.onFold}>
        {markText(o.mark)}
      </Button>
      <Button key={o.openKey} plain onPress={o.onOpen}>
        <Text wrap="truncate-end" color={o.color}>
          {o.body}
        </Text>
      </Button>
    </Box>
  )
  // A wrapped paragraph in which `a command` shows as a command and an
  // https:// address as a link; the backticks themselves are not drawn.
  const para = (key: string, text: string, props: Record<string, unknown> = {}) => {
    const parts: RenderChildren[] = []
    text.split(/`([^`]+)`/).forEach((piece, i) => {
      if (i % 2 === 1) {
        parts.push(<Text key={`${key}-c${i}`} color="warning">{piece}</Text>)
        return
      }
      piece.split(/(https:\/\/\S+?)(?=[.,;:)]?(?:\s|$))/).forEach((bit, j) => {
        if (bit === '') return
        parts.push(
          j % 2 === 1 ? (
            <Text key={`${key}-u${i}-${j}`} color="suggestion" underline>
              {bit}
            </Text>
          ) : (
            bit
          ),
        )
      })
    })
    return (
      <Text key={key} wrap="wrap" {...props}>
        {parts}
      </Text>
    )
  }
  // Labels as text, each in its Forgejo colour (made lighter when too dark),
  // dim when it has none; commas between them dim.
  const labelTexts = (labels: readonly { name: string; color: string }[]) =>
    labels.flatMap((l, k) => {
      const color = readable(l.color)
      return [
        ...(k > 0 ? [<Text key={`lsep-${k}`} dimColor>{', '}</Text>] : []),
        <Text key={`label-${k}`} color={color} dimColor={!color}>
          {l.name}
        </Text>,
      ]
    })
  // Compact: no empty line between rows, anywhere.
  const gap = look.compact ? 0 : 1
  // A section still ends in an empty line with Compact on, where its rows
  // no longer leave one (DRAWING.md, Rules).
  const sectionEnd = (key: string) => (look.compact ? [<Box key={`end-${key}`} height={1} flexShrink={0} />] : [])
  // How many open issues wait on issue `n`, as far as What's next knows.
  const waiting = (n: number) => look.unblocks[n] ?? 0
  // The facts line's recipe (DRAWING-issue.md, The facts line), for an
  // issue row and an epic's alike: what blocks it, how many it unblocks, its
  // due date, its milestone (unless the list is that milestone's), its
  // labels and its age.
  const factsOf = (i: RowIssue, o: { blockedBy?: number[]; noMilestone?: boolean }): Part[] => {
    const shownFilter = look.filter
    const shownMilestone = !o.noMilestone && i.milestone !== null && !(shownFilter && sameFilter(shownFilter.set, ofMilestone(i.milestone)))
    return [
      ...(o.blockedBy && o.blockedBy.length > 0 ? [blockedPart(o.blockedBy.length)] : []),
      ...(waiting(i.number) > 0 ? [unblocksPart(waiting(i.number))] : []),
      ...duePart('due', i.due, today, { form: 'short' }),
      ...(shownMilestone ? [{ text: i.milestone ?? '' }] : []),
      ...(i.labels.length > 0 ? [{ text: '', node: labelTexts(i.labels) }] : []),
      ...(i.created ? [{ text: `✎ ${age(i.created, today)}` }] : []),
    ]
  }
  const issueRow = (i: RowIssue, o: RowLook) => {
    const lead = ' '.repeat(o.lead ?? 0)
    const dim = o.standing === 'blocked'
    const facts: Part[] = o.note ? [{ text: o.note }] : factsOf(i, o)
    const room = columns - (o.lead ?? 0) - 2 - o.numWidth - (o.count !== undefined ? 6 : 0)
    const title =
      o.who || o.count !== undefined
        ? `${fit(i.title, room - (o.who ? o.who.length + 1 : 0)).padEnd(room - (o.who ? o.who.length + 1 : 0))}${o.who ? ' ' : ''}`
        : fit(i.title, room)
    const fold = o.fold
    const mark = markOf(o.standing, fold?.state ?? null)
    const rest = [
      numberText(i.number, o.numWidth),
      dim ? <Text key="title" dimColor>{title}</Text> : title,
      o.who ? <Text key="who" dimColor>{o.who}</Text> : null,
      o.count !== undefined ? <Text key="count" dimColor>{o.count.padStart(6)}</Text> : null,
    ]
    return (
      <Box key={o.key} flexDirection="column" marginBottom={gap} flexShrink={0}>
        {fold ? (
          // Two targets, as an epic's: the mark folds, the rest opens its detail.
          <Box height={1}>
            <Text>{lead}</Text>
            {fold.onPress ? (
              <Button key={fold.key} plain onPress={fold.onPress}>
                {markText(mark)}
              </Button>
            ) : (
              markText(mark)
            )}
            <Button key={o.buttonKey} plain onPress={o.onPress}>
              <Text wrap="truncate-end">{rest}</Text>
            </Button>
          </Box>
        ) : (
          <Button key={o.buttonKey} plain onPress={o.onPress}>
            <Text wrap="truncate-end" bold={o.bold}>
              {lead}
              {markText(mark)}
              {rest}
            </Text>
          </Button>
        )}
        {/* One row: a line too long for the pane is cut, but would still
            take the height of its overflow. The indent keeps its width, so
            a cut line starts under the title like the others. */}
        {facts.length > 0 && (
          <Box height={1}>
            <Box key="indent" flexShrink={0}>
              <Text>{`${lead}${' '.repeat(2 + o.numWidth)}`}</Text>
            </Box>
            {partsLine('facts', 0, facts)}
          </Box>
        )}
      </Box>
    )
  }
  // The lines under an unfolded row, as `tree` in epics.ts laid them out:
  // each child an issue row, and the closing lines.
  const tree = (under: TreeLine[], o: TreeLook): RenderChildren[] =>
    under.map((l, k) => {
      const lead = o.lead + 2 * l.depth
      if (l.kind !== 'child') {
        // A closing line sets itself apart from a row after it.
        const after = under[k + 1]?.kind === 'child' ? gap : 0
        const at = `${o.at}-${k}`
        const text = `${' '.repeat(lead + o.numWidth)}${l.kind === 'unknown' ? 'children unknown' : l.kind === 'none' ? 'no children' : 'Loading the children…'}`
        return (
          <Box key={`${l.kind}-${at}`} flexShrink={0} marginBottom={after}>
            {l.kind === 'closed' ? closedLine(`${l.kind}-line-${at}`, lead, l.closed) : line(`${l.kind}-line-${at}`, text, { dimColor: true })}
          </Box>
        )
      }
      const c = l.child
      // An issue shown twice needs another address the second time.
      const times = (o.drawn.get(c.number) ?? 0) + 1
      o.drawn.set(c.number, times)
      const at = times === 1 ? `${c.number}` : `${c.number}@${times}`
      const st = standing(c)
      return issueRow(c, {
        key: `${o.button}-row-${at}`,
        buttonKey: `${o.button}-${at}`,
        numWidth: o.numWidth,
        lead,
        standing: st,
        who: whoOf(c, st),
        blockedBy: st === 'blocked' ? c.blockedBy : undefined,
        ...(l.fold && {
          fold:
            l.fold === 'shown above'
              ? { state: l.fold, key: `fold-${at}` }
              : { state: l.fold, key: `fold-${at}`, onPress: () => o.onFold(c.number) },
          count: l.count ? `${l.count.closed}/${l.count.total}` : '',
          ...(l.fold === 'shown above' && { note: 'shown above' }),
        }),
        onPress: () => o.onOpen(c.number),
      })
    })

  // The for-you line under a folded epic: `children` first, dim, so its
  // `⊘ n` is not read as the epic's own (DRAWING-issue.md, The for-you line);
  // `no children` and `children unknown` say it already.
  const forChildren = (key: string, lead: number, parts: readonly Part[]) =>
    parts.length === 1 && (parts[0]?.text === 'no children' || parts[0]?.text === 'children unknown') ? (
      partsLine(key, lead, parts)
    ) : (
      <Text key={key} wrap="truncate-end">
        {' '.repeat(lead)}
        <Text dimColor>{'children '}</Text>
        {joined(parts)}
      </Text>
    )
  // An open epic at the top of a tree, in Epics and under a milestone: its
  // fold mark, number, bold title, bar and count; under it its facts line,
  // as any issue row's; folded, then the for-you line: what there is for
  // you in it (DRAWING-issue.md, The for-you line).
  const epicRow = (x: Epic, o: EpicLook) => {
    const facts = factsOf(
      { number: x.number, title: x.title, labels: x.labels ?? [], milestone: x.milestone ?? null, created: x.created ?? '', due: x.due },
      { blockedBy: x.blockedBy, noMilestone: o.noMilestone },
    )
    const under = o.lead + 2 + o.numWidth
    const t = tally(x.children ?? [])
    const width = Math.max(0, columns - o.lead - 2 - o.numWidth - COUNT)
    return (
      <Box key={o.key} flexDirection="column" flexShrink={0} marginBottom={o.open ? 0 : gap}>
        {foldRow({
          lead: o.lead,
          mark: markOf(null, o.open ? 'unfolded' : 'folded'),
          foldKey: o.foldKey,
          onFold: o.onFold,
          openKey: o.openKey,
          onOpen: o.onOpen,
          body: [
            numberText(x.number, o.numWidth),
            <Text key="title" bold>
              {`${fit(x.title, width).padEnd(width)} `}
            </Text>,
            ...countText(t.closed, t.total, true),
          ],
        })}
        {facts.length > 0 && partsLine(`facts-${o.key}`, under, facts)}
        {!o.open && forChildren(`under-${o.key}`, under, summary(x))}
      </Box>
    )
  }

  // The bottom line of every pane and detail: a rule naming What's Next and
  // its `version`, which opens the repo (`onPress`; none without one)
  // (DRAWING.md, Rules). Cut at its end on a narrow pane, as every rule.
  // An empty line before it, as before every rule, kept when the list or
  // detail above is cut at its bottom.
  const bottomLine = (version: string | null, onPress?: () => unknown) => [
    <Box key="where-gap" height={1} flexShrink={0} />,
    rule('where', "What's Next", version ? [{ text: `v${version}` }] : [], onPress ? { key: 'repository', onPress } : undefined),
  ]
  // With Debug on, under the bottom line: what the last action and the session
  // asked the forge, its parts dim (DRAWING.md, Lines that hold several parts).
  const requestsLine = (req: Requests | null) =>
    req && (
      <Box key="requests" height={1} flexShrink={0}>
        {partsLine('requests-text', 0, [{ text: `↯ ${req.label}: ${req.count} requests` }, { text: `${req.total} this session` }])}
      </Box>
    )

  return {
    say,
    dueDate,
    line,
    moreLine,
    joined,
    blockedPart,
    unblocksPart,
    duePart,
    partsLine,
    rule,
    markText,
    numberText,
    barText,
    countText,
    closedRow,
    closedLine,
    foldRow,
    para,
    labelTexts,
    gap,
    sectionEnd,
    factsOf,
    issueRow,
    tree,
    forChildren,
    epicRow,
    bottomLine,
    requestsLine,
  }
}
