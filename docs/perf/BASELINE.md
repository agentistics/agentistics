# PERF.1 baseline

**Measured 2026-10-03, at `origin/main` 1273faa9 (v2.101.1).** Machine: 12 CPUs, 12 GB RAM, WSL2. Swap was at
8.08 of 8 GB during the run (the machine's own condition, see "Machine" below).

## How it is measured

```sh
bun scripts/perf/synth-home.ts /tmp/agentistics-perf/synth        # a synthetic home (no real data)
bun scripts/perf/baseline.ts /tmp/agentistics-perf/synth --boots 4 --json out.json
```

- `baseline.ts` runs a THROWAWAY server (`server-harness.ts`) on free ports, with its own `$HOME` and
  an isolated tmux. It refuses the real `$HOME` and never talks to the running server.
- **The synthetic home** (`synth-home.ts`) is calibrated on this machine's transcript METADATA only
  (counts and sizes, never content): 480 main Claude transcripts, 1.83 GB, size p50 1.9 MB, p90 7.9 MB,
  max 70 MB. The real home has 483 transcripts, 1.8 GB, p50 1.9 MB, p90 8.3 MB, max 71 MB.
- **Live CLI sessions** use `fake-claude.ts`, a stand-in `claude` in the isolated tmux.
  - It writes the user turn as soon as a line reaches its terminal, prints the answer word by word over
    1.5 s, then writes the assistant turn.
  - Every turn carries the epoch ms when it was written.
  - The web's chat reading is replayed exactly: one read right after the send, then every 3 s.
- **`copy-data.sh`** builds a copy of a real home with the secrets left out, for whoever may run the
  baseline over real data. This baseline did not use it: copying the machine's chat data was not
  authorised.

## Numbers (synthetic home)

| what | p50 | p95 | note |
|---|---|---|---|
| boot → listening | 0.83 s | 0.87 s | |
| boot → `/api/health` | 1.0 s | 1.1 s | |
| first `/api/data`, FRESH machine (no cache.db) | **8.5–11 s** | | 13.9 MB of JSON |
| first `/api/data`, restart (cache.db present) | 0.92 s | 1.05 s | |
| `/api/data` warm | 67 ms | 93 ms | the 13.9 MB is re-serialised on every request |
| open a historic session, 1.9 MB transcript | 6 ms | 7 ms | `/api/claude-sessions/:id`, 0.2 MB response |
| open a historic session, 7.9 MB | 20 ms | 22 ms | 1 MB response |
| open a historic session, 70 MB | 173 ms | 232 ms | **9 MB response, every message, no cap** |
| open a live session (first `/api/fleet/chat`), 70 MB history | 49 ms | | last 400 turns |
| send → echo confirmed by the server | 316 ms | 335 ms | the web draws an optimistic echo at ~0 ms |
| harness writes the answer → the chat shows it | **1.63 s** | 1.65 s | the 3 s poll; up to 3 s, plus the read |
| in-flight assistant text | ≤ 0.5 s | | terminal scrape: `capture-pane` every 500 ms |
| one `/api/fleet/chat` read, 70 MB transcript | 65 ms | 87 ms | whole file read and split per request |
| transcript append → `/api/events` `change` | **2.0 s** | 2.0 s | a fixed 2 s debounce; then every client refetches all of `/api/data` |
| server RSS after the run (~4 min) | **876 MB** | | 438 MB in an earlier, shorter run |

## Numbers (this machine, real data: read off the service's own log, never touched)

| what | value |
|---|---|
| boot → listening | 0.65–0.71 s |
| first `/api/data` built, 12:56 restart | **30.0 s** |
| first `/api/data` built, 17:12 restart | **77.5 s** |
| `agentop server` RSS after 3 h 43 min | **600 MB** |
| the owner's TUI (`agentop`) RSS after 6 h 58 min | **1.3 GB** |

**The real first `/api/data` is 30–80× the synthetic restart (~1 s).** The synthetic home has none of
these:
- real git repositories behind each cwd (`resolveProjectFacts`);
- the 713 subagent transcripts (1.3 GB);
- copilot (1.1 GB), gemini (270 MB) and codex (145 MB);
- a machine already swapping (8 of 8 GB).

The build now logs ONE line per build, with no data:

```
[data] built in 1570 ms: read 152, projects 1395 (slowest), consolidate 8, gemini 6, antigravity 5, finalize 3
```

The service's next restart says which phase owns the real 30–80 s.

## Machine

When measured:
- the owner's TUI: 1.3 GB RSS;
- the server: 600 MB;
- five `claude` CLIs: 340–480 MB each;
- one test TUI and its server: 650 MB;
- two orphaned `bun … cli.ts mcp`: 88 MB each, 25 min old.

Swap was 8.08 of 8 GB. Every number on the real machine includes paging.

## After PERF.1 (same synthetic home, same scripts)

| what | before | after | commit |
|---|---|---|---|
| harness writes the answer → chat shows it (70 MB session) | 1631 ms | 74–86 ms | 0bbb0d23 (chat pushed over SSE) |
| same, 8 MB session, p95 | 5192 ms | 54 ms | 0bbb0d23 |
| in-flight answer on screen, p50 | 304–351 ms | 196–216 ms | 983d71d4 (capture follows a changing screen) |
| chat requests while the stream is healthy | 1 fleet walk + whole transcript every 3 s | none | 0bbb0d23 |
| first render of a 400-turn chat (React work) | 165 ms | 34 ms | c277d877 (end first, older on scroll) |
| list a project's sessions (40 projects, warm) | 1179 ms | 20 ms | 9513b558 (parse once, then new lines) |
| open a 70 MB history | 173 ms, 9 MB | 13 ms; paged ~1 ms, 40 KB | 9513b558 |
| transcript append → `change` | 2006 ms, then a STALE refetch | 601 ms, refetch holds the new data | be34ff3d |
| `/api/data` warm | 67 ms | 24 ms | be34ff3d (serialised once per build) |
| server RSS, 12-min soak | — | 280–600 MB, no upward trend | 7e40ba64 (`[mem]` sampler, soak.ts) |

**Budgets in CI** (`scripts/perf/budget.ts`, `budgets.json`, job `perf-budgets`): boot, first and warm
`/api/data`, a paged history open and its size, a change reaching the dashboards, and a live chat (open,
send → echo, answer → shown). They run over a synthetic home at `--scale 0.1`.

**The ENGINE.MAP bench in CI** (F0.4, `scripts/perf/engine-map/`, job `engine-map-bench`): a mixed fleet of fake claude/codex/gemini/copilot/kimi/agy sessions on a throwaway server; its tables are a job summary and the `engine-map-bench` artifact, and the 09 §8 ceilings in `budgets.json` → `engineMap` are failures since F4.B (10 % noise tolerance; a value inside it is a warning). See `scripts/perf/engine-map/README.md`.

**Still open:** the real machine's first `/api/data` (30–78 s) against ~1 s synthetic. The `[data]` phase
line (32c57900) names its slow phase on the service's next restart.
