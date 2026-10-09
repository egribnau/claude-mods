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
| `fj` | `/fj` opens a docked pane on the Forgejo repo behind the current directory's `origin`. Starting fresh from 0.13.0: for now it shows the repo, where the token comes from and whether Forgejo answers. The prototype is tagged `fj-prototype`. | a Forgejo access token; Forgejo or Gitea |

`fj` has one setting, **Token**: a Forgejo access token, kept in secure storage. `/config` does not
list it: set it with `/plugin configure fj@egribnau-mods`. Left empty, the plugin reads
`FORGEJO_TOKEN` from the environment, which the desktop app does not pass on from `~/.zshenv`.
The pane says which one it uses. Reading needs a token with `read:issue`.

`fj` is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: `/config` lists no rows for it there, the secret Token stays empty, and the app does not
pass on `FORGEJO_TOKEN` from `~/.zshenv`. The desktop app also runs the copy `claude plugin update fj@egribnau-mods` made from the last commit, not
the working folder.

To edit `fj` and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
