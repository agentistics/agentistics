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

## 4. F3.2 Antigravity (`feat/f3-2-agy` 42da84e3)

| File | Resolution |
|---|---|
| `docs/f2-structured-backend.md` | Both kept (Kimi + Gemini sections, then the F3.2 section). The harness table's Antigravity row auto-merged from F3.2. |
| `packages/server/server/cli-start.ts` | Same two locals in the other order again — integ's kept. |
| `packages/server/server/index.ts` | Both MCP boot registrations kept: Kimi (`ensureKimiMcp`) then Agy (`ensureAgyMcp`). |

**Owner decision applied (leader, 09/10): agy web sessions run as TUI + adapter by default.** The agy structured
driver stays BUILT and ready in the engine, but `STRUCTURED_ROUTE_OFF` (`sessions/structured-route.ts`, one line:
`antigravity: '<reason>'`) takes it out of the routing. Reason: agy's `stream-json` states no permission request
(print mode soft-denies a tool), so a structured agy session could never ask the person while the TUI can. To turn the
driver on, delete the entry. Pinned by a test in `structured-backend.test.ts`.

### Engine side — merge 4, F3.2 (`9e4e14fa`)

| File | Resolution |
|---|---|
| `engine/src/structured/stubs.ts` | Header comment only: F3.2's "agy is WRITTEN, no longer a stub" kept, F2.0b's transport/determinism paragraph kept. |
| `public.pin` | Public integ commit (see "Pins"). |

**Known limitation, accepted because the route is off:** `agy-structured.ts` starts its child through `deps.launch`
directly, NOT through `req.transport`, and stamps turns with its own clock — it does not follow the F2.0b driver rule
(relay + deterministic replay), and it relaunches the child after a cancel, which the single-pipe replay model does not
cover. A structured agy session would therefore NOT survive an `agentop server` restart. Nothing routes to it while
`STRUCTURED_ROUTE_OFF.antigravity` is set; moving it onto the transport is a prerequisite for deleting that entry.

## 5. F3.3 Claude Code (`feat/f3-3-claude` 550b75ab)

| File | Resolution |
|---|---|
| `docs/f2-structured-backend.md` | Harness table: Agy row from F3.2 (ready) AND Claude row from F3.3 (ready) — each branch had the other's row still as a stub. F3.3's open-item bullet kept in place. |
| `packages/server/server/sessions/control-session.test.ts` | Both describes kept (F2.1 `dialogStated`, F3.3 `freeText`) — they sat at the same spot in the file. |

Shared host changes F3.3 brings (additive, all drivers): `structuredSpawnOf` sets `AGENTOP_MANAGED_ID` on every
structured child (so the Agy driver's own addition is now redundant but harmless), `StructuredProvider.prepare`,
`DialogOption.freeText` to the row/fleet-hub, `promptSession` refuses a prompt while a request is open, P-07 restored
in the chat-tail reader, `acp/launch.ts` ends children on host exit.

### Engine side — merge 5, F3.3 (`7a91dc41`)

| File | Resolution |
|---|---|
| `engine/src/acp/launch.ts` | Both kept: F2.1's child-as-own-process-group (`detached`, `killTree`) and F3.3's "end live children on the host's exit". **Semantic fix on top**: the exit hook now signals the GROUP (`process.kill(-pid)`) for a detached child — signalling only the launcher's pid would have recreated the gemini worker leak F2.1 fixed. |
| `engine/src/acp/launch.test.ts` | Both files had a test of this name (add/add). F2.1's kept under the name; F3.3's moved to `launch-exit.test.ts`. |
| `engine/src/structured/engine-structured.ts` | Both deps fields (`agyHistory`, `claude`) and both driver registrations. |
| `engine/src/structured/acp-structured.test.ts` | Registry test updated for the union: claude ready (F3.3), antigravity ready (F3.2), codex still a stub. |
| `public.pin` | Public integ commit (see "Pins"). |

Also (no textual conflict, stale assertion): `agy-structured.test.ts` asserted `driverFor('claude')` is null "F3.3 still a stub" — true on the F3.2 branch alone, false after F3.3. Updated to `claude-stream-json`.

## 6. `fix/adapter-smallfixes` (fb96a1e4: KILL.ESCALATE, WATCH.LATEDIR, LINK.VIA, AVAILABILITY)

| File | Resolution |
|---|---|
| `sessions/harness-available.ts` | AVAILABILITY's 15 s TTL memo (`availableHarnesses(now)`) AND integ's `adoptUserBinOnPath()` + `userSearchPath()` — the adoption now runs on each refresh, not once per process. |
| `sessions/harness-available.test.ts` | Auto-merged with duplicated imports (removed). The TTL test now isolates `HOME` (like its sibling test): with `~/.local/bin` adopted onto PATH, a real home holding `agy` made `['claude']` read `['claude','antigravity']`. |

## 7. `fix/terminal-button` (afbcdde5) — the "Open in terminal" button (F2.0b's `terminal` action)

| File | Resolution |
|---|---|
| `sessions/sessions-host.ts` | Both blocks kept: smallfixes' `exactLinksOnDisk` (exact-link reopen candidates) and terminal-button's `structured` set fed to `buildSessionViews`. |
| `sessions/fleet-row.test.ts` | Both describes kept (`conversationLinkVia`, "open in terminal"). |

## 8. F3.1 Codex (`feat/f3-1-codex` 8988243f)

| File | Resolution |
|---|---|
| `docs/f2-structured-backend.md` | Harness table: Codex row from F3.1 (ready); Agy and Claude rows from integ (each branch had the others as stubs). F3.1's evidence page `docs/f3-1-codex.md` comes along. |
| `sessions/cli-start.ts` (`promptSession`) | F3.3's "refuse a prompt while a structured session states an open request" kept FIRST (it covers every session with a stated request); F3.1's "send a structured session's prompt through its driver, never the TUI paste" kept after it (its own duplicate refusal removed — the first check already ran). |
| `sessions/fleet-web.ts` | `origin: 'web'` on the reopen — present on integ (F2.1) and on the Codex branch; one copy (the commented one) kept. |
| `sessions/session-view.ts` (`claimResume`) | integ's `reopenTargetFor` (the shared reopen resolver, exact link + on-disk check) kept as the rule; F3.1's shortcut — a PROTOCOL-STATED id (Codex thread id) reopens straight from the link before the file/metrics cache has the rollout — put in front of it, using `findConversation` (uuid-alias aware) instead of a bare `sessionId` match. |
| `sessions/session-view.test.ts` | Both tests kept (gemini alias describe, Codex protocol-stated reopen). |

### Engine side — merge 8, F3.1 Codex (`1b0c4c16`)

| File | Resolution |
|---|---|
| `engine/src/structured/engine-structured.ts` | Registry = acp, claude (F3.3), the stub list with `codex-app-server` replaced by its real driver (F3.1), agy (F3.2). After this merge `structuredStubs()` holds no driver that is still a stub. |
| `engine/src/structured/acp-structured.test.ts` | Registry test: four ready drivers (acp, claude, codex, agy); opencode none. |
| `public.pin` | Public integ commit. |

Also (engine, no textual conflict): `reuse-surface.lint.test.ts` "the engine reads no environment" failed on
`structured/fixtures/codex-app-server-peer.ts` (F3.1's fake peer reads a QA log path from the environment). The lint now
treats `/fixtures/` as test material, like `*.test.ts` and `test/`.

## Pins

- `engine.pin` (public): ref = engine `integ/f2-f3` commit `3a0a7e9c37d7f1518ff4e7e76a797620f7558522`, `api` stays `^1.9.0`. The engine's `BUILT_AGAINST_API` is
  still `'1.9.0'` on purpose: the 1.10 surface (`Engine.structured`, `StructuredSpawn.transport`, `usage`) is OPTIONAL and the
  host reads `engine.structured` directly (no version gate), so a 1.10-aware engine still declares what it was built
  against — the range `^1.9.0` is satisfied and a 1.9 host would simply never ask. No bump needed; if the engine is
  ever made to REQUIRE 1.10 from the host, raise both.
- `public.pin` (engine): the public commit `51cd26de4182d131b3abffea08a109a5a01209a8` it was built and tested against. The public commit that adds `engine.pin` differs
  from it by this pin file only (the two pins are circular; this is the fixed point).

