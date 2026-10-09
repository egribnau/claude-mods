# claude-mods

Personal Claude Code mods, distributed as a plugin marketplace.

## Install

```
/plugin marketplace add git@forgejo-gribnau:erwin/claude-mods.git
/plugin install fj@egribnau-mods
```

`/plugin marketplace add` refuses `ssh://` URLs, and the `git@host:path` form it does take has no
port. Forgejo's SSH runs on port 2222, so add this alias to `~/.ssh/config` first:

```
Host forgejo-gribnau
  HostName git.example.org
  Port 2222
  User git
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
| `fj` | `/fj [milestone]` opens a pane on the Forgejo repo behind the current directory's `origin`: the oldest open issue assigned to you, a milestone's epics with their children, and the selected issue with an Assign to me button | a Forgejo access token; Forgejo or Gitea |

`fj` settings, in `/config` under `fj`, except Token, which `/config` does not list: set it with
`/plugin configure fj@egribnau-mods`. `/fj` says which token it uses (`token: setting`, `FORGEJO_TOKEN` or `none`).
The pane's **Settings** button (`s`) edits the same settings, shows which of them the session
offers, and where the token comes from.

- **Epic label**: the label that marks an issue as an epic. Default `epic`.
- **Children heading**: the `## ` heading above an epic's checklist of child issues. Default `Children`.
- **Token**: a Forgejo access token, kept in secure storage. Left empty, the plugin reads
  `FORGEJO_TOKEN` from the environment — which the desktop app does not pass on from
  `~/.zshenv`, so set it here to use `/fj` there.
- **Login**: your Forgejo login, for Assign to me. Left empty, the plugin asks Forgejo, which needs a token with the `read:user` scope.

Reading needs a token with `read:issue`; assigning needs `write:issue`.

`fj` is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: `/config` lists no rows for it there, the secret Token stays empty, and the app does not
pass on `FORGEJO_TOKEN` from `~/.zshenv`. The pane's Settings screen shows this per session.
The desktop app also runs the copy `claude plugin update fj@egribnau-mods` made from the last commit, not
the working folder.

To edit `fj` and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
