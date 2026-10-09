# F2/F3 integration (integ/f2-f3) — conflict resolutions

Branch `integ/f2-f3` merges the finished F2/F3 pieces on top of `integ/adapter-preview`
(63aa8e2e = release 2.113.0 + F0/F1). Every conflict was ADDITIVE: both sides kept. Engine twin:
`~/agentistics-engine` branch `integ/f2-f3`.

## 1. F2.0 + F2.0b (`feat/f2-0b-survive` 4c85ac5d, contains `feat/f2-0-structured-backend` 7f59ee32)

| File | Resolution |
|---|---|
| `packages/server/bin/cli.ts` | Both early dispatches kept, in order: `run` (integ side) then `__structured-relay` (F2.0b). |
| `packages/server/server/cli-start.ts` (`spawnManaged`) | Both locals kept: `logFile` (integ's `managedProcessLogPath`) and `offeredConversationId` (F2.0b). |
| engine `public.pin` | Placeholder — set to the public integ commit at the end of the integration (see "Pins"). |

## 2. F2.1 Gemini (`feat/f2-1-gemini` c3936a69)

| File | Resolution |
|---|---|
| `docs/f2-structured-backend.md` | Both sides kept: the F2.0 "Open items" list, then the F2.1 "what was measured" section. (The open item about gemini `storeIdOf` is answered by the F2.1 section directly below it.) |
| `packages/server/server/cli-start.ts` (`spawnManaged`) | Same two locals (`logFile`, `offeredConversationId`); only their order differed — integ's kept. |

Auto-merged but SEMANTICALLY duplicated (tsc caught it; no textual conflict):

| What | Resolution |
|---|---|
| `ResumeSessionRequest.origin` (`packages/tui/src/control/types.ts`) | F2.0b declared `origin?: 'web' \| 'terminal'`, F2.1 declared `origin?: 'web'` — duplicate identifier. F2.0b's (wider) kept. |
| `fleet-web.ts` reopen action | Both sides passed `origin: 'web'` — one kept (F2.1's, with its comment). |
| `cli-start.ts` `resumeSession` → `spawnManaged` | F2.1 forwarded `req.origin` unconditionally; F2.0b forwards it only through `structuredReopenOrigin(req.origin, previous?.structuredDriver)`. **F2.0b's rule kept** (a web reopen is structured only when the row it replaces was; a terminal-born row stays a TUI — the documented decision). F2.1's unconditional line removed. |

### Engine side (`agentistics-engine`, branch `integ/f2-f3`) — merge 2, F2.1 (`ad856714`)

| File | Resolution |
|---|---|
| `engine/src/acp/launch.ts` | Both additions kept: F2.0's `withEnvArgv` / `launchAcpWith` and F2.1's `killTree` (kill the child's whole process group; gemini relaunches its worker). |
| `engine/src/structured/acp-structured.ts` | F2.0b's transport-aware `launch` / `now` (pipe clock) kept AND F2.1's `usage` accumulator; F2.1's `acpChatFold(emit, deps.now, …)` now uses the merged `now` (so replay-time stamps stay original); the driver gets both `now` and F2.1's `replaySettleMs`. |
| `public.pin` | Set to the public integ commit (see "Pins"). |

## 3. F2.2 Kimi (`feat/f2-2-kimi` 6409c39b, already contains F2.1)

| File | Resolution |
|---|---|
| `docs/f2-structured-backend.md` | Both kept: F2.0 "Open items" then the "Kimi 2.1.1 findings" section (placed before the F2.1 Gemini section, as on the Kimi branch). No code conflict in the public tree. |

