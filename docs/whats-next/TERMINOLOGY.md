# What's Next: terminology

The words What's Next uses, one word per thing, in the panes, the README,
the canvas, issues and code comments. A new word for an existing thing is
not added; a word that is replaced is listed under Not used, with what
replaced it. What a term means, not how or where it is drawn: that is
DRAWING.md and DRAWING-issue.md.

## The tracker

| Term | Means |
|---|---|
| forge | The server the repo lives on: Forgejo (or Gitea), GitLab or GitHub. |
| repo | The repo behind the current directory's `origin`; on GitLab, the project. |
| issue | An issue of the repo. Pull and merge requests are never issues here. |
| open, closed | An issue's or a milestone's state, as the forge says. |
| all closed | Every issue of a milestone, or every child of an epic, closed. |
| milestone | A forge milestone of the repo. |
| due date | The date an issue or a milestone is due, if it has one. |
| epic | An issue with the Epic label (the label is a setting). |
| child | An issue an epic holds, or on GitHub any issue. On Forgejo: an issue the epic depends on, other epics left out (an epic that depends on another waits for it). On GitLab: an issue it links as related, other epics left out (a related link has no direction). On GitHub: a sub-issue, of any issue. Only on GitHub does a child have children of its own, and unfold to them. The issue detail lists them under `Children`, apart from Blocked by (#86). |
| parent | The issue an issue is a child of: its epic, or on GitHub any parent issue. The issue detail names it `Epic`, or `Parent` when it is not an epic (#62, built 0.68.0). |
| pull request | A forge's request to merge a branch, `PR`; GitLab calls it a merge request, `MR`, numbered `!61`. The panes use the forge's word: `PRs` or `MRs` (#62, built 0.68.0). |
| blocker | An open issue that another one waits on. On Forgejo: a dependency. On GitLab EE: a blocking link. On GitHub: a "blocked by" relation. |
| blocked by, blocks | The two sides of a blocker, as the issue detail lists them. |
| unblocks | How many open issues wait on an issue, as its facts line counts them (`↦ 2`); the detail lists them under blocks (#57, built 0.67.0). |

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
| where you work | Where What's next starts from within the milestone filter: the epic (else the milestone) of your issue in progress, else of your last closed one; it widens to the parent epic, the milestone, then the rest of the filter (#57, built 0.67.0). |
| Last closed | The issue you closed last within the milestone filter, from anywhere (the pane, the browser, a commit); What's next follows on from it (#57, built 0.67.0). |
| Epics | The pane of epics, grouped by milestone. |
| Milestones | The pane of open milestones, then Closed. |
| Closed | The section of closed milestones in Milestones. |
| milestone filter | The choice What's next and Epics share, and what it is set to: a milestone, None (the issues without one; `/next` says no milestone), or All; they show only what is in it. It starts where you work: your issue in progress's milestone, else your last closed issue's, else the one due first (#57, built 0.67.0). |
| detail | An issue or a milestone shown in place of the list, left with Back. |
| section | A part of a list or a detail under a rule that folds with + or −: Closed in Milestones; Issues and Description in the milestone detail. |
| row | One issue, epic or milestone in a list. |
| fold, unfold | Hide or show what is under an epic, a child with children, or a milestone. |
| shown above | An issue already in the tree higher up, shown again under a second parent or in a loop, and not unfolded there. |
| comment | A comment on an issue; the issue detail's Comments section lists them newest first (#62, built 0.68.0). |
| for-you line | What there is for you: how many are yours, available, with others and blocked, each said by its mark and count. |
| bottom line | The last line of a pane. |
| menu | `☰` at the right of a pane's top row: what can be done there, each with its hotkey (#62, built 0.68.0). |
| help page | The page that says what each sign and colour means, the same in every pane; shown in place of the list or detail, left with Back (#63, built 0.70.0). |

## Actions

| Term | Does |
|---|---|
| Refresh | Asks the forge again for everything shown. |
| Back | Returns to the issue a detail was reached from, else to the list; drawn `[ ← ]` (#62, built 0.68.0). |
| Prompt | Puts the issue into your prompt, and assigns you if needed (#62, built 0.68.0; was Work on this). |
| Assign Me, Unassign Me | Adds or removes only you as assignee. |
| Close, Reopen | Closes or reopens the issue or milestone. |
| Open in Browser | Opens the issue's or milestone's page on the forge. |
| Help | Opens the help page; `/next help` opens it in What's next (#63, built 0.70.0). |

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

## Not used

| Word | Use instead | Why |
|---|---|---|
| up for grabs | available | Informal; replaced in 0.61.0. |
| ready | available | Reads as "done"; replaced in 0.61.0. |
| all children closed | all closed | One state, one word under an epic and a milestone; #45. |
| no due date | nothing | A missing due date is not shown at all; #45. |
| My issues | What's next, In progress | The pane was renamed in 0.24.0. |
| picker, pick | milestone filter | It is what it is: a filter on milestone; #57. |
| focus (for where you work) | where you work | Focus is the keyboard's: the control Enter presses; #57. |
| Work on this | Prompt | Too long for the top row; what it does first is put the issue in the prompt; #62. |
| No milestone (in the milestone filter) | None | Shorter on the filter's button; the Epics rule over epics without one keeps No milestone; #62. |
