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

