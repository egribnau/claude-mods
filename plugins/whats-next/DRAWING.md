# What's Next: drawing rules

How the panes draw the same kind of thing in the same way. A new view
follows these rules; a change to a rule changes every place it lists.

## Due dates

These rules hold everywhere a due date is shown, whatever it is the due
date of. A due date is drawn only by `dueDate` in hooks/register.tsx;
`day`, `dueText` and `dueLook` are called from nowhere else. A place keeps
only what is around it (` · ` before it, padding to its column).

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
