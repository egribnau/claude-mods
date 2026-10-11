# What's Next: drawing rules

How the panes draw the same kind of thing in the same way. A new view
follows these rules; a change to a rule changes every place it lists.

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

`due ` goes before it, except where the place already says what it is: the
picker's column of dates and the issue detail's Due line.

The places that show a due date today; a new one picks its form by the
same rule and joins the table:

| Where | Form | Drawn as |
|---|---|---|
| Milestone picker (What's next, Epics) | short | `30 Oct`, no word before it |
| Epics pane, a milestone's rule | short | `· due 30 Oct` |
| Milestones pane, the line under a milestone | short | `due 30 Oct`, first on the line |
| Issue detail, the issue's milestone | short | `· due 30 Oct` after the milestone's name |
| Issue detail, the issue's own due date | long | `30 Oct, in 19 days` on the Due line |
| Milestone detail, an open milestone | long | `due 30 Oct, in 19 days` |
| Milestone detail, a closed milestone | short, dim | `due 30 Oct`: once closed, how far off no longer matters |

No due date: left out, unless the due date is first on its line, where
leaving it out would start the line with `·`; there `no due date`, dim
(today: under a milestone, and in the milestone detail).

## Counts

A count `a/b` is always closed of all: `3/8` is 3 closed of 8, never 3
open. At the end of a row it is dim, right-aligned in 6 columns. How
many are open is read from the two numbers; where a place says it in
words, it says `n open`.

A bar goes before the count where the row has room for one: 8 cells,
filled (green) for the closed ones, empty (dim) for the rest. A row that
also has to fit someone's name leaves the bar out.

The places that show a count today; a new one follows the same rule and
joins the table:

| Where | Drawn as |
|---|---|
| Epics pane, an open epic | bar and `3/8` |
| Epics pane, a milestone's rule | `· 9/17 closed` |
| Milestones pane, an open milestone | bar and `9/17` |
| Milestones pane, an epic under a milestone | bar and `3/8` |
| Milestone detail | `9/17 · 8 open`, or `9/17 · all closed` |
| Epics pane, a child with children of its own (0.63.0) | `1/3`, no bar |

## Fold marks

A row that can fold has two targets: the mark, which folds, and the rest
of the row, which opens its detail. Tab and the arrows stop on each.

- `+` folded, `−` unfolded, in the first two columns of the row
- `↑` dim, for an issue shown above (0.63.0): not a target, and its
  second line reads `shown above`, dim
- under an unfolded row its children, two columns further in; at any depth
  the same rows, marks and counts
