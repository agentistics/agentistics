# Release inclusion proofs

`packages/server/server/delivery/release-proof.ts` exposes
`proveInclusion({ dir, repoKey, pieceShas, target, previous? })`. The target is an exact
commit, independent of release tags or version labels. `previous` is the previous
release commit in this repository; without it, patch matching starts at the
piece/target merge-base.

The repository key is the normalized origin remote. For a local repository with no
remote, use its absolute `git rev-parse --path-format=absolute --git-common-dir`.
The legacy tag lookup uses that local identity too. A remote key must match the
target checkout's origin; finding an identical patch in another project is not a
proof for this project.

A result is `{ kind, containingCommit }` or `null`. Ancestry names the piece's
commit, patch-id names the matching commit in the release range, and tree-holds
names the target whose tree was checked. Every proof requires the complete diff
to reverse-apply against the target tree. A later revert therefore invalidates
ancestry and patch matches too. A multi-commit piece is checked as one combined
diff, never as a successful subset. Supply commits from a single lineage;
unrelated commits fail closed.

Git operations use a temporary index, sanitized environment and disabled external
diff/text conversion. They leave the checkout and its index alone. Missing
objects, empty patches, patches larger than 2 MiB and Git failures return `null`.
This is a conservative content proof: later edits to the same context can make
reverse application fail even when the behavior survives.

`squashPublishedIn` preserves its boolean interface by checking recent tags through
this function. `squashTagOf` still answers the separate historical question of which
release first added an equal patch. Release storage, publication and installation
verification are separate slices; declarations and version labels are not inputs
to this proof.
