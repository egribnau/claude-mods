# What's Next: ordering Next and the Queue

How What's next chooses Next and orders the Queue: which issues come
first, and why. How the result is drawn (the rules, `↦ n`, Last closed)
is in DRAWING.md and DRAWING-issue.md; the words are in TERMINOLOGY.md.
A change to the order changes this file first, then the code, then the
canvas artboard "What's next, ordered by where you are".

Built in 0.67.0 (#57). Where you work is not called focus: focus is the
keyboard's.

## In short

Next follows on from what you did last. What's next finds where you
work, takes the issues there first and widens step by step
when nothing is left. Within each step it orders by a few keys, one
after the other: no score, no weights. A row's place is explained by
the step it is in (said in the rule) and the key that set it apart
(said on its facts line).

## Where you work

Per milestone filter setting, the issue you work from is:

1. your issue in progress in the milestone filter updated last (a
   comment, a commit naming it, a label: the lists say when, so it costs
   nothing; IssueRow gains `updated`);
2. with none, the last issue you closed in the milestone filter (Last closed);
3. with neither, there is none, and the order is the filter's, as
   below.

Where you work is that issue's epic, else its milestone. The milestone filter: a milestone,
None or All. Set the filter to v1.3 and Next follows on from what you
did in v1.3, not elsewhere; All follows on from what you did anywhere.

A close counts from anywhere: the pane, the browser, a `closes #41`
commit. The forge is asked, not the pane's memory.

## Scopes: how where you work widens

The available issues of the milestone filter are taken in scopes, in this order:

| # | Scope | Holds |
|---|---|---|
| 1 | the epic | the open children in the milestone filter of the epic you work in |
| 2 | its parent epic | the parent's open children in the milestone filter, those of 1 left out; only on GitHub, where a child can have children; each parent up the tree is a scope of its own |
| 3 | the milestone | the rest of the milestone of the issue you work from, in the milestone filter |
| 4 | the milestone filter | the rest of the filter |

A scope with nothing in it is skipped. When the issue you work from is in
no epic, scopes 1 and 2 are skipped; without an issue to work from,
only 4 is left, and the order is the keys below over the whole filter. With the
filter set to a milestone, 3 and 4 hold the same issues, so 4 is empty.

Next is the first available issue of the first scope that has one.
The Queue goes on from there, through the same scopes, until its limit
(QUEUE_LIMIT). Blocked issues met on the way go to the blocked rows at
the end, as today.

## Keys: the order within a scope

Within a scope, issues are sorted by these keys; a tie on one goes to
the next.

| # | Key | First | Known from |
|---|---|---|---|
| 1 | due soon | an issue due within 7 days or past due, earliest first; the rest after, as equals | its own due date; without one, its milestone's (only makes a difference in All and the epic scopes) |
| 2 | unblocks | the most open issues waiting on it first | GitHub: the list counts them (`issue_dependencies_summary`); Forgejo and GitLab: the blocker checks made so far, so what the walk has not checked counts as 0 |
| 3 | age | oldest first, then lowest number | the lists |

The 7 days are the same as for an amber due date (DRAWING.md, Due
dates). GitHub issues have no due date of their own, so only a
milestone's counts there.

The keys are read from what is known when the walk starts; the walk
does not reorder as it checks blockers. The order is the same for the
same answers from the forge.

Priority is not a key: there is no source for it yet.

## Where the milestone filter starts

On `/next` the milestone filter starts where you work:

1. the milestone of your issue in progress updated last;
2. with none, the milestone of the last issue you closed in the repo;
3. with neither, the open milestone due first, as before #57.

That issue without a milestone starts it on None. A milestone you
choose yourself holds until the next `/next`.

## What it asks the forge

Asked the first time the milestone filter is set to something, then remembered until Refresh:

| Request | Count | Forgejo | GitLab | GitHub |
|---|---|---|---|---|
| your last closed issue in the milestone filter | 1 | the first page of the repo's closed issues assigned to you, in that milestone; the latest closed of it | the first page, newest change first; the latest closed of it | the same, pull requests left out |
| the epic of the issue you work from | 1 | the open epics that depend on it (`/blocks`) | its related links to an open issue with the Epic label | its parent issue, open, in this repo |
| the epic of your last closed issue, when you work from an issue in progress | 1 | the same | the same | the same |
| the epic's children | 1, or none when Epics already loaded them | its dependencies | its related links | its sub-issues |
| each parent epic up the tree | 2 each (its parent, its children) | | | GitHub only |

All asks without a milestone; None asks for issues without one
(Forgejo cannot filter that: its list is filtered here). The All answer is
also the answer for its own milestone, which is then not asked. Where the
milestone filter starts uses the All request, asked first, so it costs
nothing more. On Forgejo with dependencies off, an epic has no children:
nothing is asked for the epic. Debug counts these with the rest.

How many open issues wait on an issue costs nothing: GitHub's list says
it; on Forgejo and GitLab it is counted from the blocker checks the walk
already makes.

## Where it lives in the code

- plugins/whats-next/hooks/next.ts: `order`, the scopes and keys, pure;
  `pickNext` walks its result for blockers.
- plugins/whats-next/hooks/load.ts, what is known of the repo (`loadRepo`
  builds it): its `whatsNext` finds where you work and builds the scopes;
  `lastClosedIn`, `epicsAbove` (through `parentOf`) and `membersOf` ask and
  remember per milestone filter setting; its `startingFilter` is where the
  milestone filter starts.
- plugins/whats-next/hooks/filter.ts: the milestone filter as a value, and
  whether an issue is in it.
- Each forge's tracker: `lastClosed`, `parentOf`, `members` and `nested`.

No other place orders Next or the Queue.
