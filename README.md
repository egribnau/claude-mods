# claude-mods

Personal Claude Code mods, distributed as a plugin marketplace.

## Install

```
/plugin marketplace add https://git.example.org/alice/claude-mods.git
/plugin install whats-next@egribnau-mods
```

## Update an existing machine

```
/plugin marketplace update egribnau-mods
```

## Layout

```
.claude-plugin/marketplace.json      marketplace manifest
plugins/whats-next/                  a mod: a hooks module, no skills
  .claude-plugin/plugin.json         plugin manifest, settings under userConfig
  hooks/register.tsx                 the hooks module: the panes and /next
  hooks/tracker.ts                   what the panes ask a tracker
  hooks/forgejo.ts                   Forgejo as a tracker: every Forgejo URL
  hooks/gitlab.ts                    GitLab as a tracker: every GitLab URL
  hooks/github.ts                    GitHub as a tracker: every GitHub URL
  types/index.d.ts                   the session state it keeps
  tests/*.test.ts                    run with `claude plugin test plugins/whats-next`
```

## Mods

| Mod | What it does | Requires |
| --- | --- | --- |
| What's Next (`whats-next`) | `/next` opens a docked pane on the Forgejo, GitLab or GitHub repo behind the current directory's `origin`. Until setup is complete, the pane guides it step by step: the repo, the forge at its host, a token, and the token reading the repo. github.com and gitlab.com are known by name; any other host is asked, without a token, for its version as Forgejo or Gitea, then GitLab, then GitHub Enterprise. On GitHub (github.com or GitHub Enterprise), What's Next shows What's next and the detail of an issue, with its last comment, the pull requests of the repo that mention it and the commits that refer to it, from the issue's timeline; pull requests are left out of every list, and GitHub tracks no time. It assigns, unassigns, closes and reopens GitHub issues with push rights on the repo; a classic token also needs `repo` (`public_repo` will do on a public repo), and a fine-grained token, whose permissions GitHub does not list, needs Issues read and write, which setup's Actions step cannot check: the buttons show, and GitHub has the last word. There are no blockers or epics on GitHub yet. On GitLab, What's Next shows What's next and the detail of an issue, numbered by the project's own issue numbers, with its time spent and estimate, its last comment and the merge requests that mention it, and its epics. On GitLab an epic is an issue with the Epic label, and its children are the issues it links as related (another epic linked that way is left out). Blockers come from blocking links, which only GitLab EE has: there What's Next finds what blocks an issue as on Forgejo; on GitLab Free or Community Edition there are none, so nothing shows as blocked. It assigns, unassigns, closes and reopens GitLab issues with an `api` token and Reporter or higher on the project; with `read_api` only, or a lower role, setup's Actions step says read only and why. Then it shows what's next: In progress (open issues assigned to you), Next (the oldest open, unassigned issue with no open dependencies, or Nothing ready when all are blocked), and the Queue (the other unassigned issues, oldest first, with the ones found blocked at the bottom). Each row starts with its section's mark (● In progress, ▸ Next, ⊘ blocked), and the focus starts on Next, so Enter opens it. A milestone picker, shared with Epics, narrows every section to one open milestone (at first the one due first), to the issues without one, or to All. At the bottom: the repo, how many open issues it shows and how many are yours. Issues assigned to others are left out. Selecting an issue shows its detail (labels, due date, branch, tracked time, what blocks it and what it blocks, pull requests and commits that refer to it, its description and last comment) with Work on this, which drafts a prompt from the issue (and assigns you first), Assign me or Unassign me, Close or Reopen, and Open in browser. Assigning and closing need a token with `write:issue` and push rights on the repo (on GitLab, `api` and Reporter or higher); setup's Actions step says whether What's Next may, and why not. After a change, What's next shows the issue as the change left it, read again from the forge, for 30 seconds, since a forge's lists may lag a change (GitHub's do, by a few seconds). When the repo has open epics, an Epics pane opens as a tab next to What's next (Refresh opens it once the first epic is there, and closes it when none is left): the epics of one open milestone, at first the one due first, each with a bar of its closed children (a picker switches to another milestone, to the epics without one, or to All, a group per milestone); folded, a line says what is yours, blocked or up for grabs, its + or − folds it open on its open children, as rows like What's next's (● yours, ⊘ blocked, someone else's name at the right), and the rest of its row opens the epic's detail. An epic is an issue with the Epic label; its children are the issues it depends on (on GitLab, the issues it links as related). The picker switches from what was loaded, and an issue opened again shows from memory; Refresh and `/next` ask the forge again. `/next epics` (or `e`) opens the panes with Epics in front; `/next next` (or `n`) does what `/next` does. When another plugin, a user command or an MCP server already has `/next`, the command is `/whats-next` in that session, and a toast says so. | a Forgejo, GitLab or GitHub access token; Forgejo, Gitea, GitLab or GitHub |

What's Next has eight settings. **Compact** (`ask`, `on` or `off`): lists without an empty line between rows; with `ask`, What's Next asks once, after Icons. **Epic label** (default `epic`): the label that makes an issue an epic; on GitLab its children are the issues it links as related. **Debug** (off by default): a line under the repo line counts What's Next's requests to the forge, for the last action and for the session. **Icons** (`ask`, `icons` or `text`, in `/config` under What's Next): buttons as Nerd Font
icons or as words; with `ask`, What's Next asks once, right after setup. **Forgejo tokens**: Forgejo or Gitea
access tokens, kept in secure storage. A bare token is for every host; more hosts take `host=token`
pairs separated by spaces (`git.example.org=<token> codeberg.org=<token>`), and a pair wins over a
bare token. `/config` does not list it: set it with `/plugin configure whats-next@egribnau-mods`. A token needs `write:issue`,
`read:repository` and `read:user` (to know which issues are yours); with `read:issue` in place of
`write:issue`, What's Next is read only and cannot assign or close. **GitLab.com token**: a gitlab.com access token, kept in secure storage.
**Private GitLab token**: an access token for your own GitLab, any host but gitlab.com, kept in secure
storage; `host=token` pairs separated by spaces still work for more than one host. A `gitlab.com=<token>`
pair there still counts for gitlab.com when GitLab.com token is empty. A GitLab token needs `api` to
assign and close, or `read_api` to read only. **GitHub token**: a GitHub access token, kept in secure storage, for
github.com and GitHub Enterprise; `host=token` pairs separated by spaces for more than one host. A fine-grained
token needs the Issues permission (read and write to assign and close, read to read only), a classic one `repo`.
What's Next reads no environment variables.

What's Next is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: the secret token settings stay empty there, so the pane stops at the Token step. The desktop app
also runs the copy `claude plugin update whats-next@egribnau-mods` made from the last commit, not the
working folder.

To edit What's Next and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
