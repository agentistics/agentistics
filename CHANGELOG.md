# Changelog

All notable changes to agentistics are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

> **Note:** Releases are published automatically on every push to `main` via GitHub Actions. This file documents the meaningful milestones. Future automation with [release-please](https://github.com/googleapis/release-please) is planned.

---

## [Unreleased]

### Added
- **Team mode** — an optional **central** aggregates computed usage metrics from many machines ("members"); it never receives chat content. Three roles: `solo` (local only), `central` (aggregator), `member` (pushes to a central). The central runs as a Docker service on port **48080** (distinct from the local dev/server port 47291)
- Member admin panel (central Settings → Team): mint a token, **rotate** a token (new credential, history preserved by migrating the member's sessions + stats to the new identity), **revoke** (confirmation modal; cascade-deletes that member's data), and rename. A member's display name is set by the central on the minted token and resolved via `/api/team/whoami` — there is no name field on the machine
- **Presence** — WebSocket-authoritative online/offline status with latency, an offline drop grace (~8s), and an http-only heartbeat fallback; an offline-data policy toggle; the central admin is notified when a machine connects
- **Auto-reconciliation** — a member self-heals its sync when the central DB is wiped (new `instanceId`), its token is rotated/re-added, or the endpoint changes, re-pushing its full history with no manual state reset. A revoked machine auto-resets itself back to solo
- **Push-on-change + real-time central** — the central owns the push interval (default 30s, 15s floor, express down to 5s; members may only go slower), plus a debounced push whenever local data changes. A member push triggers an SSE refresh so the central dashboard updates live (the "Live" toggle is hidden on a central)
- Central-only filters: members, harnesses, projects (scoped to selected members), and presence (online/offline)
- **Notifications** — auto-dismissing animated toasts plus a header bell with history and an unread badge, bilingual (pt/en) resolved at render time; fired on member connection/auth errors, "removed from central", "machine connected", and "update available"
- **Unified `agentop` cli** — `start` (re-runnable interactive control panel with **arrow-key navigation**, **English by default with a pt-BR toggle** shared with the web `lang` preference; orange banner + a two-part status separating **config** (solo / member→central / central) from **running** (`agentistics` on this machine, an `agentistics central` container, a machine container — detected live). Start `agentistics` (this machine — foreground / background / Docker) or `agentistics central` (the aggregator, Docker on :48080); connect/disconnect from a central; starting when one is already up offers to kill + restart; **Stop** lists the running services and takes down one or all; non-interactive stdin behaves like `server`. Naming: `agentistics` = the per-machine app, `agentistics central` = the aggregator — never "dashboard"), `setup` (interactive first-run wizard for solo/central/member with an autostart offer; bare `agentop` on a TTY when unconfigured launches it), `server`, `restart <server|watch|central>` (bounce a mode so it picks up new code/config), `central <up|init|down|logs|status|restart|pull>` (wraps `central.sh`), `member <connect|leave|status>` (`connect --endpoint <url> --token <tok> [--org <org>]`), `autostart <server|central|watch> <enable|disable|status>`, and `check-update`
- **Machine in Docker** — `docker-compose.machine.yml` runs a solo/member machine in a container (reuses the central image minus Mongo, mounts the host harness dirs read-only + `~/.agentistics` read-write, host networking); offered as the `docker` option in `agentop start`
- `autostart` on Linux/WSL installs a systemd **user** service, runs `loginctl enable-linger`, and adds a `~/.bashrc` hook that runs `agentop check-update` on terminal open (macOS/Windows print a manual step)
- **Update detection everywhere** — a banner on command run, the boot/terminal `.bashrc` hook, and a dashboard bell notification with a **mode-aware** upgrade modal showing the exact command (central: `bun run up:central`; member: `agentop upgrade` then `systemctl --user restart agentop-server`); a periodic 6h server re-check pushes the notice via SSE
- `central.sh` + `agentop central init` generate `central.env` interactively (openssl-generated secrets, detected Tailscale IP, `chmod 600`); `up` bakes in `--force-recreate`, `down` keeps the data volume
- **Multi-harness tracking** — alongside Claude Code, agentistics now ingests **Codex CLI**, **Gemini CLI**, and **GitHub Copilot CLI** sessions via per-harness `HarnessAdapter` modules under `packages/server/server/adapters/`
- Harness selector (shown only when >1 harness has data), generic per-harness dashboards at `/h/:harness`, and a side-by-side `/compare` page with per-harness colors and comparatives
- `HARNESS_CAPABILITIES` in `@agentistics/core` drives "N/A" rendering for metrics a harness can't produce (e.g. Codex/Gemini/Copilot have no agent metrics or git line counts), instead of a misleading 0
- "Data & sources" tab per harness (`HarnessInfoPanel`) explaining each harness's data source, what's captured, and what's missing
- Archive modes (`off` / `consolidate` / `full`) that survive Claude's 30-day transcript cleanup, gated by a first-run consent modal
- **Full mobile/responsive support** — responsive layouts gated on `useIsMobile()`, a bottom nav with a square-tile "More" sheet (hosting settings/live/refresh/warnings), a collapsible sticky filter bar, full-screen modals on mobile, and iOS-aware PWA install guidance
- **MCP multi-harness support** — `agentistics_summary` / `agentistics_projects` / `agentistics_sessions` / `agentistics_costs` accept an optional `harness` filter, plus a new `agentistics_harnesses` tool for side-by-side harness comparison
- **Session titles** — sessions now display the Claude-generated title (parsed from the transcript's `ai-title`, or legacy `summary`, line) instead of the raw first prompt; a shared `sessionLabel()` helper also strips `<local-command-caveat>`/`<command-name>` wrappers from the first-prompt fallback so untitled sessions no longer look broken

### Fixed
- **MCP cost now matches the dashboards' Costs** — the MCP's per-session cost dropped the cache-write TTL split, so 1-hour cache writes were priced at the 5-minute rate and every MCP cost read low. It now prices them like the web and TUI do (A4.4 parity: 624 of 647 sessions moved onto the dashboards' figure)
- A trailing slash on the member endpoint produced double-slash routes that broke ingest and presence
- Viewing a remote member's **Claude chat on the central** returned empty — the encoded project directory wasn't sent to the member's transcript reader, which locates the file by `<encodedDir>/<sessionId>.jsonl`
- **Transcript rendering** — huge vertical gaps between list items/paragraphs in the chat view: the message bubble mixed `white-space: pre-wrap` with react-markdown's structural newlines, so each rendered as a visible line break. Dropped pre-wrap, added `remark-breaks` (soft newlines → `<br>`, so prose line breaks survive) and compact list margins
- The **Live** tab is now hidden in the central's Settings (a central is real-time via SSE-on-ingest, so there's nothing to toggle)
- WebSocket drop is now authoritative for offline detection (killing the app marks a member offline within the drop grace, no longer waiting on heartbeat timeout)
- The install prompt no longer appears on a central, and its dismissal now persists server-side; token copy is robust over plain http
- iOS `position: sticky` broke under `overflow-x: hidden`; switched mobile `html/body/#root` to `overflow-x: clip`
- Mobile Models dropdown was clipped by the filter collapse-animation wrapper's `overflow: hidden`

### Changed
- **Projects are their repository's root everywhere** — a worktree (`<project>/.claude/worktrees/<name>` or `<project>/.worktrees/<name>`) rolls up into the project it belongs to on every surface: the projections, the web, the TUI and the MCP (`canonicalProjectPath`, see `docs/metrics.md`). The `cost-by-dimension` and `run-metrics` projections are version 2 and rebuild once from the journal
- **MCP `personTurns`** — on the projected path (`AGENTISTICS_PROJECTIONS_SURFACES=mcp`) the harness, project and repo rows report `personTurns`, the person's turns from the journal. `messages` is kept there as a **deprecated alias** of `personTurns` for this bundle only
- **Security** — the session-cookie HMAC secret (`AGENTISTICS_TEAM_SESSION_SECRET`) is kept separate from the dashboard password; tokens are stored only as sha256 hashes; Mongo is not published to the host; `BIND_IP` can restrict the central to a private tailnet (default `0.0.0.0`); auth uses constant-time comparison
- Removed the **Environment** tab from Settings
- `stats-cache.json` is treated as Claude-only; non-Claude harnesses are aggregated purely from per-session data so Claude totals are never corrupted
- README now describes agentistics as a multi-harness dashboard; `docs/mcp.md` documents the MCP's per-harness filtering and comparison tool
- The one-line installer now uses the vanity URL: `curl -fsSL https://agentop.openvibes.tech/cli | bash` (a Cloudflare redirect to the repo's `install.sh`), so the documented command survives any future move of the script
- **Ports** — `agentop server` now serves the **web dashboard on 47292** (the URL you open) and keeps the **api + mcp on 47291**; both ports share one request handler so the dashboard's same-origin `/api/*` calls just work. The startup log renames `ui` → `web` and lists it above `api`

---

## [0.4.0] — 2026-04-10

### Added
- `agentop` binary with embedded frontend — single-file distribution via `agentop server`
- CI/CD pipeline: GitHub Actions builds and publishes Linux x86_64 binary on every push to main
- One-line installer (`install.sh`)
- Terminal UI (`agentop tui`) with live metrics, streak, cost, and project breakdown
- OpenTelemetry metrics export via `agentop watch` daemon

### Fixed
- `embeddedDist` import now lazy-loaded — fresh clones can run `bun dev` without building assets first
- Chart X-axis date disorder caused by unsorted `heatmapData` after dailyActivity supplement
- Session count inconsistency between header (stale statsCache), stat card, and projects modal

### Changed
- Project renamed from `claude-stats` to `agentistics`; binary renamed to `agentop`
- Light theme overhauled with premium neutral palette

---

## [0.3.0] — 2026-03-15

### Added
- PDF export modal with per-model cost breakdown and session highlights
- Health warnings panel with auto-fix suggestions
- Git statistics per project (commits, pushes, lines added/removed, files modified)
- OpenTelemetry metrics export and watcher/daemon mode

### Fixed
- PDF: fixed cut pages, inconsistent widths, and white background in dark theme
- Sessions crash and blended cost rate in PDF export
- `HOME` hardcoded path in ProjectsModal replaced with `formatProjectName`

---

## [0.2.0] — 2026-02-20

### Added
- Activity heatmap (GitHub-style) with streak calculation
- Hour-of-day chart
- Model breakdown with per-model cost
- Projects list with session/message/tool counts
- Recent sessions panel
- Highlights board (records and personal bests)
- Dark/light theme toggle
- PT/EN language toggle
- Live updates via SSE with configurable interval
- Date range filters (7d, 30d, 90d, All) and custom date picker
- Multi-project filter with search modal
- BRL cost conversion via live exchange rate

### Fixed
- Streak counts backward from today; starts from yesterday if today has no activity

---

## [0.1.0] — 2026-01-06

### Added
- Initial dashboard: tokens, cost, sessions, messages, tool calls
- Reads `~/.claude/projects/**/*.jsonl` and `~/.claude/stats-cache.json`
- Bun + React 19 + Vite + Recharts stack
- Session metadata enrichment from `~/.claude/usage-data/session-meta/`
