# What's Next: terminology

The words What's Next uses, one word per thing, in the panes, the README,
the canvas, issues and code comments. A new word for an existing thing is
not added; a word that is replaced is listed under Not used, with what
replaced it. What a term means, not how or where it is drawn: that is
DRAWING.md.

## The tracker

| Term | Means |
|---|---|
| forge | The server the repo lives on: Forgejo (or Gitea), GitLab or GitHub. |
| repo | The repo behind the current directory's `origin`; on GitLab, the project. |
| issue | An issue of the repo. Pull and merge requests are never issues here. |
| open, closed | An issue's or a milestone's state, as the forge says. |
| milestone | A forge milestone of the repo. |
| due date | The date an issue or a milestone is due, if it has one. |
| epic | An issue with the Epic label (the label is a setting). |
| child | An issue an epic holds, or on GitHub any issue. On Forgejo: an issue the epic depends on, other epics left out (an epic that depends on another waits for it). On GitLab: an issue it links as related, other epics left out (a related link has no direction). On GitHub: a sub-issue, of any issue. Only on GitHub does a child have children of its own, and unfold to them. |
| blocker | An open issue that another one waits on. On Forgejo: a dependency. On GitLab EE: a blocking link. On GitHub: a "blocked by" relation. |
| blocked by, blocks | The two sides of a blocker, as the issue detail lists them. |

## How an issue stands for you

Each open issue is exactly one of these, in this order of precedence.

| Term | Means |
|---|---|
| yours | Assigned to you. Wins over blocked. |
| blocked | Not yours, and waiting on an open blocker. |
| with others | Assigned to someone else and not blocked. |
| available | Assigned to no one and not blocked: free to take. |

`Nothing available`: What's next has no available issue, because every
free one is blocked.

## Panes and their parts

| Term | Means |
|---|---|
| pane | One of What's Next's docked panes: What's next, Epics, Milestones. |
| What's next | The pane of In progress, Next and the Queue. |
| In progress | Your open issues. |
| Next | The available issue to take now. |
| Queue | The available issues after Next. |
| Epics | The pane of epics, grouped by milestone. |
| Milestones | The pane of open milestones, then Closed. |
| Closed | The section of closed milestones in Milestones. |
| picker | The milestone choice What's next and Epics share: a milestone, No milestone, or All. |
| detail | An issue or a milestone shown in place of the list, left with Back. |
| section | A part of a list or a detail under a rule that folds with + or −: Closed in Milestones; Issues and Description in the milestone detail. |
| row | One issue, epic or milestone in a list. |
| fold, unfold | Hide or show what is under an epic, a child with children, or a milestone. |
| shown above | An issue already in the tree higher up, shown again under a second parent or in a loop, and not unfolded there. |
| for-you line | What there is for you: how many are yours, blocked, available, or with others. |
| bottom line | The last line of a pane. |

## Actions

| Term | Does |
|---|---|
| Refresh | Asks the forge again for everything shown. |
| Back | Returns to the issue a detail was reached from, else to the list. |
| Work on this | Assigns you if needed and drafts a prompt from the issue. |
| Assign me, Unassign me | Adds or removes only you as assignee. |
| Close, Reopen | Closes or reopens the issue or milestone. |
| Open in browser | Opens the issue's or milestone's page on the forge. |

## Setup

| Term | Means |
|---|---|
| setup | The steps checked before the panes show: Repo, Forge, Token, Access, Actions. |
| token | An access token for the forge, from its token setting only. |
| read only | What's Next may read but not assign or close; setup's Actions step says why. |
| Compact, Icons | The settings for how lists and buttons look. |

## When something is not known

| Term | Means |
|---|---|
| Loading … | Asked of the forge, no answer yet. |
| unknown | The forge would not say (children unknown, issues unknown). |
| no due date | What is said for a missing due date, where one is said. |

## Not used

| Word | Use instead | Why |
|---|---|---|
| up for grabs | available | Informal; replaced in 0.61.0. |
| ready | available | Reads as "done"; replaced in 0.61.0. |
| My issues | What's next, In progress | The pane was renamed in 0.24.0. |
