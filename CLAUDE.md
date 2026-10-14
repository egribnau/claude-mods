# claude-mods: notes for working in this repo

Claude Code mods, published through the marketplace in
`.claude-plugin/marketplace.json`. Each mod lives in `plugins/<name>`, and
that folder is what users install: only what the mod needs to run goes
there. Notes for working on a mod live in `docs/<name>/`.

## Way of working, for every mod

- One feature at a time, chosen by the maintainer.
- Design first, on the maintainer's design canvas: artboard titles say
  "(proposal)" or "(built, <version>)". Build only after the maintainer
  agrees; keep the canvas in step with the code.
- Bump the version in the mod's `.claude-plugin/plugin.json` with each
  change, and update the README when behaviour changes.
- Commit and push only when asked; the maintainer pushes.
- Commit messages carry no `Claude-Session:` line: the repo is mirrored
  publicly and those links open only for the maintainer.
  `Co-Authored-By:` stays.
- The repo is public: tests, docs, commit messages and the README name no
  real host, repo, person or path of the maintainer (use `git.example.org`,
  `boats/radar`, `alice`, `jdoe`). The only exceptions: the author name in
  the manifests, the copyright line, and the public repo and marketplace
  (`egribnau/claude-mods`, `egribnau-mods`), which users install from.
- No em-dashes in anything written; commas and periods instead.

## Mods

Before working on a mod, read its notes in `docs/<name>/CLAUDE.md`
(Claude Code loads them through the imports below).

- What's Next (`plugins/whats-next`): @docs/whats-next/CLAUDE.md
