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
| `fj` | `/fj` opens a docked pane on the Forgejo repo behind the current directory's `origin`. Until setup is complete, the pane guides it step by step: the repo, Forgejo at its host, a token, and the token reading the repo. Then it shows what's next: In progress (open issues assigned to you), Next (the oldest open, unassigned issue with no open dependencies, or Nothing ready when all are blocked), and the Queue (the other unassigned issues, oldest first, with the ones found blocked at the bottom). Each row starts with its section's mark (● In progress, ▸ Next, ⊘ blocked), and the focus starts on Next, so Enter opens it. A milestone picker, shared with Epics, narrows every section to one open milestone (at first the one due first), to the issues without one, or to All. At the bottom: the repo, how many open issues it shows and how many are yours. Issues assigned to others are left out. Selecting an issue shows its detail (labels, due date, branch, tracked time, what blocks it and what it blocks, pull requests and commits that refer to it, its description and last comment) with Work on this, which drafts a prompt from the issue (and assigns you first), Assign me or Unassign me, Close or Reopen, and Open in browser. Assigning and closing need a token with `write:issue` and push rights on the repo; setup's Actions step says whether fj may, and why not. When the repo has open epics, an Epics pane opens as a tab next to What's next: the epics of one open milestone, at first the one due first, each with a bar of its closed children (a picker switches to another milestone, to the epics without one, or to All, a group per milestone); folded, a line says what is yours, blocked or up for grabs, its + or − folds it open on its open children (● yours, ⊘ blocked, someone else's name at the right), and the rest of its row opens the epic's detail. An epic is an issue with the Epic label; its children are the issues it depends on. The picker switches from what was loaded, and an issue opened again shows from memory; Refresh and `/fj` ask Forgejo again. `/fj next` (or `n`) and `/fj epics` (or `e`) open the panes with that one in front. The prototype is tagged `fj-prototype`. | a Forgejo access token; Forgejo or Gitea |

`fj` has four settings. **Epic label** (default `epic`): the label that makes an issue an epic. **Debug** (off by default): a line under the repo line counts fj's requests to Forgejo, for the last action and for the session. **Icons** (`ask`, `icons` or `text`, in `/config` under fj): buttons as Nerd Font
icons or as words; with `ask`, fj asks once, right after setup. **Token**: a Forgejo access token, kept
in secure storage. `/config` does not list it: set it with `/plugin configure fj@egribnau-mods`. The token needs `read:issue`,
`read:repository` and `read:user` (to know which issues are yours); with `write:issue` in place of
`read:issue`, fj can assign and close. fj reads no environment variables.

`fj` is for the terminal. A Code session in the Claude desktop app loads it but gets none of its
settings: the secret Token stays empty there, so the pane stops at the Token step. The desktop app
also runs the copy `claude plugin update fj@egribnau-mods` made from the last commit, not the
working folder.

To edit `fj` and see each change without a push, add this working copy as a marketplace
(`claude plugin marketplace add ~/dev/personal/claude-mods`) and install from it; Claude Code then
reads the folder itself, and `/reload-plugins` picks up an edit.
