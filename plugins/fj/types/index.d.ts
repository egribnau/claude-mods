export type Milestone = { id: number; title: string; state: string }

export type Assigned = { number: number; title: string }

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
      assigned: Assigned | null
      assignedStatus: Status
      picked: number | null
      listTop: number
      view: 'main' | 'settings'
      detail: Detail | null
      detailStatus: Status
    }
  }
}
