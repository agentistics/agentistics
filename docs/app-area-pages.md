# Agentask activity and repository Actions

`/tasks/activity` shows the latest 60 board events from `/api/tasks/activity`, newest first,
using the shared `useTaskActivity` hook. Each record links to its task at `/tasks/:id`.
The page offers a manual refresh and follows the hook's existing check-in updates.
An unsuccessful refresh keeps the last events and shows an unavailable message; an empty
state is shown only after a successful response with no events.

`/repositories/actions` shows stored sessions whose `ci` flag is exactly `true`. The pure
`groupCiSessions` helper groups them by `git_remote`, orders repositories by their newest
run's `start_time`, and orders runs newest first. Missing or empty remotes share a final
"No repository" section and do not count as a repository in the header. Invalid timestamps
sort after known timestamps. Each section uses the existing `RecentSessions` component,
including its session drilldown, without fleet controls.

Both pages read their labels from the area registry through `PageHeader`. Existing board
(`/tasks`, `/tasks/:id`) and repository (`/repositories`, `/repo/:id`) routes remain available.
