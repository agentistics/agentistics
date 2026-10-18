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


Leadership lives at `/leadership` (leaders), `/leadership/checkins`,
`/leadership/handoffs` and `/leadership/away`. Leaders use the shared fleet and role
stores and the active-leaders filter. Their record cards show the task when known,
state, elapsed time when known, and direct children resolved by managed or conversation
identity. Loading, unavailable and stale fleet states never claim an empty fleet.

Check-ins read `GET /api/checkin` for each leader's latest round and follow check-in
and reconnect events. `/api/checkin/report` is the authenticated POST ingestion route,
not a report listing. Status pills distinguish OK, resolved and needs-you rounds;
the existing global defaults editor follows the reports. Individual agenda controls
remain in each session's check-in panel.

Hand-offs reserves its page for HANDOFF.CONFIG (`t-49f70edb75`) with a plain explanatory
sentence and no configuration controls. Away mode composes the existing settings
switch, activation dialog, return confirmation and fleet impact. The top-bar away pill
links to this page. Existing settings URLs remain usable; digest offers and their
answers remain in the notification bell, using the existing away digest flow.
