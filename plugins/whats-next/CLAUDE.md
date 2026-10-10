# What's Next: notes for working on this mod

## Way of working

- One feature at a time, chosen by the maintainer.
- Design first, on the maintainer's design canvas: artboard titles say
  "(proposal)" or "(built, <version>)". Build only after the maintainer
  agrees; keep the canvas in step with the code.
- Bump the version in `.claude-plugin/plugin.json` with each change, update the
  README when behaviour changes. Milestones name a theme, not a version: a
  milestone's issues each bump the version as they land. Commit and push only when asked; the
  maintainer pushes.
- No em-dashes in anything written; commas and periods instead.

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
