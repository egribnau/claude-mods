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
| blocked | `⊘` dim, title dim | `⊕` dim, title dim | `⊖` dim, title dim | the facts line, `blocked by #n` |
| with others | `◌` plain | `⊕` plain | `⊖` plain | their name, dim, at the right of the title line |
| available | `○` plain | `⊕` plain | `⊖` plain | on a row that folds: no name at the right |
| shown above | | `↑` dim, not a target | | its second line, `shown above` |

The number stays blue whatever the mark. Yours wins over blocked; blocked
wins over with others, whose name still shows at the right. What's next
shows no `◌`: it leaves issues with others out. Next and the Queue show
`○`, as available does everywhere; Next is also bold and has the focus
first.

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
| Issue detail, heading | `#n` blue, the heading grey as a whole once closed | wraps over two lines |
| Issue detail, Blocked by, Blocks, Pull requests | one for the three, see Detail lines | cut |

## The facts line

One dim line under an issue row, starting under its title, its parts
joined by ` · `:

- the milestone, left out where the list is one milestone's (the picker
  shows it, or the row is under a milestone)
- the labels, each in its colour
- the age, `opened 3d ago`

A blocked row says `blocked by #24, #22` in place of the milestone and
labels: the numbers blue, the rest dim. They are not buttons: the row
opens its own issue. An issue shown above says `shown above` in place of
it all. An issue with others names them dim at the right of the title
line, not here. Compact drops the empty line between rows.

An age always reads `2d ago`: minutes, hours, days, weeks, months, years
(`5m`, `3h`, `6d`, `3w`, `4mo`, `2y`), from `age`.

Drawn by: `issueRow`, its parts through `partsLine`; labels by `labelTexts`.

| Where | Drawn as |
|---|---|
| What's next, every row | milestone (not in a picked one), labels, age; or blocked by, age |
| Epics, a child | the same |
| Milestones, an issue under a milestone | labels, age; or blocked by, age |
| Issue detail, under the heading | `open · v0.3.0 · due 30 Oct · 3 comments`, then `opened 3d ago by jdoe · updated 1d ago` |

## The for-you line

What there is for you among some open issues, parts joined by ` · `,
from `forYou`: `n yours` green, then `n blocked` and `n available` dim; a
part with nothing in it is left out. With none of those, `n with others`
dim. With nothing at all, no line.

Under a folded epic, where all its children are closed: `all closed`,
amber, as for every epic or milestone still open (DRAWING.md, Counts and
states; #45, built 0.65.0). With no children, `no children`; not known,
`children unknown` (`summary`).

Drawn by: `forYou` and `summary` (plugins/whats-next/hooks/epics.ts) say
what; `partsLine` draws it, one text.

| Where | Counts |
|---|---|
| Epics, under a folded epic | its children |
| Milestones, under an epic, folded | its children |
| Milestones, under a milestone | its issues that are not epics, as far as the pane knows them without asking |
| Milestone detail, under the bar | its issues that are not epics |

## Detail lines that name an issue

Blocked by, Blocks and Pull requests in the issue detail: one line each,
`#n title state`, under a dim key in a 15-column gutter. One number
column for the three, as wide as the longest number there, numbers at its
right, so the titles start in one column; the state a word at the right
of the line.

| Line | Number | State word |
|---|---|---|
| Blocked by, open | red: it holds this one up | `open` red |
| Blocked by, open and itself blocked | red | `blocked`, dim (not grey: grey is closed) |
| Blocks, open | blue | `open` plain |
| Pull request, open | blue | `open` plain |
| Pull request, merged | blue | `merged` purple |
| any, closed | grey | `✓` alone, the whole line grey, no strikethrough |

Blocked by and Blocks lines are plain buttons: the focus inverts them,
Enter opens that issue in the same pane, and Back returns. Pull request
lines are not buttons.

The other lines of a detail: Due (long form), Branch plain, Time,
Labels, Commits (sha dim, message cut, age dim at the right; three at
most). A line the forge would not answer for is left out, as is an empty
one.

Drawn by: `refLine`, under its key by `keyed`.
