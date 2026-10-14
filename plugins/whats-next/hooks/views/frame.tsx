import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderChildren, RenderInput } from 'claude-code'

import type { IssueDetail, Milestone, MilestoneFilter, Where } from '../../types'
import type { Draw, Look, Requests } from '../draw'
import { fit } from '../draw'
import { filterKey, sameFilter } from '../filter'
import { wrap } from '../issue'
import type { Known } from '../load'
import { measure } from '../measure'
import type { Tracker } from '../tracker'
import * as step from '../where'
import { go } from '../panes'

// The state the frame reads and writes (the contract in types/index.d.ts).
const panesOpen = atom({ plugin: 'whats-next', key: 'panesOpen' } as const, [])
const filterOpen = atom({ plugin: 'whats-next', key: 'filterOpen' } as const, false)
const treeKids = atom({ plugin: 'whats-next', key: 'treeKids' } as const, {})

// What every view of a pane shares: what it is given to draw with, and the
// frame around its rows (the top row, the menu, the milestone filter's
// list, a detail's scrolling, the bottom line).

// A detail as last drawn in each pane, by pane id: how many rows it has,
// how many show, and the row each Button starts on. A pane showing a list
// has none: the engine's window stays where it is.
export const views = new Map<string, { rows: number; room: number; at: Map<string, number> }>()

// The Buttons each pane draws hidden, for the hotkeys of its menu while it
// is shut (DRAWING.md, The menu), and the first control drawn after them.
export const hidden = new Map<string, { keys: Set<string>; first: string }>()

// What a press does, for the views: each changes what the panes show, so
// none of it is done while drawing.
export type Acts = {
  refresh: () => unknown
  showHelp: () => unknown
  leaveHelp: () => unknown
  setFilter: (filter: MilestoneFilter, label: string) => unknown
  openIssue: (pane: string, n: number) => unknown
  followIssue: (n: number) => unknown
  goBack: () => unknown
  foldIssue: (n: number) => unknown
  foldMilestone: (title: string) => unknown
  openMilestone: (title: string | null) => unknown
  closeMilestone: (m: Milestone, closed: boolean) => Promise<unknown>
  assignMe: (i: IssueDetail, on: boolean) => Promise<boolean>
  writeIssue: (n: number, change: (t: Tracker) => Promise<string | null>, what: string) => Promise<boolean>
  workOn: (i: IssueDetail) => unknown
  openUrl: (url: string) => unknown
  counted: <T>(label: string, action: () => Promise<T>) => Promise<T>
  chooseIcons: (value: 'icons' | 'text') => unknown
  chooseCompact: (value: 'on' | 'off') => unknown
}

// What a view is given, beside the engine: the pane it draws and where that pane
// is, the look and the drawing made from it, what is known of the repo, the
// tracker behind it, and what a press does. `version` and `repository` are
// What's Next's own, for the bottom line; `requests` the Debug line's.
export type Pane = {
  e: RenderInput<'Pane'>
  id: string
  place: Where
  height: number
  look: Look
  draw: Draw
  known: Known | null
  tracker: Tracker | null
  acts: Acts
  version: string | null
  repository: string | null
  requests: Requests | null
}

// What a pane can do, in its menu (DRAWING.md, The menu): each its words,
// its hotkey and what pressing it does. Pressing one shuts the menu.
export type Action = { key: string; label: string; hotkey: string; onPress: () => unknown }

// What the trees know: the children loaded of any issue (undefined while
// not asked yet), and the repo's open epics.
export async function treeKnown($: EngineInterface, p: Pane) {
  const loadedKids = await read($, treeKids)
  const kidsOf = (n: number) => (n in loadedKids ? loadedKids[n] : undefined)
  const openEpics = p.known?.openEpics ?? new Set<number>()
  return { kidsOf, openEpics }
}

export type Frame = Awaited<ReturnType<typeof frame>>

// The frame of pane `p`, read once per render.
export async function frame($: EngineInterface, p: Pane) {
  const { id, look, draw: d, acts } = p
  const { Box, Text, Button } = look.ui
  const { columns } = look
  const height = p.height
  const bottomRule = d.bottomLine(p.version, p.repository ? () => acts.openUrl(p.repository ?? '') : undefined)
  const counter = d.requestsLine(p.requests)
  // The milestone filter both panes share, and what it is set to.
  const shownFilter = look.filter
  const setOption = shownFilter?.options.find(o => sameFilter(o.filter, shownFilter.set))
  const refreshAction: Action = { key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: acts.refresh }
  // Help, the last line of every menu but the help page's own.
  const helpAction: Action = { key: 'help', label: 'Help', hotkey: 'h', onPress: acts.showHelp }
  const menuShown = p.place.menu
  const run = (a: Action) => async () => {
    await go($, id, step.shutMenu)
    await a.onPress()
  }
  // [ ☰ ] at the right of a top row; it shuts the milestone filter's list,
  // as that shuts the menu: one list under the top row at a time.
  const menuButton = (
    <Button
      key="menu"
      label="☰"
      onPress={async () => {
        await update($, filterOpen, () => false)
        await go($, id, step.toggleMenu)
      }}
    />
  )
  // A list opened under the top row at its right, the menu's or the
  // milestone filter's: drawn over the rows beneath, which stay where they
  // are, in a dim frame. `width` is its lines', each padded to it so it
  // covers what is under it. The last child of the pane, so it is painted last.
  const overlay = (key: string, width: number, lines: RenderChildren[]) => (
    <Box
      key={key}
      position="absolute"
      top={1}
      left={Math.max(0, columns - width - 2)}
      width={Math.min(columns, width + 2)}
      flexDirection="column"
      borderStyle="single"
      borderDimColor
    >
      {lines}
    </Box>
  )
  // The menu open: each action's words and, dim at the right, its hotkey;
  // `note`, dim under them, says what it lacks.
  const MENU = 17
  const menuLines = (actions: readonly Action[], note?: string) =>
    menuShown &&
    overlay('menu-lines', MENU, [
      ...actions.map(a => (
        <Box key={`menu-line-${a.key}`} height={1} flexShrink={0}>
          <Button key={`menu-${a.key}`} plain onPress={run(a)}>
            <Text>
              {fit(a.label, MENU - 2).padEnd(MENU - 1)}
              <Text dimColor>{a.hotkey}</Text>
            </Text>
          </Button>
        </Box>
      )),
      ...(note
        ? wrap(note, MENU).map((t, k) => (
            <Box key={`menu-note-${k}`} height={1} flexShrink={0}>
              <Text dimColor>{t}</Text>
              {t.length < MENU && <Text>{' '.repeat(MENU - t.length)}</Text>}
            </Box>
          ))
        : []),
    ])
  // Every action's hotkey, the menu shut or open: Buttons drawn hidden, at
  // the start of the top row, before `first`, the first control drawn.
  const hotkeys = (actions: readonly Action[], first: string) => {
    hidden.set(id, { keys: new Set(actions.map(a => a.key)), first })
    return (
      <Box key="hotkeys" display="none">
        {actions.map(a => (
          <Button key={a.key} label={a.label} hotkey={a.hotkey} onPress={run(a)} />
        ))}
      </Box>
    )
  }
  // With another What's Next pane open the engine draws tabs that name both, so a
  // title row leaves its pane's name out.
  const tabbed = (await read($, panesOpen)).some(other => other !== id)
  // The title row both lists share: the pane's name when no tab names it,
  // the milestone filter, the menu. Milestones, which shows every milestone,
  // has no milestone filter.
  const titleRow = (name: string, withFilter = true) => {
    const shown = withFilter ? setOption : undefined
    return (
      <Box key="top" flexDirection="column" flexShrink={0}>
        <Box key="title" height={1} flexShrink={0}>
          {hotkeys([refreshAction, helpAction], shown ? 'milestone' : 'menu')}
          {!tabbed && (
            <Text bold wrap="truncate-end">
              {name}
            </Text>
          )}
          <Box flexGrow={1} />
          {shown && (
            <Button
              key="milestone"
              label={`${shown.label} ▾`}
              hotkey="m"
              onPress={async () => {
                await go($, id, step.shutMenu)
                await update($, filterOpen, o => !o)
              }}
            />
          )}
          <Box width={2} />
          {menuButton}
        </Box>
      </Box>
    )
  }
  // What a list draws over its rows: the milestone filter's list, open, each
  // milestone with its due date and the one set in bold; or the menu.
  const listOverlay = async (withFilter = true) => {
    const listOpen = withFilter && shownFilter !== null && setOption !== undefined && (await read($, filterOpen))
    if (listOpen && shownFilter) {
      return overlay(
        'choices',
        20,
        shownFilter.options.map(o => (
          <Box key={`choice-${filterKey(o.filter)}`} height={1} flexShrink={0}>
            <Button key={`milestone-${filterKey(o.filter)}`} plain onPress={() => acts.setFilter(o.filter, o.label)}>
              <Text bold={sameFilter(o.filter, shownFilter.set)}>
                {fit(o.label, 13).padEnd(14)}
                {d.dueDate('due', o.due ?? null, look.today, { form: 'short', bare: true, width: 6 })}
              </Text>
            </Button>
          </Box>
        )),
      )
    }
    return menuLines([refreshAction, helpAction])
  }
  // A list: its title row, its rows, then what sits above the bottom line
  // (`last`), the bottom line and what the list draws over its rows.
  const listFrame = async (top: RenderChildren, rows: RenderChildren[], over: RenderChildren, last: RenderChildren = null) => (
    <Box flexDirection="column" height={height}>
      {top}
      <Box key="gap" height={1} flexShrink={0} />
      <Box key="list" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {rows}
      </Box>
      {last}
      {bottomRule}
      {counter}
      {over}
    </Box>
  )
  // A detail: its top row, which stays, then its rows, scrolled by the mod
  // (DRAWING.md, A detail scrolls), then the bottom line, which stays.
  const detailFrame = (top: RenderChildren, body: RenderChildren[], over: RenderChildren) => {
    const shown = measure(body)
    const room = Math.max(1, height - measure(top).rows - 1 - 2 - (counter ? 1 : 0))
    const offset = Math.min(Math.max(0, shown.rows - room), p.place.scroll)
    views.set(id, { rows: shown.rows, room, at: shown.at })
    return (
      <Box flexDirection="column" height={height}>
        {top}
        <Box key="gap" height={1} flexShrink={0} />
        <Box key="detail" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {/* As tall as its rows, measured, and moved up by a negative margin:
              without a height the engine fits it to the room and squeezes rows
              out of it, and a placed Box's negative top it does not keep. */}
          <Box key="rows" marginTop={-offset} width={columns} height={shown.rows} flexShrink={0} flexDirection="column">
            {body}
          </Box>
        </Box>
        {bottomRule}
        {counter}
        {over}
      </Box>
    )
  }
  // A detail's top row: its hotkeys, [ ← ] that goes `back`, then `extra`
  // (Prompt on an issue) and the menu.
  const detailTop = (actions: readonly Action[], back: () => unknown, extra: RenderChildren = null) => (
    <Box key="top" flexDirection="column" flexShrink={0}>
      <Box key="title" height={1} flexShrink={0}>
        {hotkeys(actions, 'back')}
        <Button key="back" label="←" hotkey="b" onPress={back} />
        <Box flexGrow={1} />
        {extra}
        {extra && <Box width={2} />}
        {menuButton}
      </Box>
    </Box>
  )
  // A heading with, on its right, the pane's own action when it has one.
  const heading = (text: string, action?: { label: string }) => (
    <Box key="title" height={1} flexShrink={0}>
      {text && (
        <Text bold wrap="truncate-end">
          {text}
        </Text>
      )}
      <Box flexGrow={1} />
      {action && <Button key="refresh" label={action.label} hotkey="r" onPress={acts.refresh} />}
    </Box>
  )
  return { refreshAction, helpAction, menuLines, titleRow, listOverlay, listFrame, detailFrame, detailTop, heading }
}
