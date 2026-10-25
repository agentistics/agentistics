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

## Usage and activity presentation

The Usage overview uses `usagePaceState` for both its headline and its account pills. A plan on
hold is paused; a tight budget or an over-pace measurement counts as above pace. A recent pace
measurement that is on target does not cancel a tight budget warning.

The shared detailed plan card also checks each window's exhaustion forecast. An account that
runs out before renewal shows an attention label even when its absolute percentage is below the
75% warning threshold. Percent rings continue to show the measured percentage. Forecast text
uses a theme-specific amber that stays readable on light surfaces.

Overview and planning cards use two columns on desktop and one on phones. Planning titles include
the harness and account, with the plan beneath them, so matching account nicknames are distinct.
Metric captions wrap in full; reset times and relative durations wrap as complete phrases. Account
sections stretch to the row height and reserve space for the optional stale-reading notice.

The board activity page resolves task titles from the shared task list and links to task details.
`pages/taskActivity.ts` translates event kinds and known message metadata to PT/EN sentences,
normalizes machine actor identities, and uses a generic sentence for unknown event shapes.
Raw payloads and identifiers are not fallback display text. Missing task metadata is stated as
unavailable. `RecordCard`'s stacked field layout keeps each label next to its value on wide screens
and allows titles and actors to wrap on phones; task links have a 44px minimum height on phones.

Area headers reserve desktop space for the statistics pull-tab. Usage Limits reuses the existing
limits component without its modal inset. Actions shows its run count when there are runs and a
single empty-state sentence otherwise.
