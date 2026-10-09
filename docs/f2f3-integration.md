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

