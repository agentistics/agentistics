# Loader D1 handback

Commit: `d64428abff6a4ba58262e6dc2d6bf98a6e288c52`
Branch: `feat/loader-d1`
Remote verification: `git ls-remote origin refs/heads/feat/loader-d1` returned the same SHA.

## Files changed

- `packages/web/src/components/AgentisticsLoader.tsx`: new D1 loader; canonical logo paths; 7x7 below 40px, 10x10 at 40px+, five comets, eight sparks at 40px+, WAAPI/reduced-motion/offscreen handling.
- `packages/web/src/components/AgentisticsLoader.test.tsx`: canonical path/stroke-width and accessible status tests.
- `packages/web/src/components/DeployCentral.tsx`: CSS `RefreshCw` spinner, 13px → `AgentisticsLoader` 13px while loading; refresh icon remains idle.
- `packages/web/src/components/HardwareModal.tsx`: CSS `RefreshCw` spinner, 14px → `AgentisticsLoader` 14px while loading; refresh icon remains idle.
- `packages/web/src/components/HarnessChat.tsx`: `Loader`/`ttyChatSpin`, 16/14px → `AgentisticsLoader` 16/14px.
- `packages/web/src/components/TeamMembers.tsx`: CSS `RefreshCw`/`RotateCw` spinners, 10px → `AgentisticsLoader` 10px while active; idle icons remain.
- `packages/web/src/components/sessions/ArtifactsAside.tsx`: `Spinner`/loading `Loader`, 16/13/11/12px → matching `AgentisticsLoader` sizes.
- `packages/web/src/components/sessions/NewSessionModal.tsx`: loading `Loader`, 12/14px → matching `AgentisticsLoader` sizes.
- `packages/web/src/components/sessions/ShellBand.tsx`: `Loader2` 13px → `AgentisticsLoader` 13px.
- `packages/web/src/components/team/AddCentralDrawer.tsx`: `Loader2` 13px → `AgentisticsLoader` 13px.
- `packages/web/src/components/team/CentralAdminPanel.tsx`: `Loader2` 12px → `AgentisticsLoader` 12px.
- `packages/web/src/components/team/ConnectionCard.tsx`: `Loader2` 10/13px → matching `AgentisticsLoader` sizes.
- `packages/web/src/components/team/ConnectionIdentity.tsx`: `Loader2` 12px → `AgentisticsLoader` 12px.
- `packages/web/src/components/team/RemoteSessionsBlock.tsx`: `Loader2` 13px → `AgentisticsLoader` 13px.
- `packages/web/src/components/team/SharedReposPanel.tsx`: `Loader2` 11px → `AgentisticsLoader` 11px.
- `packages/web/src/components/vault/VaultPicker.tsx`: `Loader2` 14px → `AgentisticsLoader` 14px.
- `packages/web/src/components/vault/VaultUnlock.tsx`: `Loader2` 13/14px → matching `AgentisticsLoader` sizes.
- `packages/web/src/components/nay/NayDock.tsx`: unchanged; all three `ag-working-spin` `Loader2` state indicators were deliberately left alone.
- `packages/web/src/pages/ExportPage.tsx`: CSS circle spinner 14px → `AgentisticsLoader` 14px.
- `packages/web/src/pages/VaultPage.tsx`: `Loader2` 14px → `AgentisticsLoader` 14px.
- `packages/web/src/pages/settings/BackupSettings.tsx`: `Loader2` 14/15px → matching `AgentisticsLoader` sizes.
- `packages/web/src/pages/settings/MachineFleetPanel.tsx`: `Loader2` 11/12px → matching `AgentisticsLoader` sizes.
- `packages/web/src/pages/settings/MachinesSettings.tsx`: `Loader2` 12/14px → matching `AgentisticsLoader` sizes.
- `packages/web/src/pages/settings/ProvidersSettings.tsx`: `Loader2` 12/13/14px → matching `AgentisticsLoader` sizes.
- `packages/web/src/pages/settings/VaultSettings.tsx`: `Loader2` 14px → `AgentisticsLoader` 14px.

`App.tsx` and notification files were not touched.

## Deliberately left alone

- All `ag-working-spin` indicators, because they communicate active work/state rather than passive loading.
- Idle refresh/rotate icons, because they are actions/state affordances; only their active waiting branch uses the new loader.

## Validation

- `bun install` under `/tmp/agentistics-heavy.lock`: passed (required sandbox escalation; lockfile restored so no dependency-version change is included).
- `flock /tmp/agentistics-heavy.lock bunx tsc -b`: passed after install.
- Focused loader unit tests: 2 passed, 0 failed.
- Commit hook: 67 related test files passed.
- `flock /tmp/agentistics-heavy.lock bun run build`: exited successfully.
- Full plain `bun test`: repository-wide run had unrelated pre-existing failures, including concurrent ephemeral-server `EADDRINUSE` failures and journal CLI environment failures; no loader test failed.
