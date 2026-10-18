# Disk cleanup

The cleanup dialog scans the same repositories as `agentop clean`: the current repository and
known project paths, using git's worktree list. It never discovers arbitrary filesystem roots.
Scanning only reads facts; applying a selection remains a separate operation with a fresh scan,
the existing live-session/server/process protections and git's refusal to remove a dirty worktree.
Branches remain intact. Dependencies are initially unchecked; missing-folder records can be
selected even though they free zero bytes. Protected items remain visible with their reason.

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
