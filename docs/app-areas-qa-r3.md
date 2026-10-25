# App areas: round 3 presentation rules

Repositories → Actions uses one repository heading and compact shared record cards for CI runs.
The full session browser toolbar is unnecessary here. Each run shows its complete title, harness,
model when known, a date localized to the selected language, and a 44px open action. Missing
harness/date values show N/A. The repository path is stated once per group.

Leadership → Check-ins shows rounds whose session can still be matched by fleet id or conversation
id. Orphaned rounds remain in the underlying report store but are omitted from this view; they do
not contribute to pagination. The matched rounds remain newest first, ten at a time.

The usage overview states each plan name once. Forecast-driven attention uses the same warning
icon as percentage-driven attention for every harness. An over-pace account without a server
pause time shows N/A rather than claiming that no pause is needed. Planning uses the sustainable
parallel recommendation until renewal, displays the requested planning duration, and explains why
a longer duration does not increase that recommendation. Hold and unmeasured states remain explicit.

The empty history message states the server-lifetime limit once; a populated history places that
scope in the header. Away mode states the deadline in the page header and permissions in the
switch description, without another availability heading. Wrapped descriptions use 13px secondary
text. Nay tabs occupy a full wrapping row, keep their full localized labels, and use 44px targets.
Billing agent switches align with account titles; KPI header controls wrap before splitting labels.

Regression fixtures cover PT/EN and desktop/phone rendering where applicable. This round's brief
forbids test execution and commits in the worker worktree; independent live QA and test execution
must happen during integration.
