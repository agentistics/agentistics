# Changelog

All notable changes to agentistics are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

> **Note:** Releases are published automatically on every push to `main` via GitHub Actions. This file documents the meaningful milestones. Future automation with [release-please](https://github.com/googleapis/release-please) is planned.

---

## [Unreleased]

### Added
- `autostart` on Linux/WSL installs a systemd **user** service, runs `loginctl enable-linger`, and adds a `~/.bashrc` hook that runs `agentop check-update` on terminal open (macOS/Windows print a manual step)
- **Multi-harness tracking** — alongside Claude Code, agentistics now ingests **Codex CLI**, **Gemini CLI**, and **GitHub Copilot CLI** sessions via per-harness `HarnessAdapter` modules under `packages/server/server/adapters/`
- Harness selector (shown only when >1 harness has data), generic per-harness dashboards at `/h/:harness`, and a side-by-side `/compare` page with per-harness colors and comparatives
- `HARNESS_CAPABILITIES` in `@agentistics/core` drives "N/A" rendering for metrics a harness can't produce (e.g. Codex/Gemini/Copilot have no agent metrics or git line counts), instead of a misleading 0
- "Data & sources" tab per harness (`HarnessInfoPanel`) explaining each harness's data source, what's captured, and what's missing
- Archive modes (`off` / `consolidate` / `full`) that survive Claude's 30-day transcript cleanup, gated by a first-run consent modal
- **Full mobile/responsive support** — responsive layouts gated on `useIsMobile()`, a bottom nav with a square-tile "More" sheet (hosting settings/live/refresh/warnings), a collapsible sticky filter bar, full-screen modals on mobile, and iOS-aware PWA install guidance
- **MCP multi-harness support** — `agentistics_summary` / `agentistics_projects` / `agentistics_sessions` / `agentistics_costs` accept an optional `harness` filter, plus a new `agentistics_harnesses` tool for side-by-side harness comparison
- **Session titles** — sessions now display the Claude-generated title (parsed from the transcript's `ai-title`, or legacy `summary`, line) instead of the raw first prompt; a shared `sessionLabel()` helper also strips `<local-command-caveat>`/`<command-name>` wrappers from the first-prompt fallback so untitled sessions no longer look broken

### Fixed
- **A day range no longer prices a session's lifetime cache writes** — cutting a session to a range (Today, 7d, a custom range) replaced its four token counters but kept its lifetime 1h/5m cache-write split and per-model breakdown, and the cost formula prices the split when one is present: a long Claude session's "Today" carried every cache write it had ever made. Both are now scaled to the cut (`cutSessionUsage`)
- **VS Code "Today" is the spend incurred today, by event time** — the same rule as Costs (each session's own per-day usage), said in the status bar's tooltip. A session open since yesterday no longer hides tonight's spend under yesterday, nor carries yesterday's into today
- **MCP cost now matches the dashboards' Costs** — the MCP's per-session cost dropped the cache-write TTL split, so 1-hour cache writes were priced at the 5-minute rate and every MCP cost read low. It now prices them like the web and TUI do (A4.4 parity: 624 of 647 sessions moved onto the dashboards' figure)
- A trailing slash on the member endpoint produced double-slash routes that broke ingest and presence
- **Transcript rendering** — huge vertical gaps between list items/paragraphs in the chat view: the message bubble mixed `white-space: pre-wrap` with react-markdown's structural newlines, so each rendered as a visible line break. Dropped pre-wrap, added `remark-breaks` (soft newlines → `<br>`, so prose line breaks survive) and compact list margins
- WebSocket drop is now authoritative for offline detection (killing the app marks a member offline within the drop grace, no longer waiting on heartbeat timeout)
- iOS `position: sticky` broke under `overflow-x: hidden`; switched mobile `html/body/#root` to `overflow-x: clip`
- Mobile Models dropdown was clipped by the filter collapse-animation wrapper's `overflow: hidden`

### Changed
- **The journal and the projections are ON by default** — `AGENTISTICS_JOURNAL` and `AGENTISTICS_PROJECTIONS` no longer need setting; `=0` (or `false`/`off`/`no`) turns either off. The server runs the journal's **first import by itself**: in the background a couple of minutes after it is up (never on the startup path), as a low-priority child (`nice`/`ionice`, small batches, one replay at a time), pausing while the memory gate refuses, resumable and idempotent. `agentop journal status` and one line in the web show its progress; until it completes, every surface reads `/api/data`. `AGENTISTICS_JOURNAL_BACKFILL=0` turns the automatic import off (`agentop journal import` still runs it by hand)
- **The projections are the default on every surface** — the MCP, the TUI, the web and VS Code read their session, cost and tool figures from the journal's projections (`/api/runtime/metrics`) wherever the server serves them, and read `/api/data` by themselves where it does not. `AGENTISTICS_PROJECTIONS_SURFACES=legacy` puts every surface back on `/api/data`: a **fallback flag kept for this bundle only**. Bring the journal up to date first with `agentop journal import` (resumable, `--dry-run` first)
- **Cost can read ~0.5% differently** — each response is now priced on its own model, where a session used to be priced whole on one
- **Projects are their repository's root everywhere** — a worktree (`<project>/.claude/worktrees/<name>` or `<project>/.worktrees/<name>`) rolls up into the project it belongs to on every surface: the projections, the web, the TUI and the MCP (`canonicalProjectPath`, see `docs/metrics.md`). The `cost-by-dimension` and `run-metrics` projections are version 2 and rebuild once from the journal
- **MCP `personTurns`** — on the projected path (`AGENTISTICS_PROJECTIONS_SURFACES=mcp`) the harness, project and repo rows report `personTurns`, the person's turns from the journal. `messages` is kept there as a **deprecated alias** of `personTurns` for this bundle only
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
