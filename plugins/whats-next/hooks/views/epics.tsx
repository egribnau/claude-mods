import { atom, read } from 'claude-code'
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { Epic, Repo } from '../../types'
import type { Part } from '../draw'
import { tree } from '../epics'
import { slug } from '../tracker'
import { EPICS_PANE } from '../panes'
import { treeKnown, type Frame, type Pane } from './frame'

// The state this view reads (the contract in types/index.d.ts).
const epics = atom({ plugin: 'whats-next', key: 'epics' } as const, { kind: 'idle' })
const unfolded = atom({ plugin: 'whats-next', key: 'unfolded' } as const, [])

// The Epics pane, once setup passes, for repo `r`: the open epics within
// the milestone filter, by milestone, each folding open to its tree.
export async function epicsView($: EngineInterface, p: Pane, f: Frame, r: Repo) {
  const { draw: d, acts } = p
  const { Box } = p.look.ui
  const gap = d.gap
  const now = p.look.today
  const ep = await read($, epics)
  const folds = new Set(await read($, unfolded))
  const { kidsOf, openEpics } = await treeKnown($, p)
  const openIssue = (n: number) => acts.openIssue(EPICS_PANE, n)
  const groups = ep.kind === 'ok' ? ep.groups : []
  const rows: RenderChildren[] = []
  if (ep.kind === 'loading' || ep.kind === 'idle') rows.push(d.line('loading', 'Loading the epics…', { dimColor: true }))
  if (ep.kind === 'error') rows.push(d.para('error', `Could not load the epics: ${ep.message}.`, { color: 'error' }))
  if (ep.kind === 'ok' && groups.length === 0) rows.push(d.para('none', `No open epics in ${slug(r)}.`, { dimColor: true }))
  const open = (x: Epic) => x.state === 'open' && folds.has(x.number)
  // The tree under each unfolded epic, from what is loaded so far.
  const { lines: treeLines } = tree(groups.flatMap(g => g.epics), kidsOf, folds, openEpics)
  // One number column for every group, so all titles line up.
  const numbers = groups.flatMap(g =>
    g.epics.flatMap(x => [x.number, ...(treeLines.get(x.number) ?? []).flatMap(l => (l.kind === 'child' ? [l.child.number] : []))]),
  )
  const numWidth = Math.max(0, ...numbers.map(n => `#${n}`.length)) + 1
  const drawn = new Map<number, number>()
  // Whether what was pushed last ends in an empty line: an open epic's row
  // or tree does without Compact, a closed epic's row never does.
  let blank = false
  groups.forEach((g, gi) => {
    // The group's rule: the milestone's name, its due date and how many of
    // its issues are closed.
    const due: Part[] = g.title ? d.duePart('due', g.due, now, { form: 'short' }) : []
    rows.push(
      // After the first, one empty line before it (DRAWING.md, Rules).
      <Box key={`group-${gi}`} flexShrink={0} marginTop={gi > 0 && !blank ? 1 : 0}>
        {d.rule(`group-rule-${gi}`, g.title ?? 'No milestone', g.title ? [...due, { text: `${g.closed}/${g.total} closed` }] : [])}
      </Box>,
    )
    for (const x of g.epics) {
      // A closed epic has nothing to fold; its row opens its detail.
      if (x.state === 'closed') {
        rows.push(d.closedRow(`epic-${x.number}`, `epic-${x.number}`, 2, x.number, numWidth, x.title, () => openIssue(x.number)))
        blank = false
        continue
      }
      blank = !p.look.compact
      rows.push(
        d.epicRow(x, {
          key: `epic-${x.number}`,
          foldKey: `fold-${x.number}`,
          openKey: `epic-${x.number}`,
          lead: 0,
          numWidth,
          open: open(x),
          onFold: () => acts.foldIssue(x.number),
          onOpen: () => openIssue(x.number),
        }),
      )
      if (!open(x)) continue
      // Folded open: the tree under it, each level two columns further in.
      const under = treeLines.get(x.number) ?? []
      const kids = d.tree(under, { lead: 2, numWidth, button: 'child', drawn, at: `${x.number}`, onOpen: openIssue, onFold: acts.foldIssue })
      // The last child row brings its own empty line; a closing line needs one.
      const endsInRow = under.at(-1)?.kind === 'child'
      rows.push(
        <Box key={`kids-${x.number}`} flexDirection="column" flexShrink={0} marginBottom={endsInRow ? 0 : gap}>
          {kids}
        </Box>,
      )
    }
  })
  return f.listFrame(f.titleRow('Epics'), rows, await f.listOverlay())
}
