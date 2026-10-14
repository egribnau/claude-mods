import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Where } from '../types'
import { HERE, milestoneOf } from './where'

// The panes' ids: What's next, Epics and Milestones.
export const PANE = 'next'
export const EPICS_PANE = 'next-epics'
export const MILESTONES_PANE = 'next-milestones'

// Per pane, keyed by its id: where it is (hooks/where.ts).
const where = atom({ plugin: 'whats-next', key: 'where' } as const, HERE)

// Where pane `pane` is, and the pane moved by one of where.ts's steps.
export function placeOf($: EngineInterface, pane: string): Promise<Where> {
  return read($, memberOf(where, { requestId: pane }))
}
export function go($: EngineInterface, pane: string, change: (w: Where) => Where) {
  return update($, memberOf(where, { requestId: pane }), change)
}
// The milestone the Milestones pane has open, null when it shows its list.
export async function milestoneShown($: EngineInterface) {
  return milestoneOf(await placeOf($, MILESTONES_PANE))
}
