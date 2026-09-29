# Harness model catalog: ask the CLI, fall back to the table

**Status:** approved 2026-09-29 (the leader session approved option 1 on the owner's behalf)

## The defect

The model pickers in the product were missing models the user's own CLI offers. For example,
Opus 5.5 was listed nowhere, although Claude Code runs it by default on this machine. The cause
is **three hand-written lists that have drifted apart**:

| List | Read by | State on 2026-09-29 |
|---|---|---|
| `web/src/lib/chatModels.ts` + `server/chat-tty.ts` `CHAT_MODELS` | the Nay chat, Settings → Chat | Haiku 4.5 / Sonnet 4.6 / Opus 4.7, months stale |
| `chat-drivers/{codex,gemini,copilot}.ts` `*_MODELS` | Nay's harness selector | guesses (`gemini-3-pro-preview`, `gpt-5.2-codex`) |
| `core/harnessModels.ts` `HARNESS_MODELS` | the new-session wizard, a session's model switch | verified on 2026-09-04: claude as 4 aliases labelled `Opus 5`; codex/gemini/kimi empty; agy has since dropped the 3.5 family |

A table that someone verifies by hand goes stale within weeks. The CLIs already know the set the
signed-in account can use.

## The decision

**Ask each CLI where it publishes a list. Keep the verified table, plus a free-text id, where it
does not.** One server-side catalog answers every surface: the wizard, the session's model switch,
Nay's harness picker and Settings → Chat. `chatModels.ts` and the server's `CHAT_MODELS` are
deleted.

### Where each harness's list comes from (measured 2026-09-29 on this machine)

| Harness | Source | Shape |
|---|---|---|
| claude (2.1.284) | `~/.claude/cache/model-catalog/*.json`: Claude Code's own cache of the account's model catalog | `catalog.config.models[]` = `{id, name, section: 'main'\|'overflow'}`. Several files may exist; the one with the newest `fetchedAt` wins. `main` is listed before `overflow`. |
| codex (0.153) | `~/.codex/models_cache.json` | `models[]` = `{slug, display_name, visibility}`. Only `visibility === 'list'` is offered, because `hide` rows are internal (`codex-auto-review`, `gpt-reserve`). |
| antigravity (1.2.6) | `agy models` | `<id>\t<display name>` per line, after a `Fetching available models...` banner |
| opencode (1.17) | `opencode models` | one `provider/model` id per line, with no display name |
| kimi (0.41) | `~/.kimi-code/config.toml` | the `[models."<alias>"]` table headers. `-m` takes the user's own alias. |
| copilot (1.0.85), gemini (0.58) | none. `--model` with a bad value only says it is unavailable, and prints no list. | the verified table + free text |

### Rules

- **An undocumented cache is read defensively.** Any file that is missing, unparseable or empty,
  or that has an unexpected shape, yields *no answer*, never a throw. The caller then falls back
  to the table. A catalog is only ever a better list, never a precondition.
- **A command is never on a hot path.** `agy models` goes to the network (the banner says so). The
  catalog is stale-while-revalidate: a request answers at once with the last good list, or with the
  table on a cold start, and refreshes in the background. The TTL is 6 h for commands and 60 s for
  file reads. Commands time out after 15 s, and a refresh already in flight is shared.
  `/api/fleet/new` is opened on every wizard step, and it may not wait on a CLI.
- **The wire says where a list came from.** `modelsSource: 'cli' | 'table'` and `modelFreeText:
  boolean` (true exactly when the source is the table). The table exists precisely because the list
  is incomplete there, so a closed picker would forbid ids the CLI accepts.
- **A discovered model carries provenance** like every other `ModelOption`: `verifiedAt` is the day
  it was read and `source` names the file or command.
- **The id is sent and the label is read**, unchanged (`harnessModels.ts`). A discovered claude id
  is a full id (`claude-opus-5-5`), which both `--model` and `/model` accept.
- **`HARNESS_MODELS` stays**, as the fallback, and is still pinned equal to
  `spawn-spec.ts`'s `modelSuggestions`. The catalog does not rewrite the spawn spec. It is what the
  surfaces OFFER.

## Out of scope

- Missing Nay drivers (kimi, opencode). Nay has no driver for them at all, which is a separate
  defect, tracked with the Nay revival spec.
- The rest of the Nay revival: the `--budget-tokens` flag, the MCP allow-list, the layering. That
  gets its own spec.
