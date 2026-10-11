# What's Next: drawing rules

How What's Next draws what its panes show, wherever a pane shows it: the
rules every view shares. How an issue itself is drawn (its mark, number,
title, facts line, for-you line and the detail lines that name one) is in
DRAWING-issue.md. A new view follows these rules; a change to a
rule changes every place it lists. The words are in TERMINOLOGY.md; this
file says how and where they are drawn. Each item names what draws it:
those helpers are in plugins/whats-next/hooks/register.tsx (inside
`renderPane`) unless named otherwise, and no other place builds that text
or colour.

Words carry the state; colour and the mark repeat it, never replace it.
One exception: closed is the mark `✓` alone. The Icons setting changes
button labels only, never marks or states.

## Colours

| Colour | Means |
|---|---|
| blue | an issue number: "this is an issue" |
| green | yours: the mark of an issue of yours (`●`, or `⊕`/`⊖` when it folds), `● n` on a for-you line, `n yours` on a bottom line; and finished: the filled cells of a bar |
| amber | a warning: due within 7 days, `all closed` on an epic or milestone still open |
| red | holds something up: a Blocked by number while open, a due date passed, a refusal |
| grey | closed, and nothing else |
| purple | a merged pull request |
| dim | facts under a row, counts, keys of a detail, a blocked row's mark and title; never closed |

Labels keep their forge colour as text, no background; one too dark to
read is lightened toward white so the hue stays (`readable`). A label
without a colour is dim. Commas between labels are dim.

## Counts and states

A count `a/b` is always closed of all: `3/8` is 3 closed of 8, never 3
open. At the end of a row it is dim, right-aligned in 6 columns. How
many are open is read from the two numbers; where a place says it in
words, it says `n open`.

A bar goes before the count where the row has room for one: 8 cells,
filled (green) for the closed ones, empty (dim) for the rest (`bar`). A
row that also has to fit someone's name leaves the bar out.

A closed epic or milestone is one grey row ending in `✓`, at the column
where an open one's count ends. Under an unfolded epic or milestone, its
closed children or issues are one grey line, `✓ 3 closed`, in the mark
column: there the word names the count.

Drawn by: `countText` (bar and count; `barText`, the bar alone, for the
milestone detail), `closedRow` and `CLOSED_END` for a closed row,
`closedLine` for `✓ n closed`, `epicRow` for an open epic at the top.

The places that show a count today; a new one follows the same rule and
joins the table:

| Where | Drawn as |
|---|---|
| Epics pane, an open epic | bar and `3/8` |
| Epics pane, a closed epic | grey row, `✓` |
| Epics pane, a milestone's rule | `· 9/17 closed` |
| Epics pane, a child with children of its own | `1/3`, no bar |
| Epics pane, under an unfolded epic or child | `✓ 3 closed`, grey |
| Milestones pane, an open milestone | bar and `9/17` |
| Milestones pane, the line under a milestone | the same recipe as under a folded epic, `⧗ 30 Oct · ● 1 · ○ 2 · ◌ 3 · ⊘ 1` (how many are open read from the count), or `⧗ 30 Oct · all closed` (DRAWING-issue.md, The for-you line; #45, built 0.66.0) |
| Milestones pane, a closed milestone | grey row, `✓` |
| Milestones pane, an epic under a milestone | bar and `3/8` |
| Milestones pane, a closed epic under a closed milestone | grey row, `✓` |
| Milestones pane, under an unfolded milestone | `✓ 9 closed`, grey |
| Milestone detail | `9/17 · 8 open`, or `9/17 · all closed` |
| Milestone detail, the Issues rule | `− Issues · 8 open` |
| Milestones pane, the Closed rule | `+ Closed · 3` |
| What's next, section rules | `In progress · 2`, `Queue · 3 of 14`; Next has none |
| Bottom lines | What's next `14 open · 2 yours`; Epics `4 epics · 2 yours`; Milestones `3 milestones · 20 open` |

When every issue or child is closed, it says `all closed`, in every place
(#45, built 0.65.0). Amber while the epic or milestone itself is still
open: it is done, close it. Dim once it is closed.

A count in a rule: Rules.

## Rules

A rule names a section of a list or a detail and runs to the pane's
right edge. One look everywhere (#45, built 0.65.0):

- `── ` dim, then the name bold, then what belongs to it after ` · `,
  dim (a count, a due date in its own colour), then the line, dim
- a rule that folds starts with its `+`/`−`, plain, in place of `──`: the
  whole rule is one target (Rows that fold)
- a count follows the name after ` · `: `In progress · 2`,
  `Queue · 3 of 14`, `Closed · 3`, `Issues · 8 open`

| Where | Drawn as |
|---|---|
| What's next | `── In progress · 2`, `── Next`, `── Queue · 3 of 14` |
| Epics, a milestone's group | `── v0.3.0 · ⧗ 30 Oct · 9/17 closed` |
| Milestones, closed milestones | `+ Closed · 3` |
| Milestone detail | `− Issues · 8 open`, `+ Description` or `── Description` |
| Issue detail | `── Description`, `── Last comment · jdoe · 2d ago` |

Drawn by: `rule`, for every rule; the line above a bottom line, which
names nothing, is `fixedLine`.

## Due dates

These rules hold everywhere a due date is shown, whatever it is the due
date of. A due date is drawn only by `dueDate` in plugins/whats-next/hooks/register.tsx, its
words by `dueWords` (for a line that measures itself); `day`, `dueText`
and `dueLook` are called from nowhere else. A place keeps only what is
around it (` · ` before it, padding to its column).

Its colour says how close it is:

- red once passed
- amber within 7 days
- dim otherwise

Two forms:

- **Short**, `30 Oct`: the day and month, with the year only when
  it is not this year. In lists, rules and headings, where room is short
  and the colour already says how close it is.
- **Long**, `30 Oct, in 19 days`: the short form and how far
  off it is (today, tomorrow, in n days, yesterday, n days ago). Only in a
  detail view, for the due date of the thing the detail is about.

`⧗ ` (U+29D7, the hourglass, one cell, plain Unicode; not the `⌛` emoji,
which is two cells) goes before it, in the date's own colour, except where
the place already says what it is: the picker's column of dates and the
issue detail's Due line (#45, built 0.66.0). `⚑` is kept for git tags,
later.

The places that show a due date today; a new one picks its form by the
same rule and joins the table:

| Where | Form | Drawn as |
|---|---|---|
| Milestone picker (What's next, Epics) | short | `30 Oct`, no word before it |
| Epics pane, a milestone's rule | short | `· ⧗ 30 Oct` |
| Milestones pane, the line under a milestone | short | `⧗ 30 Oct`, first on the line |
| Epics and Milestones, the line under a folded epic | short | `⧗ 14 Oct`, the epic's own due date from the lists, first on the line (#45, built 0.66.0) |
| Issue detail, the issue's milestone | short | `· ⧗ 30 Oct` after the milestone's name |
| An issue row's facts line, the issue's own due date | short | `· ⧗ 14 Oct`, after blocked by, before the milestone (DRAWING-issue.md, The facts line; #45, built 0.66.0) |
| Issue detail, the issue's own due date | long | `30 Oct, in 19 days` on the Due line |
| Milestone detail, an open milestone | long | `⧗ 30 Oct, in 19 days` |
| Milestone detail, a closed milestone | short, dim | `⧗ 30 Oct`: once closed, how far off no longer matters |

No due date: nothing is shown, anywhere (#45, built 0.66.0). One text
joins its parts, so leaving the first one out starts no line with `·`;
`duePart` gives a line its due date as a part, or none.

## Rows that fold

A row that can fold has two targets: the mark, which folds, and the rest
of the row, which opens its detail. Tab and the arrows stop on each.

- `⊕` folded, `⊖` unfolded, in the first two columns of the row; on an
  issue row coloured by how it stands for you (DRAWING-issue.md, Marks),
  plain on an epic or milestone at the top, grey on a closed milestone
  (#45, built 0.65.0)
- `↑` dim, for an issue shown above: not a target, and its second line
  reads `shown above`, dim
- under an unfolded row its children, two columns further in; at any depth
  the same rows, marks and counts
- a closed epic has nothing to fold: one grey target, ending in `✓`; a
  closed milestone keeps its grey fold mark, since it folds open on its
  open issues
- a section folds on its rule, which is one target, and keeps `+`/`−`: a
  section is not a row. `+ Closed · 3 ───`.
  Description in the milestone detail, folded, shows its first 3 lines
  and `… n more lines`; with 3 lines or fewer its rule has no mark

| Where | Folds | Opens |
|---|---|---|
| Epics, an open epic | its children | the epic's detail |
| Epics, a child with children of its own | its children | the child's detail |
| Milestones, a milestone | its open issues | the milestone's detail |
| Milestones and its detail, an epic | its tree, folded open with Epics | the epic's detail |
| Milestones, the Closed rule | the last closed milestones | |
| Milestone detail, the Issues and Description rules | the section | |

Drawn by: `foldRow` for a row at the top of a tree (`epicRow` for an epic),
`issueRow` for an issue that folds, `rule` for a section.

## Lines that hold several parts

A line made of parts (a facts line, a for-you line, a rule with a name,
due date and count, a bottom line) is one text, cut once at its end with
the pane's width. Its parts are never squeezed one by one: a narrow pane
cuts the last parts first. What must stay whole at the right (the
version on a bottom line) is a box of its own that does not shrink.

Drawn by: `partsLine` (its parts joined by `joined`) for a facts line, a
for-you line, the line under a milestone and the left of a bottom line;
`rule` for a rule. Debug's line under the bottom line is one text on each
side.

## Words for each state

One word per state, as TERMINOLOGY.md has it, in every pane, the README,
the canvas and the code: yours, blocked, available, with others (`Standing`
in plugins/whats-next/hooks/epics.ts says them so); open, closed, merged,
all closed; `Nothing available` when What's next has no available issue,
and `nothing available` in what `/next` replies.
