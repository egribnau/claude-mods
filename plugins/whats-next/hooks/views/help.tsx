import type { RenderChildren } from 'claude-code'

import { forYou, markOf } from '../epics'
import { HELP, type Look as Colour, type Sign } from '../help'
import { wrap } from '../issue'
import type { Frame, Pane } from './frame'

// The help page, in place of the list or detail it was opened over
// (DRAWING.md, The help page): each sign drawn by the helpers the panes
// draw it with, in a gutter, and its words wrapped under themselves.
export function helpView(p: Pane, f: Frame) {
  const { draw: d, acts } = p
  const { Box, Text } = p.look.ui
  const now = p.look.today
  const LOOK: Record<Colour, Record<string, unknown>> = {
    plain: {},
    dim: { dimColor: true },
    blue: { color: 'suggestion' },
    green: { color: 'success' },
    amber: { color: 'warning' },
    red: { color: 'error' },
    grey: { color: 'inactive' },
    purple: { color: 'merged' },
  }
  const signOf = (x: Sign): RenderChildren => {
    switch (x.kind) {
      case 'mark':
        return d.markText(markOf(x.standing, x.fold, x.closed))
      case 'due':
        return d.dueDate('due', new Date(now + x.days * 86400000).toISOString(), now, { form: 'short' })
      case 'bar':
        return d.countText(x.closed, x.total, true)
      case 'forYou':
        return [
          ...(x.children ? [<Text key="children" dimColor>{'children '}</Text>] : []),
          ...d.joined(forYou({ closed: 0, total: 0, ...x })),
        ]
      case 'blockedBy':
        return d.joined([d.blockedPart(x.count)])
      case 'unblocks':
        return d.joined([d.unblocksPart(x.count)])
      case 'label':
        return d.labelTexts([{ name: x.name, color: x.color }])
      case 'text':
        return x.parts.map((part, k) => (
          <Text key={`part-${k}`} {...LOOK[part.look]}>
            {part.text}
          </Text>
        ))
    }
  }
  // The text a sign draws, to size the gutter: as wide as the widest sign
  // and two spaces (DRAWING.md, The help page).
  const plain = (n: RenderChildren): string =>
    n === null || n === undefined || typeof n === 'boolean'
      ? ''
      : typeof n === 'string' || typeof n === 'number'
        ? String(n)
        : Array.isArray(n)
          ? (n as readonly RenderChildren[]).map(plain).join('')
          : plain((n as { children?: RenderChildren }).children ?? (n as { props?: { children?: RenderChildren } }).props?.children ?? null)
  const GUTTER = Math.max(...HELP.flatMap(s => s.lines.map(l => plain(signOf(l.sign)).length))) + 2
  const room = Math.max(10, p.look.columns - GUTTER)
  const body: RenderChildren[] = HELP.flatMap((section, k) => [
    ...(k > 0 ? [<Box key={`help-gap-${k}`} height={1} flexShrink={0} />] : []),
    d.rule(`help-rule-${k}`, section.name),
    ...section.lines.flatMap((l, j) =>
      wrap(l.words, room).map((words, w) => (
        <Box key={`help-${k}-${j}-${w}`} height={1} flexShrink={0}>
          <Box key="sign" width={GUTTER} flexShrink={0}>
            {w === 0 && <Text wrap="truncate-end">{signOf(l.sign)}</Text>}
          </Box>
          {d.line('words', words)}
        </Box>
      )),
    ),
  ])
  return f.detailFrame(f.detailTop([f.refreshAction], acts.leaveHelp), body, f.menuLines([f.refreshAction]))
}
