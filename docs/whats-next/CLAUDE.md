# What's Next: notes for working on this mod

The mod is in `plugins/whats-next`; the rules for every mod are in the
repo's CLAUDE.md.

## Read first

| When you | Read |
|---|---|
| add or change how a pane draws something (a view, a line, a count, a due date, a fold) | `docs/whats-next/DRAWING.md`: a new view follows it, a change to a rule updates it |
| add or change how an issue is drawn (its mark, number, title, facts line, for-you line, a detail line naming one) | `docs/whats-next/DRAWING-issue.md`, the same way |
| change how Next and the Queue are ordered, or where the milestone filter starts | `docs/whats-next/ORDERING.md`, the same way |
| name a thing in a pane, the README, the canvas, an issue, a comment or code | `docs/whats-next/TERMINOLOGY.md`: one word per thing |
| settle a drawing rule, an ordering rule or a word in a design review | the four above, and write the decision into the right one at once |
| add a token setting or a request, or show forge text in a new place | Testing and Hard rules below, and `tests/tokens.test.ts` |
| change the marketplace name | `docs/whats-next/check-marketplace.sh` |

## Way of working

- Milestones name a theme, not a version: a milestone's issues each bump
  the version as they land.

## Testing

- `claude plugin test plugins/whats-next`, `claude plugin validate
  plugins/whats-next`, `tsc` with the tsconfig from the types file header,
  `docs/whats-next/check-tokens.sh` (every token setting is sensitive:
  the test sandbox cannot read the manifest) and
  `docs/whats-next/check-marketplace.sh` (the marketplace name is written
  once, as `MARKETPLACE` in `hooks/forge.ts`, and matches the marketplace file).
- `tests/tokens.test.ts` shows a token never leaks: keep it passing, and give
  a new place that shows forge text, or a new request, a test there.
- `mock.clock(on)` is needed once the pane renders ages. `prompt.fill` hooks
  return `{ isFilled }` itself; ops like `process.run` and `http.fetch` return
  `{ value }`; a failing fetch is `{ deny: '...' }`. One `on(event)` per event
  per test.

## Engine facts that shaped the code

- Text inside a Button wraps instead of truncating: cut it with `fit()`.
- Once the pane has the keyboard, the arrow keys and Tab move between its
  controls, Enter presses the one in focus, and hotkeys press theirs.
- With a single pane the engine draws no tab title.
- A pane opened new comes in front of the others, asked or not; opening an
  open one again leaves the front as it was. Only `focus: true` brings an
  open pane in front, and it gives that pane the keyboard; while a pane holds
  the keyboard, a pane opened new stays behind it (#87).
- `claude plugin validate` scans each `update` and `read` for the atom it
  names: a literal, or a const of the same file. An atom passed in as a
  parameter fails validation, and with it every test (#94).

## Hard rules

- Tokens come only from the token settings (Forgejo tokens, GitLab.com token,
  Private GitLab token, GitHub token): no environment variables, no files of
  other tools.
