#!/bin/sh
# Every token setting of What's Next is kept in secure storage: each field of
# the manifest's userConfig with "token" in its key or title is sensitive.
# The four token settings must all be there. Fails, naming what is wrong.
# The test sandbox cannot read the manifest, so this check lives here.
set -eu
manifest="$(dirname "$0")/../../plugins/whats-next/.claude-plugin/plugin.json"

jq -e -r '
  .userConfig
  | to_entries
  | map(select((.key | test("token"; "i")) or (.value.title // "" | test("token"; "i"))))
  | (map(.value.title) | sort) as $titles
  | map(select(.value.sensitive != true) | "not sensitive: \(.key) (\(.value.title))") as $open
  | if $titles != ["Forgejo tokens", "GitHub token", "GitLab.com token", "Private GitLab token"] then
      "token settings are \($titles | join(", ")), not the four\n" | halt_error(1)
    elif ($open | length) > 0 then
      ($open | join("\n")) + "\n" | halt_error(1)
    else
      "every token setting is sensitive"
    end
' "$manifest"
