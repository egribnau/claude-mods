# claude-mods

Personal Claude Code mods, distributed as a plugin marketplace.

## Install

```
/plugin marketplace add https://git.example.org/alice/claude-mods.git
/plugin install fj@egribnau-mods
```

## Update an existing machine

```
/plugin marketplace update egribnau-mods
```

## Layout

```
.claude-plugin/marketplace.json      marketplace manifest
plugins/fj/                          a mod: a hooks module, no skills
  .claude-plugin/plugin.json         plugin manifest, settings under userConfig
  hooks/register.tsx                 the hooks module
  types/index.d.ts                   the session state it keeps
  tests/*.test.ts                    run with `claude plugin test plugins/fj`
```

## Mods

| Mod | What it does | Requires |
| --- | --- | --- |
| `fj` | `/fj` opens a docked pane on the Forgejo repo behind the current directory's `origin`. Until setup is complete, the pane guides it step by step: the repo, Forgejo at its host, a token, and the token reading the repo. The prototype is tagged `fj-prototype`. | a Forgejo access token; Forgejo or Gitea |

`fj` has one setting, **Token**: a Forgejo access token, kept in secure storage. `/config` does not
list it: set it with `/plugin configure fj@egribnau-mods`. The token needs `read:issue` and
`read:repository`. fj reads no environment variables.

`fj` is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: the secret Token stays empty there, so the pane stops at the Token step. The desktop app
also runs the copy `claude plugin update fj@egribnau-mods` made from the last commit, not the
working folder.

To edit `fj` and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
