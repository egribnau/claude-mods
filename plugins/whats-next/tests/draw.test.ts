import { expect, test } from 'claude-code/testing'

import { draw, type Look } from '../hooks/draw'
import type { IssueRow } from '../types'

// The drawing module on its own (DRAWING-issue.md, The facts line): a row
// drawn from a look and its arguments, with no forge, no engine and no pane.

type Node = { type: string; props: Record<string, unknown> }

// Elements as plain data, each its name and its props, children among them.
const element = (type: string) => (props: Record<string, unknown>): Node => ({ type, props })
const UI = { Box: element('Box'), Text: element('Text'), Button: element('Button') } as unknown as Look['ui']

const NOW = Date.parse('2026-10-09T12:00:00Z')

const ISSUE: Pick<IssueRow, 'number' | 'title' | 'labels' | 'milestone' | 'created' | 'due'> = {
  number: 29,
  title: 'Docs: config keys',
  labels: [{ name: 'docs', color: 'e8875c' }],
  milestone: 'v1.2',
  created: '2026-09-18T09:00:00Z',
  due: '2026-10-12T00:00:00Z',
}

const lookOf = (more: Partial<Look> = {}): Look => ({
  ui: UI,
  columns: 60,
  compact: false,
  icons: false,
  today: NOW,
  filter: null,
  unblocks: { 29: 2 },
  ...more,
})

type Tree = Node | string | number | boolean | null | undefined | readonly Tree[]
const tree = (n: unknown) => n as Tree

// Each element of a tree, depth first.
function elements(n: Tree): Node[] {
  if (n === null || n === undefined || typeof n !== 'object') return []
  if (Array.isArray(n)) return (n as readonly Tree[]).flatMap(elements)
  const node = n as Node
  return [node, ...elements(tree(node.props.children))]
}

// The words a tree draws, joined.
function words(n: Tree): string {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return (n as readonly Tree[]).map(words).join('')
  return words(tree((n as Node).props.children))
}

const key = (n: Node) => n.props.key

test('an issue row: mark, number and title on its button, then its facts line in order', () => {
  let opened = 0
  const row = draw(lookOf()).issueRow(ISSUE, {
    key: 'issue-29',
    buttonKey: 'pick-29',
    numWidth: 4,
    standing: 'available',
    blockedBy: [3],
    onPress: () => opened++,
  })
  const all = elements(tree(row))
  const button = all.find(n => n.type === 'Button' && key(n) === 'pick-29')
  expect(words(button)).toBe('○ #29 Docs: config keys')
  // What a press does is handed in: the button calls it, and nothing else.
  ;(button?.props.onPress as () => unknown)()
  expect(opened).toBe(1)
  const facts = all.find(n => n.type === 'Text' && key(n) === 'facts')
  expect(words(facts)).toBe('⊘ 1 · ↦ 2 · ⧗ 12 Oct · v1.2 · docs · ✎ 3w')
  // The due date amber within 7 days, the label in its own colour.
  const texts = elements(facts).filter(n => n.type === 'Text')
  expect(texts.find(t => words(t) === '⧗ 12 Oct')?.props.color).toBe('warning')
  expect(texts.find(t => words(t) === 'docs')?.props.color).toBe('#e8875c')
})

test('the facts line leaves out the milestone the milestone filter is set to, and what is not known', () => {
  const look = lookOf({
    filter: { options: [], set: { kind: 'milestone', title: 'v1.2' } },
    unblocks: {},
  })
  const row = draw(look).issueRow({ ...ISSUE, labels: [], due: null }, { key: 'issue-29', buttonKey: 'pick-29', numWidth: 4, standing: 'yours', onPress: () => undefined })
  const facts = elements(tree(row)).find(n => n.type === 'Text' && key(n) === 'facts')
  expect(words(facts)).toBe('✎ 3w')
})

test('with Compact on a row leaves no empty line under it', () => {
  const spaced = draw(lookOf()).issueRow(ISSUE, { key: 'issue-29', buttonKey: 'pick-29', numWidth: 4, standing: 'available', onPress: () => undefined })
  const compact = draw(lookOf({ compact: true })).issueRow(ISSUE, { key: 'issue-29', buttonKey: 'pick-29', numWidth: 4, standing: 'available', onPress: () => undefined })
  expect((spaced as unknown as Node).props.marginBottom).toBe(1)
  expect((compact as unknown as Node).props.marginBottom).toBe(0)
})
