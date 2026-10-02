#!/usr/bin/env bash
# Lists every remote branch of the PUBLIC repo that carries engine code. No checkout, and it
# never fetches any other remote. Usage: scripts/check-public-branches.sh [remote=origin]
# Exit 1 if any branch leaks.
#   - Every branch: any engine-layout path (engine/src, runtime/src, engine/test, public.pin).
#   - A branch that CONTAINS the ES.4 deletion (8e013e71, #874): also any path matching a glob of
#     .github/frozen-engine-paths.txt (read from that file — there is no second copy). Older
#     branches predate ES.4 and legitimately still hold those copies, so they are exempt.
set -u
remote="${1:-origin}"
ES4=8e013e71
root="$(git rev-parse --show-toplevel)"
layout='^(engine/src/|runtime/src/|engine/test/|public\.pin$)'
# glob -> ERE: ** crosses dirs, * stays in a segment, other regex chars are literal.
frozen=$(sed 's/#.*//; s/[[:space:]]*$//; /^$/d' "$root/.github/frozen-engine-paths.txt" \
  | sed -e 's/[.+?^${}()|[\]/\\&/g' -e 's/\*\*/\x01/g' -e 's/\*/[^\/]*/g' -e 's/\x01/.*/g' -e 's/^/^/' -e 's/$/$/' \
  | paste -sd'|')
bad=0; n=0
while read -r ref; do
  n=$((n + 1))
  paths=$(git ls-tree -r --name-only "$ref" 2>/dev/null)
  hits=$(echo "$paths" | grep -E "$layout" | head -3)
  if git merge-base --is-ancestor "$ES4" "$ref" 2>/dev/null; then
    hits="$hits"$'\n'"$(echo "$paths" | grep -E "$frozen" | head -3)"
  fi
  hits=$(echo "$hits" | sed '/^$/d')
  if [ -n "$hits" ]; then
    bad=$((bad + 1)); echo "LEAK ${ref}: $(echo "$hits" | tr '\n' ' ')"
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/${remote}/" | grep -v "^${remote}/HEAD$")
echo "checked ${n} branches of ${remote}; ${bad} leaking"
[ "$bad" -eq 0 ]
