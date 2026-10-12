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
Two exceptions: closed is the mark `✓` alone, and an open issue is its
mark alone (`●` `⊘` `◌` `○`), never the word `open` (#72, built 0.69.0). The Icons setting changes
button labels only, never marks or states; the menu's `☰` and Back's `←`
are the same with Icons on and off (The menu).

## Colours

| Colour | Means |
|---|---|
| blue | an issue number: "this is an issue" |
| green | yours: the mark of an issue of yours (`●`, or `⊕`/`⊖` when it folds), `● n` on a for-you line, `n yours` on a bottom line; and finished: the filled cells of a bar |
| amber | a warning: due within 7 days, `all closed` on an epic or milestone still open |
| red | something wrong: a due date passed, a refusal or an error from the forge (a Blocked by number is blue since #72) |
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
| What's next, section rules | `In progress · 2`; Next and the Queue have none: what the Queue's limit leaves out is the line `and 14 more` under its rows (#57, built 0.67.0) |
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
- exactly one empty line before every rule but the first in a pane, with
  Compact on or off: Compact drops the empty line between rows, never the
  one before a rule. A row leaves that line only without Compact, a closed
  row and a closing line never, a paragraph always; what is missing is
  added, never a second one (`sectionEnd`, and in What's next `pushRule`;
  #57, built 0.67.0). The places: What's next's sections and Last closed,
  the groups in Epics, Closed in Milestones, the milestone detail's Issues
  and Description, the issue detail's Description and Last comment
- a count follows the name after ` · `: `In progress · 2`,
  `Closed · 3`, `Issues · 8 open`; never `n of m`, which reads as
  closed of all (#57, built 0.67.0)

| Where | Drawn as |
|---|---|
| What's next | `── In progress · 2`, `── Next`, `── Queue`; never what the milestone filter is set to, which the filter already shows (#57, built 0.67.0) |
| What's next, by scope | `── Next · in epic #30`; the Queue split by scope, `── Queue · in epic #30`, `── Queue · in v1.2` (the milestone of the issue you work from, only with the milestone filter on All), then `── Queue` for the rest, no count: the scope said once, in the rule, never on a row; the epic number blue (#57, built 0.67.0) |
| What's next, above the bottom line | `── Last closed · 2h ago · in epic #30`: how long ago, then its epic, the number blue; no epic part when it was in none. One grey closed row under it, `✓` in the mark column, that opens its detail; nothing closed by you in the milestone filter, no rule and no row (#57, built 0.67.0) |
| Epics, a milestone's group | `── v0.3.0 · ⧗ 30 Oct · 9/17 closed` |
| Milestones, closed milestones | `+ Closed · 3` |
| Milestone detail | `− Issues · 8 open`, `+ Description` or `── Description` |
| Issue detail | `+ Description` or `── Description`, as the milestone detail (#62, built 0.68.0, decided 4a); `− Comments · 3`, which folds (decided 1a and 4b) |

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
the place already says what it is: the milestone filter's column of dates and the
Due line of both details (#45, built 0.66.0; the milestone detail's, #62). `⚑` is kept for git tags,
later.

The places that show a due date today; a new one picks its form by the
same rule and joins the table:

| Where | Form | Drawn as |
|---|---|---|
| Milestone filter (What's next, Epics) | short | `30 Oct`, no word before it |
| Epics pane, a milestone's rule | short | `· ⧗ 30 Oct` |
| Milestones pane, the line under a milestone | short | `⧗ 30 Oct`, first on the line |
| Epics, Milestones and the milestone detail, an epic's facts line | short | `· ⧗ 14 Oct`, after blocked by and unblocks, as on any issue row; no longer on the for-you line under it (#64, built 0.72.0; was the line under a folded epic, #45) |
| Issue detail, the issue's milestone | short | `· ⧗ 30 Oct` after the milestone's name, on the Milestone line (#62, built 0.68.0, decided 1a) |
| An issue row's facts line, the issue's own due date | short | `· ⧗ 14 Oct`, after blocked by, before the milestone (DRAWING-issue.md, The facts line; #45, built 0.66.0) |
| Issue detail, the issue's own due date | long | `30 Oct, in 19 days` on the Due line |
| Milestone detail, an open milestone | long | `30 Oct, in 19 days` on the Due line, as the issue detail (#62, built 0.68.0, decided 6) |
| Milestone detail, a closed milestone | short, dim | `30 Oct` on the Due line: once closed, how far off no longer matters |

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
  Description in both details, folded, shows its first 3 lines and
  `… n more lines`; with 4 lines or fewer its rule has no mark: a 4th
  line takes the row `… 1 more lines` would, so text is cut only from 5
  lines on, a comment's too (#62, built 0.68.8)

| Where | Folds | Opens |
|---|---|---|
| Epics, an open epic | its children | the epic's detail |
| Epics, a child with children of its own | its children | the child's detail |
| Milestones, a milestone | its open issues | the milestone's detail |
| Milestones and its detail, an epic | its tree, folded open with Epics | the epic's detail |
| Milestones, the Closed rule | the last closed milestones | |
| Milestone detail, the Issues and Description rules | the section | |
| Issue detail, the Comments rule and each comment | the section; a comment its text, the newest unfolded (#62, built 0.68.0, decided 4b) | |
| Issue detail, the Description rule | the section: folded its first 3 lines and `… n more lines` (#62, built 0.68.0, decided 4a) | |

Drawn by: `foldRow` for a row at the top of a tree (`epicRow` for an epic),
`issueRow` for an issue that folds, `rule` for a section.

## A detail scrolls

The issue detail and the milestone detail scroll what is between their
top row and their bottom line: wheel, arrows, Page Up and Down. The top
row (`[ ← ]`, `[ Prompt ]`, `[ ☰ ]`) and the bottom line stay in place:
the engine has no row that stays, so the mod scrolls its own rows,
answering `ui.scroll` and moving them by `e.by`, and moves them along
when the focus goes to a control out of view. Folding keeps a detail
short; scrolling reaches what is unfolded (#62, built 0.68.0, decided 4c).
The arrows move the focus, as in a list: the mod's rows fit the pane, so
the engine has none to scroll. The focus on the last control scrolls the
detail to its end, so the text under it (a long comment, unfolded) is
reached with the arrows too; on the first control, to its top (#62, built
0.68.3).

Drawn by: `detailFrame`, the rows in a Box as tall as they are, moved up by `marginTop={-offset}` (a placed Box's negative `top` the engine does not keep); how
many rows there are and where each control sits, `measure`
(hooks/measure.ts), so a detail's rows are lines, each one row: a long
text is wrapped into lines first, never left to wrap.

Tab and the arrows stop on every control of a detail, top to bottom: in
the issue detail `[ ← ]`, `[ Prompt ]`, `[ ☰ ]`, each Epic, Blocked by and
Blocks line, the Description rule, the Comments rule, each comment, and
each `… n more lines` under Description or a comment.
Enter presses the one in focus: a rule or a comment folds or unfolds, a
line naming an issue opens it. No key of its own for folding (#62, built 0.68.0, decided 5a).

A detail opens as its rules say, folded where they say so, every time:
nothing is remembered per issue or milestone. Refresh keeps what is
unfolded in the detail that is open; opening another issue or milestone,
or the same one again, starts as it opens (#62, built 0.68.0, decided 5b).

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

## The menu

Every pane's top row ends in `[ ☰ ]`, the menu: what can be done there,
one line each, its word and its hotkey, opened below it as the milestone
filter opens its list (#62, built 0.68.0, decided 7). Refresh is in it in
every pane, so the top row holds no Refresh button of its own; in a list
it and Help are the menu's only lines until the pane has more to do.
Help (hotkey `h`) is its last line in every pane and view but the help
page itself (The help page). The issue
detail keeps `[ Prompt ]` (hotkey `p`) as a button of its own, on the
top row just before `☰` (#62, built 0.68.0, decided 7b and 7c); Assign Me or
Unassign Me, Close or Reopen, Open in Browser and Refresh go in the
menu. The milestone detail: Open in Browser, Close or Reopen, Refresh.
Every hotkey still works with the menu shut: its Buttons are drawn hidden
at the start of the top row, and Tab and the arrows pass over them.

A menu line is its words, padded, and its hotkey dim at the right
(`Open in Browser o`); pressing one shuts the menu. Opening the menu shuts
the milestone filter's list, and the other way round. Where the token may
not assign or close, the issue detail's menu says why, dim, under its
lines (#62, built 0.68.0).

The menu and the milestone filter's list open over the rows under the top
row, at the right, in a dim frame: the rows stay where they are, and what
the list covers shows again once it shuts. Each line is padded to the
list's width, so nothing beneath shows through (#62, built 0.68.1).

Drawn by: `menuButton`, `menuLines`, `listOverlay` for a list's, the frame
by `overlay`, and `hotkeys` for the hidden ones.

Buttons and the lines of the menu name an action in Title Case: every
word capitalised but a short one inside (in, to, on): `Prompt`,
`Assign Me`, `Unassign Me`, `Open in Browser`, `Close`, `Reopen`,
`Refresh`, `Help` (#62, built 0.68.0, decided 7d). Section names, rules and states
keep their own case.

`☰` (U+2630, plain Unicode, one cell) with Icons on and off, as everyone
knows it and the menu says what is in it.

Back, at the left of a detail's top row, is `[ ← ]` alone, in every
detail, with Icons on and off: not `← Milestones` or `← #24` (#62, built 0.68.0, decided 7a). Its hotkey stays `b`. These two are the buttons
with a sign and no word when Icons is off.

## The help page

One page that says what each sign and colour means, the same page in
every pane (#63, built 0.70.0, decided 4). It opens in place of what the pane shows,
a list or a detail, as a detail does, and Back (`[ ← ]`, `b`) returns
to just that (decided 1). It opens from Help in every pane's menu
(hotkey `h`; `?` is no hotkey the engine takes), and `/next help` opens
What's next on it (decided 2). Its top row is `[ ← ]` and `[ ☰ ]`, the
menu holding Refresh; it scrolls as a detail does (A detail scrolls).

Its sections, each under a rule, in this order (decided 3a): How an issue
stands for you, Rows that fold, Under an issue, Counts, Colours,
Buttons. No section for the words that stand alone (`all closed`,
`children unknown`): they say what they mean (#63, 0.70.2). A line is the sign, drawn as the panes draw
it, in its own colour, in a gutter as wide as the widest sign and two spaces (17 columns,
`● 2 · ○ 1 · ⊘ 1`; #64, 0.72.0; was 20), then its words, plain
(decided 3b): the term from TERMINOLOGY.md, then after `: ` what it
means, `yours: assigned to you`; where TERMINOLOGY.md has no term, what
the sign shows (decided 3c). Words too long for the pane wrap under
themselves, the gutter left empty, never cut (decided 3d).

A new sign or colour joins the help page with the
place that draws it. The page is a table in plugins/whats-next/hooks/help.ts,
its signs drawn by the panes' own helpers (`markOf`, `dueDate`, `barText`):
a colour cannot drift from the panes, only words. tests/help.test.ts checks
that every glyph `markOf` draws and every term of How an issue stands for
you is on it (decided 5).

Drawn by: `helpPage`, in `detailFrame`.

## Words for each state

One word per state, as TERMINOLOGY.md has it, in every pane, the README,
the canvas and the code: yours, blocked, available, with others (`Standing`
in plugins/whats-next/hooks/epics.ts says them so); open, closed, merged,
all closed; `Nothing available` when What's next has no available issue,
and `nothing available` in what `/next` replies.
