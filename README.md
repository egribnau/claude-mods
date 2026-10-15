# What's Next for Claude Code

[Install](#install-and-update) · [What's Next](#whats-next) · [In pictures](#in-pictures) · [What it needs](#what-it-needs) · [Settings](#settings)

Your next issue, in a docked pane beside the conversation. From Forgejo,
GitLab or GitHub.

<img src="docs/whats-next/images/whats-next.png" alt="What's next in a terminal: an issue in progress, the next issue, the Queue and the issue closed last" width="1100">

- Next: the first available issue, ordered by where you work, its due date
  and how many issues wait on it.
- Epics and milestones with their progress, folded open on their issues.
- Assign yourself, close an issue, or put it into your prompt, without leaving
  Claude Code.

What's Next is a mod: a change to Claude Code's own interface. This repo,
`claude-mods`, publishes it as the plugin marketplace `egribnau-mods`. The
mods need an up to date version of Claude Code, in the terminal.

## Install and update

Install, in Claude Code (answer `y` to add the marketplace, then pick a
scope):

```
/plugin install whats-next --marketplace egribnau/claude-mods
```

Update, from a shell, then run `/reload-plugins` in an open session:

```
claude plugin marketplace update egribnau-mods
claude plugin update whats-next@egribnau-mods
```

## What's Next

`/next` opens docked panes on the issues of the repo behind the current
directory's `origin`:

- **What's next**: your issues In progress, Next and the Queue after it.
  Next is the first available issue: assigned to no one, not blocked. It
  follows on from where you work: the epic or milestone of your issue in
  progress, or of the issue you closed last.
- **Epics**: the epics of a milestone, each unfolding to its children.
- **Milestones**: every open milestone, with its epics and issues.
- **Milestone filter**: narrows What's next and Epics to one milestone.
- **Issue detail**: epic, children, blockers, due date, milestone, labels,
  pull requests, commits, description and comments. Assign yourself, close,
  reopen, open in the browser, or put the issue into your prompt.
- **Help** (`h`): what each sign and colour means.

| Command | Opens |
| --- | --- |
| `/next` | the panes, with What's next in front and the keyboard on it |
| `/next help` | What's next on the help page |

- Esc returns to the prompt.
- When another plugin already has `/next`, the command is `/whats-next` in
  that session, and a toast says so.

### In pictures

| Epics | Milestones |
| --- | --- |
| <img src="docs/whats-next/images/epics.png" alt="Epics: an epic folded open on its children, another folded" width="482"> | <img src="docs/whats-next/images/milestones.png" alt="Milestones: one milestone folded open on its epics and issues" width="482"> |
| **An issue** | **Its menu** |
| <img src="docs/whats-next/images/issue.png" alt="An issue's detail: its epic, blockers, due date, milestone, label, branch, time and description" width="482"> | <img src="docs/whats-next/images/menu.png" alt="The menu of an issue's detail, each item with its hotkey" width="482"> |
| **A milestone** | **Help** |
| <img src="docs/whats-next/images/milestone.png" alt="A milestone's detail: due date, bar, its issues as a tree and its description" width="482"> | <img src="docs/whats-next/images/help.png" alt="The help page: the marks, fold marks, signs and counts" width="482"> |
| **Setup, stopped at the token** | |
| <img src="docs/whats-next/images/setup.png" alt="Setup: repo and forge found, no token yet, and what to do" width="482"> | |
| **Compact off** | **Compact on** |
| <img src="docs/whats-next/images/compact-off.png" alt="What's next with an empty line between rows" width="482"> | <img src="docs/whats-next/images/compact-on.png" alt="What's next without an empty line between rows" width="482"> |

### What it needs

A repo on one of these forges, and an access token for it:

| Forge | Token setting | To read | To assign and close |
| --- | --- | --- | --- |
| Forgejo or Gitea | Forgejo tokens | `read:issue`, `read:repository`, `read:user` | `write:issue` in place of `read:issue`, and push rights on the repo |
| gitlab.com | GitLab.com token | `read_api` | `api`, and Reporter or higher on the project |
| GitLab on your own host | Private GitLab token | `read_api` | `api`, and Reporter or higher on the project |
| github.com or GitHub Enterprise | GitHub token | fine-grained: Issues read; classic: `repo` (`public_repo` on a public repo) | fine-grained: Issues read and write; classic: `repo`; and push rights on the repo |

Tested on Forgejo, GitLab Free and GitHub. Blockers come from Forgejo's
dependencies, GitHub's "blocked by" relations and GitLab's blocking links;
GitLab has blocking links only in EE, where What's Next reads them but they
are not tested here. On GitLab Free nothing shows as blocked.

Until all is set, the pane walks you through setup: the repo, the forge at
its host, the token, whether it reads the repo, and whether What's Next may
assign and close or is read only.

A token goes only to the host it is for, and What's Next shows it nowhere.
It reads tokens only from its own settings: no environment variables, no
files of other tools.

### Settings

Set the tokens with `/plugin configure whats-next@egribnau-mods`; the other
settings are also in `/config`, under What's Next.

| Setting | Default | What it does |
| --- | --- | --- |
| Forgejo tokens | empty | Forgejo or Gitea tokens. A bare token is for every host; more hosts take `host=token` pairs separated by spaces (`git.example.org=<token> codeberg.org=<token>`), and a pair wins over a bare token. |
| GitLab.com token | empty | The token for gitlab.com. |
| Private GitLab token | empty | The token for your own GitLab, any host but gitlab.com; `host=token` pairs for more than one host. |
| GitHub token | empty | The token for github.com and GitHub Enterprise; `host=token` pairs for more than one host. |
| Epic label | `epic` | The label that makes an issue an epic. |
| Compact | `ask` | `on`: lists without an empty line between rows. `ask`: What's Next asks once. |
| Icons | `ask` | `icons`: buttons as Nerd Font icons; `text`: as words. `ask`: What's Next asks once, after setup. |
| Debug | off | A line under the bottom line counts the requests to the forge, for the last action and the session. |

Tokens are kept in secure storage. In a Code session of the Claude desktop
app they stay empty, so the pane stops at setup's Token step: What's Next is
for the terminal.

How the panes draw and order issues is in [docs/whats-next](docs/whats-next).

## Working on a mod

Add your clone as a marketplace and install from it; Claude Code then reads
the folder itself, and `/reload-plugins` picks up an edit without a push:

```
claude plugin marketplace add <path to your clone>
claude plugin install whats-next@egribnau-mods
```

Checks and tests are listed in [docs/whats-next/CLAUDE.md](docs/whats-next/CLAUDE.md).

## Licence

Copyright (C) 2026 Erwin Gribnau.

The mods in this repo are free software under the GNU Affero General
Public License, version 3 only (`AGPL-3.0-only`): see [LICENSE](LICENSE).
They come with no warranty.
