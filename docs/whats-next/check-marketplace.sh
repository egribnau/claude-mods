#!/bin/sh
# What's Next names the marketplace it is published in once, as MARKETPLACE
# in hooks/forge.ts, for when the engine does not say which one it came from.
# That name must be the one .claude-plugin/marketplace.json gives, and no
# other file of the mod's code may spell it out. Fails, naming what is wrong.
# The test sandbox cannot read the marketplace file, so this check lives here.
set -eu
root="$(dirname "$0")/../.."
hooks="$root/plugins/whats-next/hooks"

manifest="$(jq -r .name "$root/.claude-plugin/marketplace.json")"
code="$(sed -n "s/^export const MARKETPLACE = '\(.*\)'$/\1/p" "$hooks/forge.ts")"
if [ "$code" != "$manifest" ]; then
  echo "MARKETPLACE in hooks/forge.ts is '$code', marketplace.json says '$manifest'" >&2
  exit 1
fi
places="$(grep -rlF -- "$manifest" "$hooks")"
if [ "$places" != "$hooks/forge.ts" ] || [ "$(grep -cF -- "$manifest" "$hooks/forge.ts")" != 1 ]; then
  echo "the marketplace name is written in more than one place:" >&2
  grep -rnF -- "$manifest" "$hooks" >&2
  exit 1
fi
echo "the marketplace name is '$manifest', in one place"
