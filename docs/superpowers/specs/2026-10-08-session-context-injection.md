# Session context injection (QUAL.8)

Status: implemented on this branch for the spawn paths; chat-UI collapse and Phase 2 pending.

A harness started by agentistics should know where it runs. The context is delivered **at spawn**, through
each CLI's official channel, and never depends on hooks.

## 1. The text (one file: `packages/server/server/sessions/agentistics-context.ts`, `CONTEXT_STRINGS`)

Language follows the app language. The task paragraph is included only for sessions created from an Agentask task.

### PT
```
Você está rodando dentro do agentistics (sessão <id>), um painel que gerencia e mede sessões de assistentes de código.
[com tarefa] Esta sessão foi criada a partir da tarefa <taskId> — "<título>" do Agentask.
[com tarefa] Registre seu progresso nela com as ferramentas MCP do agentistics (agentistics_task_comment para comentar, agentistics_task_status para mudar o status).
Segredos (chaves, tokens) vêm do cofre: use referências vault://nome. Nunca peça ao usuário para colar uma chave no chat.
Para perguntar algo ao usuário, escreva a pergunta direto na conversa e espere a resposta; ele a vê no painel do agentistics.
Nunca suba servidores nas portas 47291 e 47292: são do próprio agentistics.
```

### EN
```
You are running inside agentistics (session <id>), a dashboard that manages and measures coding-assistant sessions.
[with task] This session was created from Agentask task <taskId> — "<title>".
[with task] File your progress there with the agentistics MCP tools (agentistics_task_comment to comment, agentistics_task_status to change status).
Secrets (keys, tokens) come from the vault: use vault://name references. Never ask the user to paste a key into the chat.
To ask the user something, write the question in the conversation and wait for the reply; they see it in the agentistics panel.
Never start servers on ports 47291 and 47292: they belong to agentistics itself.
```
Max 6 lines. Harness-neutral: no sentence names a tool only one CLI has.

## 2. Delivery channel per harness (verified 2026-10-07 on this machine)

| Harness (version) | Channel | Evidence | Status |
|---|---|---|---|
| claude 2.1.293 | `--append-system-prompt <prompt>` | `claude --help`: "Append a system prompt to the default system prompt" | **Proven live**: a session spawned through the server answered with its session id |
| codex 0.160.1 | `-c developer_instructions="<toml string>"` | `codex --help`: "`-c, --config <key=value>` Override a configuration value…"; `developer_instructions` is a key in the binary's config schema (adds a developer message, does not replace the base prompt) | Flag accepted; **live answer not observed** (codex auth returns 401 here). Owed. |
| copilot 1.0.92 | env `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>` with `AGENTS.md` in it | `copilot help environment`: "comma-separated list of additional directories to search for custom instructions files"; `copilot instruction list --json` gains a `nested-agents` source only with the variable set | Discovery proven; **model answer not observed** (monthly quota exhausted). Owed. |
| gemini 0.63.0 | **none usable** — `GEMINI_SYSTEM_MD` fully *replaces* the core prompt (docs/cli/system-prompt.md: "a full replacement, not a merge") | docs shipped with the CLI | Fallback: first message |
| agy 1.3.1 | none (`agy --help` has no system-prompt/instructions flag) | `agy --help` | Fallback: first message (`--prompt-interactive`) |
| kimi 0.41.0 | none verified. `--agent-file <path>` loads an agent definition, but its semantics (replace vs append) were not verified, and it cannot combine with `--session` | `kimi --help` | Fallback: first message (typed in). `--agent-file` is a candidate for a later verification. |
| opencode 1.17.9 | not spawnable by the session manager (`SPAWN_SPECS.opencode = null`) | — | out of scope |

Fallback = the same text, fenced by `<agentistics-context>…</agentistics-context>`, prepended to the first user
message. If a fallback harness is started **without** a prompt, nothing is sent (we do not invent a turn).
A **resumed** conversation never receives the context (it already has its history).

## 3. Where it happens

- `sessions/agentistics-context.ts` — pure: text (PT/EN), `contextBlock`, `splitContextBlock`.
- `sessions/spawn-spec.ts` — `SpawnSpec.context` (`args` | `env-dir`; absent = fallback); `planSpawn` takes
  `req.context` and returns `argv`, `env`, `contextFile`, `contextVia`.
- `sessions/spawn-context.ts` — IO: builds the context for a session id, writes the copilot `AGENTS.md` under
  `<data dir>/session-context/<id>/` (0600, best effort: a failed write costs orientation, never the start).
- `sessions/backend-tmux.ts` — `BackendSpawn.env` merged into the pane env.
- Call sites: `cli-start.ts spawnManaged` (web wizard, cockpit, VS Code, Nay) and `sessions/cli-session.ts`
  (`start`, `batch`). The session id is now minted **before** `planSpawn`.
- Known gaps: CLI `start`/`batch` pass no task (the task id is resolved after planning there); subtask id/title is
  not yet in the text; `spawnManaged` passes `taskId` + the task name it already receives.

## 4. QA script

Per harness, open one session from the UI (new session wizard, any folder, with Agentask task for one run) and ask
**"onde você está e qual a sua tarefa?"**. Expected: the answer mentions agentistics and, for a task session, the
task. Check also: (a) the raw argv in `ps` carries the flag (claude/codex), (b) copilot's
`$data/session-context/<id>/AGENTS.md` exists, (c) fallback harnesses show the fenced block as the first user
message, (d) a reopened session does not get it again. Unit coverage: `agentistics-context.test.ts`.

## 5. Pending

- Chat UI: render a leading `<agentistics-context>` block collapsed as "contexto do agentistics"
  (`splitContextBlock` is ready).
- Phase 2: managed blocks in global instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`, …) for sessions opened outside agentistics — explicit, idempotent, exactly reversible,
  like `agentop hooks install`.
