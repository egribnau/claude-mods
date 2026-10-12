# What's Next: drawing an issue

How What's Next draws an issue wherever a pane shows one: a row, the lines
under it, and the lines of a detail that name one. The rules every view
shares (colours, counts, rules, due dates, rows that fold, lines with
several parts) are in DRAWING.md; the words are in TERMINOLOGY.md. A new
view follows these rules; a change to a rule changes every place it lists.

Each item names what draws it. Those helpers are in
plugins/whats-next/hooks/register.tsx (inside `renderPane`) unless named
otherwise, and no other place builds that text or colour.

## Marks

The first two columns of an issue row say how it stands for you, the
same in every pane. The shape says whether the row folds, the colour how
it stands for you: green is for yours alone (#45, built 0.65.0).

| State | Doesn't fold | Folded | Unfolded | Also said by |
|---|---|---|---|---|
| yours | `●` green | `⊕` green | `⊖` green | |
| blocked | `⊘` dim, title dim | `⊕` dim, title dim | `⊖` dim, title dim | the facts line, `⊘ n` |
| with others | `◌` plain | `⊕` plain | `⊖` plain | their name, dim, at the right of the title line |
| available | `○` plain | `⊕` plain | `⊖` plain | on a row that folds: no name at the right |
| shown above | | `↑` dim, not a target | | its second line, `shown above` |

The number stays blue whatever the mark. Yours wins over blocked; blocked
wins over with others, whose name still shows at the right. What's next
shows no `◌`: it leaves issues with others out. Next and the Queue show
`○`, as available does everywhere; Next is also bold. Nothing has the
focus when the pane opens, Next neither: an inverted bold row was too
heavy (#57, built 0.67.0).

This table is for an issue row. Where the fold mark sits, what it folds,
and the fold marks of epics and milestones at the top and of section rules:
DRAWING.md, Rows that fold.

A new mark fits this meaning, is one cell of plain Unicode (no Nerd Font,
so it shows with Icons off), differs from the others by shape and not only
colour, and takes a place in the order. Due dates and news belong in the
facts line or the title, never in the mark.

Drawn by: `markOf` (plugins/whats-next/hooks/epics.ts) picks the glyph and
colour from `standing` and the fold; `markText` draws it; `whoOf` names whom
it is with.

| Where | Marks |
|---|---|
| What's next, In progress | `●` |
| What's next, Next and the Queue | `○` |
| What's next, the blocked at the end of the Queue | `⊘` |
| Epics, a child | `●` `⊘` `◌` `○`, or `⊕`/`⊖` coloured so when it has children |
| Milestones and its detail, an issue under a milestone or an epic | the same |
| Issue detail, the heading and Blocked by | the same, `✓` when closed (#72, built 0.69.0) |
| Issue detail, Blocks | `⊘`, or `●` when yours; `✓` when closed (#72, built 0.69.0) |
| Issue detail, Epic | the same, its children not counted as what blocks it; `✓` when closed (#72, built 0.69.0) |

## Number and title

The number comes first, always as `#n`, in a column as wide as the
longest number in the list and one space; numbers sit at its right so
their last digits line up, and titles start in one column. Every row and
every tree in one pane shares that column. Blue unless the issue is
closed, then grey.

A title on a row or a line is cut with `…` to the room left (`fit`),
never wrapped: text in a button wraps. A detail's heading is the one
exception: it wraps over at most two lines, and a longer title ends the
second in `…`. Bold for Next, and for an epic at the top of a tree.

A closed issue's or milestone's heading is grey as a whole, number and
title, both lines when it wraps, still bold (#45, built 0.65.0).

Drawn by: `numberText` in every list and tree; `closedRow` for a closed
epic; the detail lines and the heading keep their own, as each is the only
place of its kind.

| Where | Number column | Title |
|---|---|---|
| What's next | one for all sections | bold for Next |
| Epics | one for every group and tree | bold for an epic |
| Milestones | one for every milestone folded open | bold for an epic |
| Milestone detail, Issues | one for the tree | bold for an epic |
| Issue detail, heading | the mark, then `#n` blue; the heading grey as a whole once closed | wraps over two lines |
| Issue detail, Blocked by, Blocks, Pull requests | one for the three, see Detail lines | cut |

## The facts line

One line under an issue row, starting under its title: a recipe of
blocks, left to right. A block shows only when its condition holds; the
blocks that show are joined by ` · `, dim, in one text cut once at its end.

| # | Block | Shown when | Drawn as |
|---|---|---|---|
| 0 | shown above | the issue is already in the tree higher up | `shown above`, dim; the line is this alone |
| 1 | blocked by | it stands blocked: open blockers, and not yours | `⊘ 2`: how many open issues block it, the mark and the count dim, as unblocks; which ones, the issue detail's Blocked by (#73, built 0.71.0; 0.66.0 to 0.70.2 drew the numbers, `⊘ #24, #22`) |
| 1b | unblocks | open issues wait on it, as far as is known (GitHub's lists count them; on Forgejo and GitLab what the blocker checks found), its own epic left out as in the detail (#62, built 0.68.0, decided 3c) | `↦ 2`: the bar is this issue, the arrow what it opens; dim, a count, never the numbers (#57, built 0.67.0) |
| 2 | due date | it has one (Forgejo and GitLab send it with the lists; GitHub issues have none) | `⧗ 14 Oct`, short form, red once passed, amber within 7 days, dim otherwise (DRAWING.md, Due dates; #45, built 0.66.0) |
| 3 | milestone | it has one, and the list is not that milestone's (the milestone filter is set to it, or the row is under it) | `v0.3.0`, dim |
| 4 | labels | it has any | each in its colour, commas dim |
| 5 | age | always | `✎ 3d`: the pencil (U+270E, one cell), how long ago it was opened, dim (#45, built 0.66.0) |

Not on the line: when it was updated, how many comments; the detail
shows both (#45). What blocks the issue and what it blocks are only
counted here, `⊘ 2` and `↦ 2`, one way for both (#57, built 0.67.0; #73,
built 0.71.0); which issues those are is for the issue detail, #62.
The epic an issue is in is not on the line: where it says why a row
is where it is, the rule says it (DRAWING.md, Rules). Whom it is with
is at the right of the title line, not here. They are not buttons: the
row opens its own issue. Compact drops the empty line between rows, not
the one that ends a section (DRAWING.md, Rules).

An age is minutes, hours, days, weeks, months or years (`5m`, `3h`, `6d`,
`3w`, `4mo`, `2y`), from `age`: on the facts line after `✎`, elsewhere
followed by `ago`.

Drawn by: `issueRow`, its parts through `partsLine`; the due date by `duePart`; labels by `labelTexts`; unblocks from `waiting`, which reads What's next's count, so a pane knows it as far as What's next does.

| Where | Drawn as |
|---|---|
| What's next, every row | blocked by, unblocks, due date, milestone (not when the milestone filter is set to one), labels, age |
| Epics, a child | the same |
| Milestones, an issue under a milestone | blocked by, unblocks, due date, labels, age |
| An epic at the top of a tree: Epics, Milestones, the milestone detail | the same as the place's issue rows, folded or unfolded: blocked by (its own children left out), unblocks, due date, milestone (Epics with the filter on All), labels, the Epic label too, age (#64, built 0.72.0) |
| Issue detail, under the heading | not the facts line: one line of its own, see The issue detail's heading |

## The for-you line

What there is for you among some open issues, parts joined by ` · `,
from `forYou`: signs, not words (#45, built 0.66.0). Each part is the
mark (Marks) then its count, `● 2` green, the others dim. The parts come
in the order the rows are listed: yours, available, with others, blocked,
`● 2 · ○ 2 · ◌ 3 · ⊘ 1`. A part with nothing in it is left out; with
nothing at all, no line. With others shows whenever any issue is with
others. The lines that stand alone (`children unknown`, `no children`,
`all closed`, `issues unknown`) stay words: there is no count to put a
sign before.

An epic is an issue, so its row has the facts line any issue row has,
folded or unfolded, its due date there; folded, the for-you line comes
under it, the counts alone (#64, built 0.72.0). One epic is drawn so in
Epics, in Milestones and in the milestone detail (#64, built 0.72.0).

The line under a milestone (#45, built 0.66.0):

| # | Block | Shown when | Drawn as |
|---|---|---|---|
| 1 | due date | it has one | `⧗ 14 Oct`, short form, red, amber or dim |
| 2 | for you | any of it is known | `● 2 · ○ 2 · ◌ 3 · ⊘ 1`; or `all closed`, amber; or alone `children unknown`, `no children`, `issues unknown` |

A milestone without a due date says nothing of it there; how many of its
issues are open is read from its count. Folded, a milestone whose issues
could not be listed says `issues unknown`; folded open, the list under it
says so.

Under a folded epic, the for-you line is block 2 alone, after its facts
line, and starts with the word `children`, dim: `children ● 1 · ⊘ 2`.
The facts line's `⊘ 2` is what the epic itself waits on; without the
word, the `⊘ 2` of its blocked children under it read as the same thing
(#64, built 0.72.0, decided 5). `no children` and `children unknown`
say it already and get no word before them. Where all its children are
closed: `children all closed`,
amber, as for every epic or milestone still open (DRAWING.md, Counts and
states; #45, built 0.65.0). With no children, `no children`; not known,
`children unknown` (`summary`).

Drawn by: `forYou` and `summary` (plugins/whats-next/hooks/epics.ts) say
what, `duePart` the due date before it; `partsLine` draws it, one text.

| Where | Counts |
|---|---|
| Epics, under a folded epic | its children, after the word `children` |
| Milestones and its detail, under an epic, folded | its children, after the word `children` |
| Milestones, under a milestone | its issues that are not epics, as far as the pane knows them without asking (only `● n` until every issue not yours was checked) |
| Milestone detail, under the bar | its issues that are not epics |

## The issue detail's heading

The title, with its mark in front of the number as the lists draw it
(Marks), then one line under it: who opened it and when, as the facts line
says it. A closed issue's mark is `✓`, the heading grey as a whole. No
state word: `open` is said by the mark, as everywhere else (#72, built 0.69.0; 0.68.8
had `open` or `closed` before the opened block, #62 decided 1a which blocks
go on the line, not that the state is a word).

| # | Block | Shown when | Drawn as |
|---|---|---|---|
| 0 | mark | always, before the number | `●` `⊘` `◌` `○` as Marks, an epic too, its own children not counted as what blocks it; `✓` grey when closed (#72, built 0.69.0) |
| 1 | opened | always | `✎ 3w jdoe`: the pencil, the age, who opened it; dim |

Not on the line: the milestone, which is a fact under its name,
`Milestone  v0.3.0 · ⧗ 30 Oct`, its due date after it (Detail lines), so
`⧗` there is never the issue's own; how many comments, which the rule of
the comments counts; when it was updated, which the newest comment shows.

The milestone detail's heading reads the same: an open milestone has no
mark and no line under its title; a closed one is `✓` before its title,
grey, and under it when it closed (`3 days ago`) where the forge says
(#72, built 0.69.0; 0.68.8 had `open`, or `closed 3 days ago`). Its due date is a
fact under the key `Due`, in the same 11-column gutter (#62, built 0.68.0,
decided 6). A milestone has no author, so no `✎`.

## The issue detail's comments

Under the rule `− Comments · 3`, which folds the section, the newest
comment first and unfolded: its line `− jdoe · 2d ago` (the name bold,
the age dim), then its text, 3 lines and `… n more lines` from 5 lines on, as
Description. Each older one, newest to oldest, is one dim line,
`+ jdoe · 5d ago · its first words…`, cut once at its end; pressing it
unfolds that comment. The newest is so always right under the rule, and
no older comment pushes it away (#62, built 0.68.0, decided 4b). No comments:
no rule.

`… n more lines` under a comment is a dim button: pressed, the rest of
that comment shows, until the issue opens again. Under Description, in
the issue detail and the milestone detail alike, it is the same button,
and unfolds Description as its rule does (#62, built 0.68.7). Pressing an unfolded
comment's line folds it. Where the forge would not list the comments,
`comments unknown`, dim, under the rule (#62, built 0.68.0).

Drawn by: the issue detail in `renderPane`, the rule by `rule`.

## Detail lines that name an issue

Blocked by, Blocks and Pull requests in the issue detail: one line each,
`#n title state`, under a dim key in an 11-column gutter, the key on the
first line of its group only, as every key of the detail. The keys are
words, as GitHub and GitLab have them: `Blocked by`, `Blocks`, the longest
key, 10 columns, setting the gutter (#62, built 0.68.0, decided 2; signs as
keys were tried and dropped, half signs and half words read badly).
Pull requests are under the forge's word:
`PRs` on Forgejo and GitHub, `MRs` on GitLab, where the number is `!61`
and not `#61`, which there is an issue (#62, built 0.68.0, decided 3d).
Under Blocks the issue's own epic is left out: on Forgejo an epic depends on
its children, so it waits on each of them, but it is already the `Epic`
line (#62, built 0.68.0, decided 3c). One number
column for the three, as wide as the longest number there, numbers at its
right, so the titles start in one column. An issue's line has its mark
before the number, as the lists draw it (Marks), and no state word: the
mark says it (#72, built 0.69.0; 0.68.8 had `open` and `blocked` at the right, and
a red number for Blocked by).

| Line | Mark | Number | At the right |
|---|---|---|---|
| Epic, open | `●` `◌` `○` as Marks, as its own heading: its children not counted as what blocks it | blue | with others: their name, dim |
| Blocked by, open | `●` `⊘` `◌` `○` as Marks; blocked dims the line | blue, as everywhere: the key says it holds this one up | with others: their name, dim |
| Blocks, open | `⊘`, the line dim: it waits on this issue, so it stands blocked; `●` green when it is yours (yours wins over blocked) | blue | nothing |
| Pull request, open | none: marks are for issues | blue | nothing |
| Pull request, merged | none | blue | `merged` purple |
| any, closed | `✓`, the whole line grey, no strikethrough | grey | nothing |

Blocked by and Blocks lines are plain buttons: the focus inverts them,
Enter opens that issue in the same pane, and Back returns. Pull request
lines are not buttons.

The facts of the issue detail, top to bottom, in the facts line's order
and then what only the detail has: Epic (or Parent), Blocked by, Blocks,
Due, Milestone, Labels, then Branch, Time, PRs (or MRs), Commits. How old
it is is on the line under the title (#62, built 0.68.0, decided 3a).

First among the facts, the issue it is a child of, if any:
one line drawn and pressed as a Blocked by line, number blue, under the
key `Epic`, or `Parent` when it is not an epic (on GitHub any issue can
be a parent) (#62, built 0.68.0, decided 3b).

The other lines of a detail: Due (long form), Branch plain, Time,
Labels, Commits (sha dim, message cut, age dim at the right; three at
most). A line the forge would not answer for is left out, as is an empty
one.

Drawn by: `refLine`, under its key by `keyed`.
