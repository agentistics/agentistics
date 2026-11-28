# Disk cleanup

The cleanup dialog scans the same repositories as `agentop clean`: the current repository and
known project paths, using git's worktree list. It never discovers arbitrary filesystem roots.
Scanning only reads facts; applying a selection remains a separate operation with a fresh scan,
the existing live-session/server/process protections and git's refusal to remove a dirty worktree.
Branches remain intact. Dependencies are initially unchecked; missing-folder records can be
selected even though they free zero bytes. Protected items remain visible with their reason.

Worktree removal requires a clean working tree and a named branch whose commits are published:
HEAD is contained in `origin/<branch>`, or in the head of a **merged pull request** of that branch.
A merge into a local default branch, or matching patches there, does not prove the work was pushed.
Detached HEADs are kept. Apply checks these conditions and live use again after waiting and
immediately before git removes the worktree, without `--force`.

Published is not enough on its own. A **merged** worktree (ancestor of the default branch, rebased
or cherry-picked onto it, or merged by pull request) is removable. A published but **unmerged** one is
removable only after 30 days without a commit, and its commits are first saved with `git format-patch`
under `~/.agentistics/archive/worktree-patches/<repo>/<name>-<date>/`; if the patches cannot be
written, the worktree stays. Branches are never deleted.

A merged worktree whose last commit is **less than 3 days** old is kept (`young`), unless a managed
session started in it was ended for good (`endReason: 'final'`). An unknown commit date counts as
young. Removing is ordered so that every check runs before anything is deleted: a refusal leaves
`node_modules` in place too; the tree is then checked once more before git removes it.

Merged pull requests come from `gh` when it is installed, signed in and the repository's `origin` is on
GitHub: one `gh pr list --state merged` per repository, cached for a day in `clean-merged-prs.json`.
This is what recognises a squash merge of several commits. Without `gh` the git-only answer applies.

## Cleanup when a worker is closed

When a managed session that left a hand-back is closed, and the directory it was started in is the
root of a linked worktree that is merged and clean (no uncommitted change, no ignored file that cannot
be regenerated, nobody else inside), the server removes that worktree through the same paced, locked
path, 20 seconds later, and notes it on the session's task. Anything in doubt is kept. Sessions that
end on their own are not covered; their worktrees show up in the normal plan.

Only a **final** end does this: a person's or a leader's kill or retire, or the engine's
`fechar-entregue`. An account switch, a mode migration and a hand-off recreate the session in the same
directory and never clean it, and neither does the engine ending a delegated session (`delegation`).
Every kill states its reason (`endReason`, required by type) and the row records it. The cockpit's
kill is `final`, but the immediate removal runs only in the server process; for a cockpit kill the
worktree leaves with the next plan. Right before removing, the registry and the process list are read again: any session in
that directory that is not ended (running, starting or stopped) keeps it.

## Disk floor

Every hour the server reads the free space of the filesystem holding the worktrees (the fullest one
when projects live on several). The floor is the **larger** of 15 % and 30 GB; change it with
`diskCeiling: { freePct, freeGB }` in the preferences. Under it, at most once a day, the person gets a
notification that opens the cleanup dialog and each running **leader** session gets a message saying
how much a safe cleanup would free. Nothing is removed without a confirmation. A recovery above the
floor plus 10 % re-arms the notice.

**WSL.** Freed space returns to Windows only with sparse VHD turned on (on Windows:
`wsl --manage <distro> --set-sparse true`) or after compacting the virtual disk. It is said once per
machine, in the notice or in the first `GET /api/clean/disk` that reads it, and remembered.

`GET /api/clean/disk` returns the reading (`volume`, `floorBytes`, `low`, `wslNote`). The MCP tools
`agentistics_clean` (read) and `agentistics_clean_apply` (action) mirror the REST pair.

CLI and web cleanup hold `/tmp/agentistics-cleanup.lock` with kernel `flock`. Removals reserve
their start in its adjacent `.starts` history: at least two minutes apart and at most six per
rolling hour, including separate CLI invocations. Failed attempts conservatively consume a slot.
Cleanup waits while a heavy job is running. The lock holder uses GNU `tail --pid` to watch the
cleaner every 100 ms: if the cleaner exits or is killed, the holder exits and releases its kernel
lock. Missing lock support or unreadable history refuses cleanup rather than bypassing the guard.
The CLI prints a short pause reason
while waiting for the lock, rate limit, machine health or heavy jobs, with repeated polling
messages limited to one per 30 seconds. Failed or skipped dependency removals do not count as
freed bytes in the web result.

`clean/clean-pace.ts` owns the policy. `throttledRemove` walks `node_modules` depth first without
following symlinks, removing at most 2,000 entries per batch (also bounded by argv size), with a
250 ms pause per batch. Unlinks run under `nice -n19` and `ionice -c3` where available. Between
batches G1 supplies the health level and S10: cleanup pauses at tight, critical or readonly and
resumes automatically at ok. Dirty+Writeback above 1 GiB waits until below 512 MiB. While paused,
only regenerable dependencies may be partially removed; source files remain intact. Cancellation
also leaves the remaining entries in place. Only after dependencies are gone may git remove the
small remaining tree. Engine cleanup integration is a separate C2 slice.

The scan displays bytes found, candidate count, projects completed, three stages, an estimated
remaining time and the last twenty activity lines (the dialog displays the latest eight). Progress
is an estimate while repositories are still discovering worktrees, and never moves backwards.
The existing two-repository/four-worktree pools, low I/O priority and process timeout remain in use.
Cancellation aborts active scan subprocesses and prevents queued inspections from starting.
Closing the scan sends it to the background. Its existing bell row stays pinned with live progress,
then offers **Review and clean** until the user closes/finalizes the result or completes cleanup.
Clearing notification history does not remove this row. Completion uses Nay's regular card,
including snooze/dismiss and the existing notification settings, with an action to open the result.
The scan and its cache live in the server process; restarting the server ends that task.

The result shows allocated disk size by type, filters with counts, sortable columns and selection
counts/bytes. Select-all affects the visible filter and preserves choices hidden by other filters.
On mobile the same data appears in a bottom sheet with cards and 44px controls. Folder names stay
visible; full paths are available in titles. Colors use the light/dark theme tokens.
The result header counts distinct repository paths represented in the complete item list, including
kept items, before filtering. Different worktree/folder names do not add projects to that count.
Filter chips wrap; mobile selection and the shared sort dropdown share one row, and the type/size legend
can be expanded on demand. Project, folder and scan-log names remain readable in full. The header labels reclaimable candidates as “items
to clean”; the All filter count also includes protected items. Desktop gives folder names the
remaining table width, with a narrower project column and fixed idle/size columns.

Idle time is display metadata, separate from the existing commit-based cleanup eligibility rule.
On Linux, GNU `du --time` computes the newest nested mtime during the existing size walk; the
newest of that and the last commit is shown. On other systems the folder mtime and last commit are
used, avoiding an additional recursive walk. Unknown activity displays a dash. Disk free space
before/after is read from the server working directory's filesystem; those values can include
concurrent disk activity and do not necessarily differ by the estimated selected byte count.

## HTTP protocol

Existing `GET /api/clean/plan`, `POST /api/clean/apply` (with `ids`) and `GET /api/clean/job`
remain the plan/apply/job flow. Scan replies add an id, stage, ETA, byte/item/project counters,
background flag and bounded log; ready plans retain `items`/`reclaimable` and add scan timestamps,
activity, project/name and kept-item reasons. The existing `progress` fraction stays in `[0,1]`.
Job progress stays in `[0,100]`. Completed jobs add elapsed time, disk free before/after, removed
paths and separate pruned/removed-worktree counts. The legacy `worktrees` count includes pruned
records as before; `removedWorktrees` is the separate physical-removal count used in the dialog.

Additive endpoints:

- `GET /api/clean/scan` reads the current snapshot or `null`, without starting a scan.
- `POST /api/clean/background` keeps the current scan/result pinned for review.
- `POST /api/clean/cancel` aborts scanning; it cannot cancel an apply job.
- `POST /api/clean/finalize` forgets a terminal scan/result. It does not interrupt scanning.

Foreground results may be reused for five minutes. Background results are retained until finalized,
so opening the bell's completion action never silently starts a replacement scan. Applying still
rechecks the selected ids against current facts and repeats all removal guards.

On desktop the result keeps its summary, filters and actions in view while only the item list
scrolls. On mobile the result body scrolls together so wrapped controls leave room for whole cards;
the dialog header and actions stay visible.
The confirmation shows the selected byte total and count once. Scan logs show timestamps with
seconds and sizes only after measurement; unfamiliar scan steps fall back to discovery wording.
Cleanup completion replaces the bell’s earlier progress row, with localized singular/plural counts
and no empty removal categories. Escape closes the notification bell through the shared overlay stack.

The default All view lists selectable items first, then protected items, descending by size within
each group. Other sort controls still work. Worktree names wrap in full; dependency rows put
`/node_modules` on a secondary line. The selection footer includes the number of selected items
outside the active filter. Opening the dialog focuses its container; keyboard navigation retains
visible focus rings. Unknown scan phases show a generic “Checking” label.
