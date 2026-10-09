export type Milestone = { id: number; title: string; state: string }

// One open issue assigned to you in this repo, with what ranks it.
export type Mine = {
  number: number
  title: string
  milestone: number | null
  due: string | null
  created: string
  // Why it counts as in progress ('branch', 'PR #61'), or null.
  working: string | null
}

export type Detail = {
  number: number
  title: string
  state: string
  author: string
  created: string
  updated: string
  comments: number
  labels: string[]
  milestone: string | null
  assignees: string[]
  body: string
}

export type Child = { number: number; title: string; state: string }

export type Epic = {
  number: number
  title: string
  state: string
  children: Child[]
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    fj: {
      milestones: Milestone[]
      selected: number | null
      epics: Epic[]
      status: Status
      expanded: number[]
      mine: Mine[]
      assignedStatus: Status
      picked: number | null
      listTop: number
      view: 'main' | 'settings'
      detail: Detail | null
      detailStatus: Status
    }
  }
}
