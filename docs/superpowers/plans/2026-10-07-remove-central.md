# Remove the central — plan (CENTRAL.REMOVE, phase 1)

**Date:** 2026-10-07 · **Base:** `origin/main` @ `c87f91be` (v2.111.0) · **Status:** plan only, nothing deleted. Owner decisions D1–D5 resolved (§7); D6 open.

Owner decision (07/10, final): the central does not exist any more. Agentistics is ONE product.
Multi-machine / team features come back later only as the paid Agentistics Cloud
(`agentistics-cloud` repo). This plan removes the central **and everything that only exists to
talk to one** (member sync, sharing rules, sealed envelopes, machine-fleet relay, IAM/login, Mongo,
CI ingest) as plain deletion. Existing central installs are NOT migrated (owner decision, §2).

---

## 0. Scope in one paragraph

"Central" is not a flag on top of the product; it is a second product inside it: a Mongo-backed
aggregator with its own auth (accounts, teams, passwords, MFA, step-up, reset), its own ingest
(`/api/team/ingest`, CI push + GitHub OIDC), its own read model (team sessions, member stats caches,
team tasks, team workflows, Mongo tags), its own deployment (central.sh, docker/central*.yml,
`agentop central`, the `agentop-central` unit, teal PWA branding, port 48080) and a MEMBER half in
every normal install (connections, uploader, sharing rules, envelopes, reverse WebSocket, relayed
fleet). Measured: ~33.6k lines of central-only server modules, ~19.8k lines of central-only web
modules, plus ~71 `TEAM_CENTRAL` branches inside `index.ts`, the central parts of
`cli-start.ts` (264 KB) and `cli-i18n.ts`, and ~620 files mentioning the word.

Not central (keep): the word "central" used generically (e.g. "central panel" in Sessions layout
comments, `centralMachinePick` is NOT one of those — see inventory), host allowlist / CORS / CSRF /
security headers / exposure `local`|`lan`, the local tags store, Repositories (git remote grouping is
local), Dynamic Workflows read from local transcripts, the vault, the board.

---

## 1. Inventory

Legend: **DEL** delete · **KEEP** keep as is · **MOVE** keep the piece non-central code needs,
drop the rest.

### 1.1 CLI verbs and binary entry points (`packages/server/bin/cli.ts`)

| Entry | File | Action |
|---|---|---|
| `agentop central up/init/down/logs/status/restart/pull/setup-token/reset-password` | `cli-central.ts` (52 KB), `central-runtime.ts`, `rebuild-flags.ts` (central half), `vault/central-env.ts`, `standalone-compose` | **DEL** — no stub; an unknown verb answers like any unknown verb. |
| `agentop member connect/leave/status` | `cli-member.ts`, `member-connect-args.ts` | **DEL** |
| `agentop setup` (solo/central/member wizard) | `cli-setup.ts`, cockpit setup question | **MOVE** — becomes archive consent + boot offer only; no mode question. |
| `agentop ci-push` | `ci-push.ts`, `team-oidc.ts` | **DEL** |
| `agentop setup-token`, `agentop reset-password` | `cli-setup-token.ts`, `cli-reset-password.ts` | **DEL** |
| `agentop server --central [--bg]`, `start central` | `cli.ts`, `cli-start.ts` | **DEL** |
| `agentop restart central`, `--rebuild` central path | `cli.ts`, `rebuild-flags.ts` (`centralRebuildArgs`) | **DEL** central half; machine/server halves KEEP |
| `agentop autostart central …` | `autostart.ts` (`AutostartMode` `'central'`), `service-manager.ts` central runtime handling | **DEL** the mode |
| `agentop doctor --exposed` central checks | `cli-doctor.ts` (mfa-store, accounts) | **MOVE** |
| `agentop upgrade` central step | `upgrade.ts` L569–580 (`CENTRAL_PROJECT='team-mode'`, `central pull/up`) | **DEL** |
| `agentop uninstall` central plan | `uninstall-plan.ts`, `cli-uninstall.ts` | **DEL** the central plan (no leftover cleanup) |

### 1.2 Environment variables (`config.ts`, `exposure.ts`, Dockerfile, compose files)

DEL: `AGENTISTICS_TEAM_CENTRAL`, `AGENTISTICS_CENTRAL_USER`, `AGENTISTICS_CENTRAL_RUNTIME`,
`AGENTISTICS_TEAM` + `AGENTISTICS_TEAM_DIR` (Phase-1 folder union, `TEAM_MODE`),
`AGENTISTICS_INGEST_ONLY`, `AGENTISTICS_OIDC_ISSUER`, `AGENTISTICS_OIDC_AUDIENCE`, `MONGO_URL`,
`MONGO_DB`, `AGENTISTICS_TEAM_ORG`, `AGENTISTICS_TEAM_INGEST_TOKEN`, `AGENTISTICS_TEAM_PASSWORD`,
`AGENTISTICS_TEAM_SESSION_SECRET`, `AGENTISTICS_TEAM_TLS`, `AGENTISTICS_TEAM_CONN_DIR`,
`AGENTISTICS_TEAM_SENT_FILE`, `AGENTISTICS_TEAM_SYNC_FILE`, `AGENTISTICS_IMAGE`,
`AGENTISTICS_DEPLOY_HINT=central.sh`, `AGENTISTICS_CENTRAL_URL` / `AGENTISTICS_CI_TOKEN` (ci-push).

Also DEL (D5, D2): the env knobs `AGENTISTICS_EXPOSURE` and `AGENTISTICS_ALLOW_LOCAL_SHELL` (the
profile is pinned to what `local` is today — no refusal logic added), `AGENTISTICS_ALLOWED_ORIGINS`
(the reverse-proxy escape hatch; removing it only NARROWS `host-allow`), `BIND_IP`,
`AGENTISTICS_CONTAINER` / `IN_CONTAINER` (the Docker image path).

**SECURITY GATES STAY (leader, 07/10).** While the server binds `0.0.0.0` (§1.11),
`capability-guard.ts`, `host-allow.ts`, `csrf.ts`, `cors.ts`, `security-headers.ts`, the `CAPS`
plumbing in `exposure.ts`, `client-ip.ts` and `AGENTISTICS_TRUST_PROXY` are NOT removed or
weakened — they are what keeps the shell and vault routes away from the LAN. Only their central
inputs go. Re-evaluate them only after D6 is decided (and only if it is approved).

### 1.3 Preferences keys (`preferences.ts`, `@agentistics/core` `team.ts`)

- `team` (`TeamConfig`: `schema`, `mode: 'solo'|'member'`, `connections[]` with `shareMode`,
  `sources`, `deniedRepos`, remote-session consent, legacy mirror `endpoint/org/user/token/
  pushIntervalSec`) — **DEL** from the type and every reader/writer; a stored key is ignored, not
  cleaned (§2). `vault/prefs-tokens.ts` strip/inject of connection tokens goes too. `engine/load.ts` also reads
  `prefs.team.mode === 'central'` (L244–250) — DEL.
- `connections/tokens.sealed` (vault purpose `central-token`), `~/.agentistics/central/central.env`
  + sealed secrets (purpose `central-env`), `team-sent.json`, team sync file, connection dir,
  envelope keypair (purpose `envelope-key`) + `envelope-inbox` / peer pins — **DEL** the code that
  writes/reads them and the three purposes from `packages/vault/src/format.ts` `HOST_PURPOSES`
  (files on disk are left as they are).
- `finishedTasks`/board: `Task.shared` flag — **DEL** (absent already reads as not shared).
- `/api/user-prefs` central branch (`userPrefs` in Mongo, `X-Prefs-Writable: false`) — **MOVE**:
  machine file only. `a11y-prefs.ts` same.
- Billing: `usePlanBasis` `blocked: 'central'` — **DEL** branch.
- `sessionUserGroups`, pins etc. — KEEP (machine-local `/api/user-prefs`).

### 1.4 Server routes (`index.ts`, `index-routes.ts`, `capability-guard.ts`)

DEL every route behind `if (!TEAM_CENTRAL) return 404` (~45 blocks, L3826–4319, L4404–4596):
`/api/team/ingest`, `/api/team/policy`, `/api/team/whoami`, `/api/team/members*`,
`/api/team/machines*`, `/api/team/tokens*`, `/api/team/repos*`, `/api/team/config`,
`/api/team/keys`, `/api/team/envelopes`, `/api/team/proposals`, `/api/team/account-repos`,
`/api/team/tasks`, `/api/team/session`, `/api/team/login|logout`, `/api/team/forget*`,
`/api/team/agent` (WS), machine-fleet relay routes (`machine-fleet-route.ts`,
`machine-fleet-relay.ts`), IAM routes (`iam-handlers.ts`: accounts, teams, owner setup, reset
requests, MFA, step-up), `/api/tags` Mongo branch (`tags-store.ts`), `/api/team/status` +
`/api/team/connections*` (member side, `team-connections.ts`).

DEL the auth gate (L663: `TEAM_CENTRAL && /api/ && !AUTH_PUBLIC`) and `AUTH_PUBLIC` +
`authz-gate.test.ts`. DEL the ~25 `if (TEAM_CENTRAL) return 404` guards on host routes (the
condition disappears, the route stays). DEL central-only boot blocks (L247–263, L4735, L4765 keep the
non-central body unconditionally). `/api/fleet*` stays (its central refusal goes).

KEEP: everything else. `capability-guard.ts` loses only the central-specific entries; the
`localShell` table and `RESERVED_PREFIXES` stay. Its tests that pin "absence of relay routes" go.

### 1.5 Server modules — central-only (DEL)

`central-branding.ts`, `central-config.ts`, `central-reach.ts`, `central-runtime.ts`,
`cli-central.ts`, `team-*.ts` (account-repos, admin, agent, agent-client, capabilities,
connections, elsewhere, forget, forget-client, ingest, live, migrate, oidc, presence, repos, rules,
scope, source, stats, store, task-routes, task-view, tasks, tokens, uploader, watch, workflows),
`envelope-*.ts` (client, crypto, inbox, keys, message, proposals, routes, store), `iam-*.ts`,
`accounts.ts`, `teams.ts`, `org-team.ts`, `bootstrap.ts`, `mongo.ts`, `share-rules.ts`,
`rotate-identity.ts`, `rotate-claim.ts`, `account-repos.ts`, `account-home.ts`, `member-*.ts`,
`machine-consent.ts`, `machine-fleet-relay.ts`, `machine-fleet-route.ts`,
`sessions/machine-fleet.ts`, `ingest-batch.ts`, `uploader-auth-stop.ts`,
`notifications-authority.ts`, `notifications-context.ts`, `auth.ts`, `auth-principal`, `passwords.ts`,
`password-policy.ts`, `totp.ts`, `mfa-store.ts`, `reset-requests.ts`, `secret-store.ts`,
`user-prefs-store.ts`, `tags-store.ts`, `tags-authority.ts` (account/team/machine sources),
`deploy.ts` + `deployment-config.ts` (central deploy hints; verify), `standalone-compose`,
`stop-local-scope` (verify), `scripts/migrate-mongo-dates.ts`, `vault/central-env.ts`.
Total ≈ 33.6k lines incl. tests.

### 1.6 Shared helpers non-central code imports from central code (KEEP / MOVE)

| Helper | Non-central importers | Decision |
|---|---|---|
| `audit.ts` (writes to Mongo on a central) | `engine/load.ts`, `upgrade-web.ts`, `cli-reset-password` | **MOVE**: keep the pure builder + the local log sink; drop the Mongo sink |
| `stepup.ts` | `vault/http.ts` | **MOVE**: keep only what the vault uses (local re-auth); drop account/team/password entries of `PROTECTED` and `stepup.test.ts`'s exact table changes accordingly |
| `mongo-dates.ts` | `tags-local-store.ts` (revives ISO → Date) | **MOVE** the `fromBsonDate`/`toBsonDate` revive pair into `tags-local-store.ts` (or `utils.ts`); DEL the rest + `DATE_FIELDS` |
| `rate-limit.ts` | only `iam-handlers` / login | DEL with auth (re-verify no other importer) |
| `secure-origin.ts`, `host-allow.ts`, `cors.ts`, `csrf.ts`, `security-headers.ts`, `limits.ts`, `errors.ts` | `index.ts` | **KEEP** (`host-allow` loses the `ALLOWED_ORIGINS` entries; `cors` has nothing left to allow cross-origin) |
| `exposure.ts` (`PROFILE`, `CAPS`), `capability-guard.ts`, `client-ip.ts` | ~16 modules, engine host `caps` | **KEEP** (security gates stay until D6). Only the env knob and the `central`/`lan`/`public` inputs go; the module keeps producing `CAPS`, every gate keeps its call site and its tests, the route table in `capability-guard.ts` keeps every `localShell`/vault entry (only central/relay entries leave). Re-evaluate after D6 |
| `notifications-store.ts` | `index.ts`, `sse.ts` | **KEEP**, drop its Mongo/central branch |
| `redact.ts` (core) | team boundaries only today | verify other importers (core barrel); DEL if none, else KEEP |
| `tags-resolve/aggregate/detail` | tags handlers | **KEEP**, drop `machine`/`team`/`account` source types and `sharedWith` |
| `daemon-plan.ts`, `upgrade-gate.ts`, `chat-gate`, `editor-gate`, `shell-gate` | everywhere | **KEEP**, drop the `central` input |
| `engine/load.ts` `isCentral` | engine host | **KEEP returning `false`** (contract, §3) |
| `rebuild-flags.ts`, `service-manager.ts`, `autostart.ts` | machine/server paths | **KEEP**, drop the central runtime |

### 1.7 Core / public contracts (`packages/core`)

DEL: `team.ts` (TeamConfig, connections, `migrateTeamConfig`), `machineFleet.ts`, `machineActions.ts`, `remoteSessions.ts`, `siblingRules.ts`,
`proposalApply.ts`, `sharedTask.ts`, `org.ts` (`isNamedOrg`), `resolveMachineCacheScope`,
`AppData.userStatsCaches` / `machineStatsCaches` / members, `SessionMeta.user` (team attribution),
`SessionMeta.ci`, `TeamSessionDoc`, `WorkflowRun` team fields, `iam.ts`
(`canCreateAccountWith`), `agentToolPolicy.ts` field `central` and the `agentistics_team_*` rows.
MODIFY: `billing.ts` (central note), `comparison.ts`, `sessionPresets.ts`, `sessionShape.ts`,
`taskSort.ts`, `projection-client.ts` (409 central refusal), `types.ts`.
`packages/core/src/canonical/**`: no central field found — **no change** (verified by grep).

### 1.8 Web (`packages/web/src`) — 138 non-test files mention central

DEL: `components/team/**` (whole dir, 50+ files: AddCentralDrawer, CentralAdminPanel,
ConnectionCard*, ConnectionsPanel, NoticesModal, PeersSection, RemoteSessionsBlock,
RestrictionMiniTable, SharedRepos*, SharingRulesPicker, SiblingWithheldBadge, restrictionTable,
siblingWarnings, proposalNotices, withheldStyle, tablePaging, copy.ts…), `DeployCentral.tsx`,
`TeamLogin.tsx`, `TeamMembers.tsx`, `TeamRepos.tsx`, `MemberConnectionStatus.tsx`,
`memberPillState.ts`, `Login.tsx`, `OwnerSetup.tsx`, `RecoverPassword.tsx`,
`sessions/CentralSessions.tsx`, `sessions/Relayed*.tsx`, `tasks/CentralTaskBoard.tsx`,
`tasks/TaskSharing.tsx`, `pages/MembersPage.tsx`, `pages/ActionsPage.tsx`,
`pages/settings/{ConnectionSettings,MachinesSettings,MachineFleetPanel,MachineFleetDrawer,UsersSettings,machineConsentView,machineFleetView}`,
`lib/{centralMachinePick,centralMachines,relayAct,relayedAside,relayedComposer,relayedSessions,teamConnections,teamSessionRefresh,taskSharing,shareRepos,member-metrics}.ts`.
Teal icon set + `branding/*central*.svg`.

MODIFY (remove the central branch, keep the feature): `App.tsx` (`isCentral`, nav entries,
`MemberConnectionStatus`), `app-context.ts`, `FiltersBar.tsx` (Members/Presence/Machine dims),
`SessionsPage.tsx` (machine picker, relayed fleet), `SessionsAside/Rail/TopBar`, `FleetOverview`,
`useData.ts` (team caches), `usePlanBasis.ts`, `useIdleSessions.ts` (`!isCentral`),
`useAccessibility`, `notifications.ts` + `notificationCategories.ts` (team codes), `settingsSections.ts`,
`SettingsPage`, `BillingSettings`, `InstallSettings`, `RepoDetailPage` (Members + Actions tabs),
`RepositoriesPage`/`RepositoriesList`, `TagsPage`/`TagDetailPage` (sharedWith, machine/team/account
sources, "who has access"), `TasksPage`, `WorkflowsPage`, `TopUsagePage`, `compare/*`,
`upgradeFlow.ts`/`updateI18n.ts`/`updateToast.ts` (central refusal copy), `sharedPref.ts`,
`lib/brand.ts`, `editorGate`, `panelBar`, `shellBand`, `vault/VaultHeaderButton`, `vaultText`.
Server: `central-branding.ts` swap in `sse.ts` `serveStatic`.

### 1.9 TUI (`packages/tui`), VS Code, MCP, vault, engine-api

- TUI: `control/types.ts` (`ControlStatus.linkState`, `setupBlocked`, central `ServiceId`),
  `tabs/Services.tsx` (central row, central runtimes), `Chrome.tsx`/`chrome.ts` (central pill),
  `surface.ts` `logSources`, `i18n.ts`, `content.ts` (Help/Cheat sheet), `palette.ts`, `Logs.tsx`,
  `Output.tsx`, `Prompt.tsx`, `search-scope.ts`, `scripts/preview.tsx` modes. Host side:
  `cli-start.ts` (central detection, start/stop/restart/connect/disconnect), `cli-i18n.ts`.
- VS Code: `api.ts`/`protocol.ts` comments + the `refused` reason "a central" (keep `refused` for
  a no-host-power profile), `today-projected.ts`, `package.json` setting text.
- MCP: `agentistics-mcp.ts` tools `agentistics_team_members`, `agentistics_team_status` (DEL) and
  tests iterating them.
- Vault: `HOST_PURPOSES` `'central-token'`, `'central-env'`, `'envelope-key'` (DEL),
  `sentences.ts` locked-vault sentence mentions "central tokens" (edit).
- engine-api: `host.ts` L112 comment, L491–492 `isCentral(): boolean` — see §3.

### 1.10 Docker image / container launcher (D2: removed)

`Dockerfile`, `docker/` (whole dir incl. `machine.yml`, `README.md`), the cockpit's `docker`
runtime for `agentistics` (`RuntimeId` native|docker collapses to the native process, so the
"same service under two runtimes" conflict model, per-runtime Stop/Rebuild verbs and
`ControlService.conflict` go), `AutostartMode` `'machine'` + `findMachineCompose`, the
`agentop-machine` unit, `composeRebuildCommands` + docker half of `rebuild-flags.ts`,
`upgrade.ts` machine step (L585+) and `CENTRAL_PROJECT`, `upgrade-gate.ts` `container` refusal,
`daemon-plan.ts` `container` input, `IN_CONTAINER` everywhere, `live-sessions.ts`
container-specific `LiveUnavailableReason`s (`pid: host`, uid), `hardware-probe.ts` container
branch, `cli-status`/`cli-uninstall` docker rows, `Logs` docker source, CLAUDE.md "Machine in
Docker". `release.yml`'s `docker run … alpine` step is a build check, not the image — KEEP.

### 1.11 Binding — the fact, and what "never public" requires

Today the normal app is **not** bound to localhost/Tailscale: `index.ts` L4673/L4678 call
`Bun.serve({ hostname: '0.0.0.0' })` on both 47291 and 47292 (security finding S-1 in
`native-bind.ts`). `host-allow.ts` refuses a `localShell` request whose Host header does not name
this machine, but it accepts every address `os.networkInterfaces()` reports — so any peer that can
reach one of the machine's IPs (LAN, a VPS's public IP, a Docker bridge) gets the read routes with
no authentication, and the `localShell` routes too if it addresses the machine by IP. Removing the
central does not change this; removing `ALLOWED_ORIGINS`/`TRUST_PROXY` only closes the deliberate
proxy path. Making "no code path can expose it publicly" TRUE needs the bind itself to change —
**D6** (open). Recommended: bind `127.0.0.1` plus each Tailscale interface address (100.64.0.0/10,
fd7a:115c:a1e0::/48) found at boot and re-checked on the host-allow refresh timer; never `0.0.0.0`;
`tailscale serve` keeps working (it proxies to loopback). Cost: a phone on the same Wi-Fi without
Tailscale stops reaching the app by LAN IP. Pinned by a test asserting every bind address is
loopback or tailnet. Not done until D6 is answered.

### 1.12 Packaging, docs, CI

DEL: `central.sh`, `docker/central.yml`, `central.image.yml`, `central.ingest-only.yml`,
`central.localdb.yml`, `central.selfcontrib.yml`, `central.env.example`, Dockerfile central
defaults (`AGENTISTICS_TEAM_CENTRAL=1`, Mongo TLS notes, "older `agentop central` exec path"),
`package.json` scripts `dev:central`, `dev:ui:central`, `dev:central:all`, `up:central`,
`init:central`, `central`, `central:bg`, `grafana/` (verify: team dashboards?),
`docs/central-deploy.md`, `docs/github-actions.md`, `docs/examples/agentistics-actions.yml`,
`docs/media/casts/member-list.cast` + `control-center-setup.cast` (re-record),
`scripts/perf` central bits, `specs/ordered-write-channel` mentions.
EDIT: `docs/{architecture,security,exposure,cli,mcp,nay,surfaces,session-*,sessions-web,terminal-*,provider-credentials,harness-contract,backup,accessibility-magnifiers}.md`,
README, CLAUDE.md (sections "Team mode", "Managing a machine's sessions FROM a central",
"GitHub Actions", Repository rules on CI, Tags rules on teams/accounts, Security rules on login/
step-up/audit/cookies, Mongo date rule, `rotate-identity`/envelopes/siblingRules/proposalApply
architecture rows, cost-basis central rule), AGENTS.md, wiki pages.
GHCR: `release.yml` has **no** `publish-image` job any more (grep: no `ghcr` in workflows) — the
`ghcr.io/agentistics/agentistics` image is a leftover; mark the GHCR package deprecated/private
(owner action, outside the repo).
`docs/superpowers/**` central specs/plans (84 files): **MOVE** (D4) to the private
`agentistics-cloud` repo under `docs/archive/central-legacy/` (NOT `specs/`), with a `README.md`
saying: "Historical self-hosted central — NOT the reference for Agentistics Cloud; current decisions
live in docs/decisions." Deleted from the public repo in the same step. This plan file stays.

---

## 2. Existing installs — no migration (owner decision, 07/10)

Owner: "quem tem a central hoje vai se ferrar, vai ser deletado e pronto." There is **no
migration, no compatibility shim, no silent conversion, no deprecation period and no test for
central installs**. The removal is plain deletion. Consequences, stated so nobody is surprised:

- A machine running a central (native unit `agentop-central`, or the `team-mode` compose project)
  keeps running its OLD version until its operator acts. A newer `agentop` no longer has a
  `central` verb, so `agentop upgrade` from an old binary will fail at its "update the central"
  step (it calls `newBin central pull/up`) — that failure is accepted.
- A member install's `preferences.json` keeps a `team` key and `connections/tokens.sealed` etc. on
  disk; the new code simply never reads them. Nothing is cleaned up.
- The central's Docker volumes, units and `~/.agentistics/central/` are left where they are.

## 3. Engine / public contract impact

- **engine-api** (`packages/engine-api/src/host.ts` L491–492 `isCentral(): boolean`): the pinned
  engine (`engine.pin` ref `1a2218c1`, api `^1.3.0`) calls it in `engine/src/cli-catalogue.ts`
  (L37, L322, L386) and `cli-provider-models.ts`, with `refusedCentral` strings in
  `catalogue-i18n.ts`. Plan: the host keeps implementing `isCentral()` and **always returns
  `false`** (doc comment: "retained for API compatibility; always false since 2.11x"). No engine-api
  change now; `engine.pin` api range stays `^1.3.0`. In the engine repo
  (`agentistics/agentistics-engine`): one PR removing the `isCentral` checks, the `refusedCentral`
  strings and their tests (private repo, business hours OK). Removing the method from engine-api is
  a **major** (2.0) and is deferred to the next coordinated contract break — not part of this work.
- `packages/server/server/engine/load.ts`: drop the `prefs.team.mode === 'central'` read; drop
  `config.TEAM_CENTRAL`. `engine/fixtures/fake-engine.ts` L123 central branch → delete.
- **Frozen paths** (`.github/frozen-engine-paths.txt`): grep found no central code under
  `packages/runtime/**`, `integrations/**`, `provider/**`, `projections/differential*`, parity
  files. **No frozen path needs to change** → no `[ES.4]` exception needed.
- `packages/core/src/canonical/**`: no central field. `projection-client.ts` documents a 409
  "central" refusal → remove that branch (the server stops emitting it).
- Engine slot/`RESERVED_PREFIXES`: unaffected. `HostApi.caps` and `originPolicy()` stay in the
  contract; the host keeps passing its real `CAPS` and `allowedOrigins: []`.

---

## 4. Telemetry

Today: `TelemetryPayload.mode: 'solo'|'central'` (`telemetry.ts` L10, L25). The Worker
(`~/agentistics-workspace/telemetry-worker/src/index.ts` L12) **requires exactly 6 keys and a valid
`mode`** — a ping without `mode` is rejected today.

Order (must not be swapped, or every new client's ping is dropped):
1. **Worker first**: accept 5 keys (no `mode`) OR 6 keys (old clients, `mode` in
   `{solo, central}`); store `mode` as NULL when absent (D1: column nullable, or default `'solo'`). Tests for both shapes + rejects a 7th key. Deploy (outward-facing → leader/owner gate).
2. **Client**: drop `mode` from `TelemetryPayload`/`makePayload`/`sendTelemetry`, drop the
   `TEAM_CENTRAL` import; `telemetry.test.ts` asserts the exact 5-key payload. Privacy text
   unchanged (it never mentioned mode). Ship in any release after the Worker is live.

---

## 5. Ordered removal (PR-sized, each green on `tsc` + full `bun test`)

Every step: own worktree off `origin/dev`, explicit `git add` paths, `tsc` + full suite + that
step's deletion-check grep, committed locally; public pushes only after 17:00 BRT, bundled into one
release per the release flow. Order goes leaves-first (UI and clients before the server routes they
call, member side before central side) so every intermediate commit compiles and passes.

| # | Step | Content | Est. (AI h) |
|---|---|---|---|
| 0 | Telemetry Worker | accept a ping without `mode` (workspace repo) + deploy (leader/owner gate) | 0.5 |
| 1 | Telemetry client | drop `mode` (§4) | 0.5 |
| 2 | Web: member + central UI | §1.8 DEL + MODIFY list: `components/team/**`, Connections/Machines/Users/GitHub-repos settings, Login/OwnerSetup/RecoverPassword/TeamLogin, Members + Actions pages, relayed sessions + machine picker, CentralTaskBoard/TaskSharing, Tags sharing/sources UI, FiltersBar Members/Presence/Machine, `isCentral` in App/AppContext + nav (`SideNav` and `MobileBottomNav`), notification codes, `usePlanBasis` central branch, teal PWA icons; 390px check on every touched page | 9 |
| 3 | Clients | MCP `agentistics_team_*` tools + `agentToolPolicy` rows/`central` field, VS Code wording, TUI cockpit (central service row, link pill, `setupBlocked`, Logs sources, setup modes, Help/Cheat sheet, preview) | 4 |
| 4 | CLI + host | `agentop central`, `member`, `ci-push`, `setup-token`, `reset-password`, `server --central`, `start/restart/autostart central`, `setup` without modes, `cli-start.ts` host central parts, `cli-i18n.ts` strings, `service-manager`/`rebuild-flags`/`autostart` central halves, `upgrade.ts` central step, `uninstall-plan` central plan, `cli-doctor` central checks, `central-runtime.ts` | 6 |
| 5 | Member side (server) | `team-uploader`, `team-connections` (+ `/api/team/status`/`connections` routes), `team-agent-client`, `share-rules`, `team-rules`, `team-elsewhere`, `team-forget-client`, `team-migrate`, `envelope-*`, `rotate-*`, `member-*`, `machine-consent`, `sessions/machine-fleet.ts`, `team-oidc`, `vault/prefs-tokens.ts` connection-token half; core `team.ts`, `siblingRules`, `proposalApply`, `sharedTask`, `remoteSessions`, `machineFleet`, `machineActions`; `preferences.ts` team merge/guards | 6 |
| 5b | Docker path (D2) | §1.10: Dockerfile, `docker/`, `RuntimeId` docker + conflict model, `machine` autostart/unit, compose rebuild, `IN_CONTAINER`, container branches in upgrade/daemon/live-sessions/hardware; cockpit Services back to one runtime | 4 |
| 6 | Central side (server) | every `TEAM_CENTRAL` branch in `index.ts` (keep the non-central bodies unconditionally), routes §1.4, auth gate + `AUTH_PUBLIC` + `authz-gate.test.ts`, IAM/accounts/teams/org-team/bootstrap/passwords/MFA/TOTP/reset/rate-limit, step-up reduced to the vault's use, Mongo + `mongo-dates` (move the revive helper to `tags-local-store`), `tags-store`/`tags-authority` central sources, remaining `team-*`, `central-config/branding/reach`, `INGEST_ONLY`, OIDC, `TEAM_MODE` folder union, env vars §1.2, `central` inputs of `daemon-plan`/`upgrade-gate`/gates, `AGENTISTICS_EXPOSURE`/`ALLOW_LOCAL_SHELL`/`ALLOWED_ORIGINS` knobs only (D5; `exposure.ts`, `capability-guard.ts`, `host-allow.ts`, `client-ip.ts`, `TRUST_PROXY` STAY — security gates, §1.2), `audit.ts` Mongo sink, `sse.ts` branding swap | 9 |
| 7 | Contracts leftovers | core `org`, `iam`, `AppData` team caches, `SessionMeta.user`/`ci`, `redact` if orphaned, `projection-client` 409; vault `HOST_PURPOSES` + `sentences.ts`; `backup-plan.ts` central secret rows; `engine/load.ts` (`isCentral: () => false`, no prefs read) + fake engine; engine-api doc comment only | 3 |
| 8 | Packaging, docs, guard | §1.12 deletions/edits, the 84 specs handled per D4 (pending: archive copy or delete + pointer note), CLAUDE.md + AGENTS.md + README + wiki, casts re-recorded, and **`central-free.lint.test.ts`** grepping packages/scripts/docker/docs/workflows for `central`/`TEAM_CENTRAL`/`team-mode`/`/api/team/`/`agentop member` plus `IN_CONTAINER`/`AGENTISTICS_EXPOSURE`/`ALLOWED_ORIGINS`/`docker compose` (the lint must NOT flag `capability-guard`/`host-allow`/`exposure.ts`) outside a tiny allowlist (`engine-api` `isCentral` and its `caps`/`originPolicy` docs) so it cannot come back | 4 |
| 9 | Engine repo | drop `isCentral` checks + `refusedCentral` strings/tests; bump `engine.pin` ref only (api stays `^1.3.0`) | 1.5 |
| 10 | Binding (only if D6 = yes) | §1.11 bind loopback + tailnet, test pinning it, Settings → phone-access copy updated; THEN re-evaluate (separately, with the leader) whether any gate in §1.2's "stay" list can be simplified | 2 |
| | **Total** | | **≈ 47.5 h** with step 5b, + 2 h if D6 (+ QA §5.2 ≈ 3 h, one release) |

Steps 2–7 touch `index.ts`, `cli-start.ts`, `App.tsx`, `SessionsPage.tsx`; they run one after the
other, never in parallel with each other or with other work on those files.

### 5.1 Deletion-check list (run after each step; must be empty or allowlisted)

```
git grep -nI -e TEAM_CENTRAL -e AGENTISTICS_TEAM -e CENTRAL_USER -e MONGO_URL -e INGEST_ONLY \
  -e OIDC_ -e team-mode -e 48080 -e "/api/team/" -e "agentop central" -e "agentop member" \
  -e "ci-push" -e "central.sh" -e "machineFleet" -e "shareMode" -e "envelope" \
  -e IN_CONTAINER -e AGENTISTICS_EXPOSURE -e ALLOWED_ORIGINS -e "docker compose" \
  -- packages scripts docker docs .github package.json Dockerfile README.md CLAUDE.md AGENTS.md
git grep -nIi central -- packages | grep -v "engine-api/src/host.ts"
ls packages/server/server | grep -E '^(team-|envelope-|iam-|central-|member-|machine-fleet|rotate-)'
ls packages/web/src/components/team docker Dockerfile 2>/dev/null
tsc --noEmit -p . && bun test   # full suite, not the hook subset
bun run build:binary && ./release/agentop --help | grep -i -e central -e member   # must print nothing
```

### 5.2 QA script (throwaway environments only: `docker run --rm` / a scratch `$HOME`)

Independent tester on another model; experimental flag OFF, then ON; a fresh browser profile each
time. No central-install scenarios (owner decision, §2).

1. **Fresh install** (scratch HOME, release binary): `agentop` opens the cockpit with no mode
   question and one `agentistics` service; `agentop setup` asks archive + boot only;
   `agentop --help` lists no central/member/ci-push verbs; `agentop central` is an unknown command;
   web at 47292: no Members/Actions/Users/Connections/Machines/GitHub repositories, no login screen,
   every Settings tab opens, no console errors; `/api/team/*` → 404; telemetry ping to a local mock
   Worker has exactly 5 keys.
2. **Upgrade of a normal install** (v2.111 solo, scratch HOME): in-app popup upgrade; history,
   board, tags (local), vault, backups intact; no error toast.
3. **Experimental OFF/ON**: repeat 1–2 both ways; native harness surfaces unchanged.
4. **Phone 390px**: Home, Sessions, Repositories, Repo detail, Tags, Tag detail, Tasks, Settings,
   Compare — `document.documentElement.scrollWidth <= innerWidth`, the More sheet has no removed
   entry and no dead tile.
5. **Binding**: `ss -ltnp | grep -E '4729[12]'` shows the addresses from §1.11 (if D6) or exactly
   today's (if not); from another throwaway container on the docker network, `curl` to the host IP
   is refused (D6) — never test against the owner's real server.
6. **Speed**: `scripts/perf/startup.ts --budget` within budget.
7. **Binary**: `bun run build:binary` and run the compiled binary (TUI devtools stub still OK).

---

## 6. Risks

- **R1** Existing centrals break on their next upgrade attempt and stay on their old version
  (accepted by the owner, §2). Includes the owner's father and the 4 `central` machines in telemetry.
- **R2** Binding (§1.11): the app binds `0.0.0.0` today; until D6 the "never public" requirement
  rests on the machine not having a reachable IP, not on the code.
- **R3** Telemetry ordering (§4): shipping the client before the Worker drops every new ping.
- **R4** Scale: ~55k lines plus surgery on `index.ts`/`cli-start.ts`/`App.tsx`/`SessionsPage.tsx`;
  conflicts with any parallel session editing them.
- **R5** Stale binaries replacing `~/.local/bin/agentop` (known issue) would bring the central verbs
  back on this machine; verify `/api/version` after the release.
- **R6** Features users may notice disappearing: GitHub Actions ingest + Repositories→Actions tab,
  team tags (machine/team/account sources, sharing), task sharing, remote session management,
  members filter (D3).
- **R7** Engine: the host must keep `isCentral()` until the engine repo PR (step 9) lands, or the
  pinned engine fails to load.

## 7. Owner decisions

Resolved (07/10, via leader):
- **D1** Telemetry Worker stores an absent `mode` as **NULL**.
- **D2** Remove `docker/machine.yml` and the whole Docker image/launcher path (§1.10, step 5b).
- **D3** Confirmed: Actions ingest, team/machine tags, task sharing and remote session management
  die now (only the owner used them).
- **D4** (PENDING CHANGE — wait for the leader) Current: move the 84 central specs to
  `agentistics-cloud/docs/archive/central-legacy/` with the "historical self-hosted central — NOT
  the reference" README. Possible replacement: delete them, no archive copy, and add a one-page
  pointer note in `agentistics-cloud` naming the deletion commit. Step 8 does whichever is final.
- **D5** The `AGENTISTICS_EXPOSURE` knob is deleted with the central, no refusal logic; the
  security gates behind it stay (leader, §1.2).

Open:
- **D6** The normal app binds `0.0.0.0` today (§1.11), not localhost/Tailscale. To make "no code
  path can expose it publicly" true: bind `127.0.0.1` + Tailscale addresses only (recommended; a
  phone on Wi-Fi without Tailscale loses access by LAN IP), or keep `0.0.0.0` as today?

### 7.1 Final owner decisions (07/10, via the leader)
- D4 = **delete** the central specs from the public repo (no archive copy); add a one-page pointer note in agentistics-cloud (`docs/archive/central-legacy.md`) with the last commit that has them and the 3–4 documents worth mining (governance/IAM, sessions-workflows privacy, multi-central repo sharing, central session management).
- D6 = **yes**: step 10 runs (bind loopback + tailnet, pinned by a test). Security gates in §1.2's "stay" list stay until step 10 lands.
- Branch base for the steps: `origin/main` (the release flow ships work branches to main and dev).
