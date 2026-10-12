import type { Folding, Standing } from './epics'

// The help page (docs/whats-next/DRAWING.md, The help page): what each sign
// and colour means, one page for every pane. Each line is a sign, drawn by
// the panes' own helpers so its colour cannot drift from theirs, and its
// words: the term of docs/whats-next/TERMINOLOGY.md, then what it means.

// How a sign is drawn: a mark as `markOf` draws it; a due date `days` from
// today as `dueDate` draws it; a bar and count as `barText`; the for-you
// line's parts as `forYou`; how many block an issue and wait on it as its
// facts line counts them;
// labels in their own colour; or words in one of the panes' colours.
export type Look = 'plain' | 'dim' | 'blue' | 'green' | 'amber' | 'red' | 'grey' | 'purple'
export type Sign =
  | { kind: 'mark'; standing: Standing | null; fold: Folding | null; closed?: boolean }
  | { kind: 'due'; days: number }
  | { kind: 'bar'; closed: number; total: number }
  | { kind: 'forYou'; yours: number; available: number; withOthers: number; blocked: number }
  | { kind: 'blockedBy'; count: number }
  | { kind: 'unblocks'; count: number }
  | { kind: 'label'; name: string; color: string }
  | { kind: 'text'; parts: { text: string; look: Look }[] }

export type HelpLine = { sign: Sign; words: string }
export type HelpSection = { name: string; lines: HelpLine[] }

const text = (t: string, look: Look = 'plain'): Sign => ({ kind: 'text', parts: [{ text: t, look }] })

// The gutter the signs stand in, in columns.
export const GUTTER = 20

export const HELP: readonly HelpSection[] = [
  {
    name: 'How an issue stands for you',
    lines: [
      { sign: { kind: 'mark', standing: 'yours', fold: null }, words: 'yours: assigned to you' },
      { sign: { kind: 'mark', standing: 'available', fold: null }, words: 'available: free to take' },
      { sign: { kind: 'mark', standing: 'withOthers', fold: null }, words: 'with others: assigned to another' },
      { sign: { kind: 'mark', standing: 'blocked', fold: null }, words: 'blocked: waits on an open issue' },
      { sign: text('✓', 'grey'), words: 'closed' },
    ],
  },
  {
    name: 'Rows that fold',
    lines: [
      { sign: { kind: 'mark', standing: 'available', fold: 'folded' }, words: 'folded: the mark unfolds it' },
      { sign: { kind: 'mark', standing: 'available', fold: 'unfolded' }, words: 'unfolded: the mark folds it' },
      { sign: text('+  −'), words: 'a section: its rule folds it' },
      { sign: { kind: 'mark', standing: null, fold: 'shown above' }, words: 'shown above: already higher up' },
    ],
  },
  {
    name: 'Under an issue',
    lines: [
      { sign: { kind: 'blockedBy', count: 2 }, words: 'blocked by 2 open issues' },
      { sign: { kind: 'unblocks', count: 2 }, words: 'unblocks: 2 issues wait on it' },
      { sign: { kind: 'due', days: 18 }, words: 'due date' },
      { sign: text('v0.3.0', 'dim'), words: 'milestone' },
      { sign: { kind: 'label', name: 'docs', color: 'e8875c' }, words: 'a label, in its own colour' },
      { sign: text('✎ 3w', 'dim'), words: 'opened 3 weeks ago' },
    ],
  },
  {
    name: 'Counts',
    lines: [
      { sign: { kind: 'bar', closed: 3, total: 8 }, words: '3 closed of 8' },
      { sign: { kind: 'forYou', yours: 2, available: 1, withOthers: 0, blocked: 1 }, words: '2 yours, 1 available, 1 blocked' },
      { sign: text('✓ 3 closed', 'grey'), words: '3 closed, not listed' },
      { sign: text('and 14 more', 'dim'), words: '14 more in the Queue' },
      { sign: text('… 4 more lines', 'dim'), words: 'press to read the rest' },
    ],
  },
  {
    name: 'Colours',
    lines: [
      { sign: text('#24', 'blue'), words: 'an issue number' },
      { sign: text('●  ▰▰', 'green'), words: 'yours; finished' },
      { sign: { kind: 'due', days: 3 }, words: 'due within 7 days' },
      { sign: text('all closed', 'amber'), words: 'all closed but open: close it' },
      { sign: { kind: 'due', days: -3 }, words: 'due date passed' },
      { sign: text('Could not …', 'red'), words: 'a refusal or an error' },
      { sign: text('#19 ✓', 'grey'), words: 'closed, and nothing else' },
      { sign: text('merged', 'purple'), words: 'merged: a merged pull request' },
      { sign: text('✎ 3w', 'dim'), words: 'facts, counts, a blocked row' },
    ],
  },
  {
    name: 'Buttons',
    lines: [
      { sign: text('[ ☰ ]'), words: 'menu: actions and their hotkeys' },
      { sign: text('[ ← ]'), words: 'Back: returns to where you were' },
      { sign: text('All ▾'), words: 'milestone filter' },
    ],
  },
]
