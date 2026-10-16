# Away state and check-in defaults

The global away switch covers every session while it is active. Switching it off
clears every own away flag in the managed registry, including stopped sessions.
This makes “the owner is back” true for the whole fleet and prevents an inherited
spawn flag from leaving the session header stuck on Away. Global and individual
writes share one mutation queue: an explicit individual activation ordered after
the global OFF is preserved. Another global OFF clears it again.

A session's fixed header exposes its **own** away switch in both states. Both ON
and OFF ask for scope: only this session, or a snapshot of all sessions running
now. This second scope edits their own flags; it does not turn on the persistent
global switch or affect future sessions. As before, global ON takes precedence
over own flags; the scope dialog states this explicitly. Use the global return
control to end a global away period. Existing global activation, Settings OFF,
header return, and all-active scope confirmations show the active-session count
and the delivery quiet window/cooldown. Header controls have 44px targets and use
the existing chip style, confirmation modal, picker and theme colors.

The verified session identity resolves to a managed ID. Role lookup must resolve
that registry row's conversation ID too, using conversation role first and managed
role second, consistently with `roleOfRow`. A leader role stored under the
conversation must authorize the per-session route as well as the global route.

## Notice delivery

State writes and fleet refreshes are immediate. Prompts use one queue shared by
global changes, individual changes and the all-active scope. Each session receives
only the latest effective state after 45 seconds without further changes, with a
minimum of five minutes between successful deliveries. A final state equal to the
last successful notice (or initial state, before the first notice) sends nothing.
Leaders hear permission changes; workers only hear effective ON/OFF transitions.
The queue rechecks that a session is still running, retries failed sends after the
quiet window and records only successful deliveries. The leader making a global
change is already informed by the response and gets no prompt. Notes pass through
the existing secret-redaction helper.

Queue/cooldown state is process-local, as was the previous live-notice dedupe.
Restarting the server discards pending notices; the stored state remains correct
and new/reopened sessions read it in their briefing. Global expiry retains the
existing lazy-expiry behavior; clearing individual flags happens on explicit OFF.

## Live check-in defaults

Stored agendas have an internal `inherits` marker. New agendas follow the global
interval, pause and checklist on each read and scheduler tick. Any owner adjustment
to a session marks the entire agenda as customized, even when the chosen value
equals today's default. Later global edits preserve that whole agenda. Reports,
manual runs and automatic runs preserve the marker; it is not part of the public
agenda payload.

Legacy agendas have no reliable record of whether the owner edited them. An
agenda equal to the original built-in configuration is migrated as inherited;
other configurations are preserved as customized. An old explicit choice equal
to the original defaults cannot be distinguished from an untouched agenda. The
first read persists the inferred marker, so a later default change cannot change
the migration decision.

Changed inherited settings reschedule from the time they are observed, at most
one scheduler tick (15 seconds) after the update. They never send configuration
prompts. Rapid default edits therefore do not inject messages into leaders; only
the final applicable agenda schedules their next regular check-in. The scheduler
reconciles defaults even when every previously saved agenda was paused. Settings
counts only active leaders, including those without a stored agenda, via
`GET /api/checkin/defaults` and explains inheritance in Portuguese and English.

## Verification handoff

Unit coverage is in `server/away.test.ts`, `server/checkin.test.ts`,
`components/sessions/AwayChip.test.tsx`, and the Settings defaults component tests.
The component cases cover Portuguese/English, 390px/desktop target sizes, shared
scope choices, affected counts, cooldown wording and theme tokens. They are not
browser screenshots. The implementing worker did not execute tests, TypeScript,
installs or servers and did not commit, as instructed. The leader must run the
related server/web suites and TypeScript with
`NODE_OPTIONS=--max-old-space-size=6000`, then perform independent light/dark
browser QA at desktop and 390px before acceptance.

## Changed files and reused primitives

- Server behavior: `packages/server/server/away.ts`, `checkin.ts`, `index.ts`;
  the `preferences.ts` defaults comment follows the new rule.
- Server regressions: `packages/server/server/away.test.ts`, `checkin.test.ts`.
- Session header entry points: `packages/web/src/App.tsx`,
  `packages/web/src/pages/SessionsPage.tsx`.
- Session toggle and scope question:
  `packages/web/src/components/sessions/AwayChip.tsx`, `AwayChip.test.tsx`.
- Shared notification impact text: `packages/web/src/components/AwayImpact.tsx`.
- Existing global controls: `packages/web/src/components/AwayModeDialog.tsx`,
  `AwayPill.tsx`, `packages/web/src/pages/settings/AwaySection.tsx`.
- Browser state/request adapter: `packages/web/src/lib/awayMode.ts`,
  `awayMode.test.ts`.
- Defaults copy/counts: `packages/web/src/pages/settings/CheckinDefaultsSection.tsx`,
  `CheckinDefaultsSection.test.tsx`.
- Documentation: this file.

Reused UI primitives: `SESSION_CHIP_STYLE` from `RoleChip`, `ConfirmModal`, `Select`,
`RowSwitch`, `SectionHeader`, and `CheckinConfigControls` (including its existing
`ToggleSwitch` controls). The activation dialog keeps its existing `Checkbox` and
`FieldTextarea`. The header toggle uses the existing outlined chip shape and
Lucide `Moon`; shared colors use CSS variables for light/dark themes.

## Pending notices are in memory

The "away changed" notices waiting out the 45 s quiet window (and the per-session cooldown record)
live in the server process only. A server restart inside that window silently drops the queued
notice: the session keeps the instruction it last heard until the next away change. The away
state itself (global flag, per-session flags) is persisted and unaffected.

The away dialog's `activeSessions` total and the away digest's current active total use
the fleet's resolved rows and shared `sessionRunning` predicate, just like the aside
summary. A missing registry `endedAt` is not proof that a session is alive: lost, exited,
closed and registry-only orphan rows do not count or receive away notices. Live external
rows (`unknown` activity) still count, as they do in the fleet. Global OFF continues to
clear own away flags on every registry row, including stopped and orphaned sessions.
