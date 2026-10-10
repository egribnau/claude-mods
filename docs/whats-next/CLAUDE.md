# What's Next: notes for working on this mod

The mod is in `plugins/whats-next`; the rules for every mod are in the
repo's CLAUDE.md.

## Way of working

- Milestones name a theme, not a version: a milestone's issues each bump
  the version as they land.
- How the panes draw things (due dates, for a start) is in
  `docs/whats-next/DRAWING.md`: a new view follows it, and a change to a
  rule updates it.
- The words for things are in `docs/whats-next/TERMINOLOGY.md`: one word
  per thing, in the panes, the README, the canvas, issues and comments.

## Testing

- `claude plugin test plugins/whats-next`, `claude plugin validate
  plugins/whats-next`, and `tsc` with the tsconfig from the types file header.
- `mock.clock(on)` is needed once the pane renders ages. `prompt.fill` hooks
  return `{ isFilled }` itself; ops like `process.run` and `http.fetch` return
  `{ value }`; a failing fetch is `{ deny: '...' }`. One `on(event)` per event
  per test.

## Engine facts that shaped the code

- Text inside a Button wraps instead of truncating: cut it with `fit()`.
- Once the pane has the keyboard, the arrow keys and Tab move between its
  controls, Enter presses the one in focus, and hotkeys press theirs.
- With a single pane the engine draws no tab title.

## Hard rules

- Tokens come only from the token settings (Forgejo tokens, GitLab.com token,
  Private GitLab token, GitHub token): no environment variables, no files of
  other tools.
