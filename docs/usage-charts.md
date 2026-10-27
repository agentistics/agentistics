# Usage charts

Usage has one screen at `/usage` (Agora / Now). Old `/usage/history` bookmarks redirect there;
History is no longer a menu entry on desktop or mobile. The account list remains below the charts.

The default view gives each account a compact row with 5 h and weekly charts side by side (stacked
on mobile). The other views compare all accounts, the maximum account percentage per harness,
one harness, or one account. The harness picker includes the metrics data's harnesses and session
history, including harnesses without plan readings. Those show “sem leitura de limites” / “no limit
readings”; hours and busiest message times still come from their message timestamps.

Identity is `harness:account`, never the display label. `lib/usageColors.ts` assigns the existing
categorical chart hues to the sorted full identity set before filtering. Accounts keep their color
across limit charts, peak cards and the small marker beside each account in the list; harness overlays use the same palette for harness identities.
Hovering a line or its legend dims the other lines. Descriptions explain each chart's percentages.

Lines use steps, holding the last observed value until the next reading. Five-hour lines break on
changed reset ids (allowing five minutes of jitter), decreasing usage, missing readings or gaps over
one hour. Weekly lines break only on a drop greater than 20 percentage points or an absence over
six hours, tolerating sparse readings and small corrections. Segments shorter than two readings
are omitted. Nulls remain real breaks; missing readings never become zero usage.

Peak detection is conservative: it segments original readings before coarsening to half-hour
intervals, so skipped resets and missing readings cannot manufacture consumption. Cards show
measured increase, elapsed minutes and local date/time rather than a rate. Hourly stacked bars
allocate measured 5-hour increases proportionally over the observed interval; they do not claim
an exact time for activity between readings. Message activity is a compact Monday–Sunday × 0–23 h
orange grid for the last 14 days, with local timestamps and Portuguese/English labels.

The desktop area rail includes all seven parent icons in the same order as its expanded tree.
Hover opens it; leaving schedules a 150 ms close, cancelled while focus remains inside. Touch keeps
the toggle button. The expanded rail is positioned over the page while its host stays 60 px wide.
