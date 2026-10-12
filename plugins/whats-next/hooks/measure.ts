import type { RenderChildren } from 'claude-code'

// How many rows a tree the pane draws takes, and the row each Button in it
// starts on, by key: a detail scrolls its own rows (DRAWING.md, A detail
// scrolls), and follows the focus to a Button out of view. It reads the
// tree as the pane builds it: a Text, a Button or a string is one row (the
// panes cut their lines, never wrap them); a Box its `height` where it sets
// one, else its children, stacked in a column, side by side in a row, and
// its margins; a Box drawn `display: "none"` none.
export type Measured = { rows: number; at: Map<string, number> }

type Node = { type?: string; props?: Record<string, unknown>; children?: RenderChildren }

export function measure(tree: RenderChildren): Measured {
  const at = new Map<string, number>()
  const rows = height(tree, 0, at, 'column')
  return { rows, at }
}

function height(node: RenderChildren, top: number, at: Map<string, number>, flow: 'row' | 'column'): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return 1
  if (Array.isArray(node)) {
    let used = 0
    for (const child of node as readonly RenderChildren[]) {
      const h = height(child, flow === 'column' ? top + used : top, at, flow)
      used = flow === 'column' ? used + h : Math.max(used, h)
    }
    return used
  }
  const n = node as Node
  const props = n.props ?? {}
  if (n.type === 'Button') {
    if (typeof props.key === 'string' && !at.has(props.key)) at.set(props.key, top)
    return 1
  }
  if (n.type === 'Text') return 1
  if (props.display === 'none') return 0
  const before = typeof props.marginTop === 'number' ? props.marginTop : 0
  const after = typeof props.marginBottom === 'number' ? props.marginBottom : 0
  const inner = height(n.children ?? null, top + before, at, props.flexDirection === 'column' ? 'column' : 'row')
  return before + (typeof props.height === 'number' ? props.height : inner) + after
}
