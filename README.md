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
  hooks/register.tsx                 the hooks module: the panes and /fj
  hooks/tracker.ts                   what the panes ask a tracker
  hooks/forgejo.ts                   Forgejo as a tracker: every Forgejo URL
  hooks/gitlab.ts                    GitLab as a tracker: every GitLab URL
  types/index.d.ts                   the session state it keeps
  tests/*.test.ts                    run with `claude plugin test plugins/fj`
```

## Mods

| Mod | What it does | Requires |
| --- | --- | --- |
| `fj` | `/fj` opens a docked pane on the Forgejo or GitLab repo behind the current directory's `origin`. Until setup is complete, the pane guides it step by step: the repo, the forge at its host, a token, and the token reading the repo. github.com and gitlab.com are known by name; any other host is asked, without a token, for its version as Forgejo or Gitea, then GitLab, then GitHub Enterprise. On GitHub the pane names the forge and its version and says fj does not show its repos yet, only Forgejo, Gitea and GitLab ones. On GitLab, fj shows What's next and the detail of an issue, numbered by the project's own issue numbers, with its time spent and estimate, its last comment and the merge requests that mention it, and its epics. On GitLab an epic is an issue with the Epic label, and its children are the issues it links as related (another epic linked that way is left out). Blockers come from blocking links, which only GitLab EE has: there fj finds what blocks an issue as on Forgejo; on GitLab Free or Community Edition there are none, so nothing shows as blocked. It assigns, unassigns, closes and reopens GitLab issues with an `api` token and Reporter or higher on the project; with `read_api` only, or a lower role, setup's Actions step says read only and why. Then it shows what's next: In progress (open issues assigned to you), Next (the oldest open, unassigned issue with no open dependencies, or Nothing ready when all are blocked), and the Queue (the other unassigned issues, oldest first, with the ones found blocked at the bottom). Each row starts with its section's mark (● In progress, ▸ Next, ⊘ blocked), and the focus starts on Next, so Enter opens it. A milestone picker, shared with Epics, narrows every section to one open milestone (at first the one due first), to the issues without one, or to All. At the bottom: the repo, how many open issues it shows and how many are yours. Issues assigned to others are left out. Selecting an issue shows its detail (labels, due date, branch, tracked time, what blocks it and what it blocks, pull requests and commits that refer to it, its description and last comment) with Work on this, which drafts a prompt from the issue (and assigns you first), Assign me or Unassign me, Close or Reopen, and Open in browser. Assigning and closing need a token with `write:issue` and push rights on the repo (on GitLab, `api` and Reporter or higher); setup's Actions step says whether fj may, and why not. When the repo has open epics, an Epics pane opens as a tab next to What's next: the epics of one open milestone, at first the one due first, each with a bar of its closed children (a picker switches to another milestone, to the epics without one, or to All, a group per milestone); folded, a line says what is yours, blocked or up for grabs, its + or − folds it open on its open children, as rows like What's next's (● yours, ⊘ blocked, someone else's name at the right), and the rest of its row opens the epic's detail. An epic is an issue with the Epic label; its children are the issues it depends on (on GitLab, the issues it links as related). The picker switches from what was loaded, and an issue opened again shows from memory; Refresh and `/fj` ask the forge again. `/fj next` (or `n`) and `/fj epics` (or `e`) open the panes with that one in front. The prototype is tagged `fj-prototype`. | a Forgejo or GitLab access token; Forgejo, Gitea or GitLab |

`fj` has seven settings. **Compact** (`ask`, `on` or `off`): lists without an empty line between rows; with `ask`, fj asks once, after Icons. **Epic label** (default `epic`): the label that makes an issue an epic; on GitLab its children are the issues it links as related. **Debug** (off by default): a line under the repo line counts fj's requests to the forge, for the last action and for the session. **Icons** (`ask`, `icons` or `text`, in `/config` under fj): buttons as Nerd Font
icons or as words; with `ask`, fj asks once, right after setup. **Forgejo tokens**: Forgejo or Gitea
access tokens, kept in secure storage. A bare token is for every host; more hosts take `host=token`
pairs separated by spaces (`git.example.org=<token> codeberg.org=<token>`), and a pair wins over a
bare token. `/config` does not list it: set it with `/plugin configure fj@egribnau-mods`. A token needs `read:issue`,
`read:repository` and `read:user` (to know which issues are yours); with `write:issue` in place of
`read:issue`, fj can assign and close. **GitLab.com token**: a gitlab.com access token, kept in secure storage.
**Private GitLab token**: an access token for your own GitLab, any host but gitlab.com, kept in secure
storage; `host=token` pairs separated by spaces still work for more than one host. A `gitlab.com=<token>`
pair there still counts for gitlab.com when GitLab.com token is empty. A GitLab token needs `api` to
assign and close, or `read_api` to read only. fj reads no environment variables.

`fj` is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: the secret token settings stay empty there, so the pane stops at the Token step. The desktop app
also runs the copy `claude plugin update fj@egribnau-mods` made from the last commit, not the
working folder.

To edit `fj` and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
