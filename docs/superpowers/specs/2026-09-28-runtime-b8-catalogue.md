# B8 (draft number) — The native harness catalogue: commands, skills, agent profiles, MCP servers, permission profiles, after-edit steps

**Status: DRAFT for the leader's review. Not filed. No item exists on the board for anything here.**
Written 2026-09-28 by the harness research session (Opus 5.5), after the owner approved the feature
matrix (`2026-09-28-harness-feature-matrix.md`) and asked for the spec to be written WITH the leader
(7b1095709e). The leader's answers of 2026-09-28 are folded in and marked:

- **[OWNER]** a decision already on record;
- **[LEADER]** the leader's judgement, not yet taken to the owner;
- **[OWNER PENDING]** product decisions this spec proposes but may not take.

**The name "B8" is a draft.** The leader reconciles the numbering and creates the items, the way A3,
A4, A5, B5a and B5b were born (the writing session proposes, the leader files) [LEADER].

**Placement: post-M1** [LEADER]. The agreed order is:

1. finish B4, UI.2, UI.3 and UI.6;
2. release and upgrade;
3. the owner tests a native session through the interface;
4. only then new work such as this.

**The one exception, proposed to the owner:** a LEAN system prompt ("H1-lean", §10), which depends on
nothing in the catalogue. Question 1 in §12 carries it; the leader takes it to the owner.

---

## 0. What this spec is and is not

**It is:**

- ONE model for everything a person or a repository can add to the native harness;
- the loader that reads those additions;
- the trust rule that keeps a cloned repository from configuring the agent that reads it;
- the way each kind of addition is used at run time.

**It is not:**

- **The visual design.** UI.6 (c44ad82236, live with the owner) owns which commands appear, the
  keys, and how anything looks. This spec gives UI.6's list a place to plug in and decides nothing
  about pixels.
- **The MCP connection.** B6.3 stays the verb that connects to a server. B8 is where a server is
  DECLARED. **B8 extends B6.3; it does not replace or duplicate it** [LEADER].
- **The ALM tools.** B6.5 stays the board tools inside the conversation. No overlap [LEADER].
- **Terminal-as-client.** That is the B4 spec's registered limit (`2026-09-27-runtime-b4-sessions.md`
  §8: "a hub lives in the process holding the lease … that is UI round 2 / the server hosting CLI
  sessions"). B8 only points at it (§11, item B8.x-H9) and decides nothing new [LEADER].
- **Plugins that run code.** D9 stands [OWNER]: the contract now, the loader on demand, and never
  code executed in-process.
- **A marketplace of our own**, with a backend and third-party submissions. That is a later,
  probably Enterprise, conversation [LEADER]. This spec defines only the FORMAT and the LOADER, so
  that anything installed later has somewhere to land (§7).

---

## 1. The problem, measured against today's code

Everything below was read at `origin/feat/runtime-sessions` (7d77e812) and `origin/dev`.

| What a person would add | Where it lives today for the NATIVE harness | What exists in the product for EXTERNAL harnesses |
|---|---|---|
| a command | nowhere: `cli-code.ts` special-cases `/exit` | — |
| a skill | nowhere | `sessions/skill-source.ts` + `harness-skills.ts`: LISTS Claude's skills, read-only |
| an agent profile | nowhere; B6.1 does not say whether `agent.spawn` takes one | — |
| an MCP server | nowhere; B6.3 does not say where servers are declared | `mcp-config.ts` / `mcp-admin.ts` (Claude's three scopes, written only through Claude's own CLI), `mcp-check.ts` (the `initialize` probe), `mcp-tools.ts` (`tools/list`) |
| a permission rule | the MODEL exists (`policy/rules.ts`: machine → user → project layers, deny absolute), but `runtime-host.ts:121` passes `layers: []` | — |
| a hook | internal code seams only (`onToolCall`, `onHistory`, retry hooks) | `cli-hooks.ts` installs agentop's own hooks INTO Claude Code |
| a plugin | nothing, by decision (D9) | — |

So the product already knows how to READ and WRITE other harnesses' extensions, and the native
harness has no place for its own. B8 builds that place.

---

## 2. Decisions this spec takes, and those it leaves open

| # | Decision | Status |
|---|---|---|
| C1 | **One catalogue for all kinds**: one entry shape, one loader, one precedence rule, one trust rule | proposed by this spec, endorsed [LEADER] |
| C2 | **A project-scope entry is UNTRUSTED INPUT.** It never runs by itself and never widens a permission | [LEADER], from B3-SEC |
| C3 | **No free shell hook.** Veto is policy; observation is the journal/event stream; the one new mechanism, "after an edit", is a tool call judged by the SAME policy (floor + ask) | [LEADER], from B3-SEC F1–F4 |
| C4 | **Hooks do not copy Claude Code's shape** (arbitrary shell with full trust) | [LEADER] |
| C5 | **A plugin never runs in-process.** An install is a copy into user scope with a verified hash | [OWNER] D9 |
| C6 | **Compatibility reads** of `~/.claude/skills` and `~/.agents/skills` are OPT-IN, never the default | [LEADER]; also the "precedent, never a dependency" rule |
| C7 | **The formats and the pure planning live in `packages/runtime`; every file read lives in the host** | follows D23 [OWNER] |
| C8 | **Where installable things come from** (a marketplace, a git URL, nothing) | **[OWNER PENDING]**. Only the loader and the lockfile are specified |
| C9 | **The system prompt's content and language** (proposed: EN, generated in the runtime from facts the host supplies) | **[OWNER PENDING]** (§10) |

---

## 3. The catalogue model

### 3.1 Kinds

| Kind | What it is | Format | Consumed by |
|---|---|---|---|
| `command` | a named verb a person types (`/name args`) | built-in: code. Custom: markdown + frontmatter, body = a prompt template | the command registry (§5.1) |
| `skill` | know-how loaded only when relevant | a folder with `SKILL.md` (frontmatter `name`, `description`; body markdown; optional files) | the system prompt (descriptions) + the `skill.load` tool (§5.2) |
| `agent` | a named profile: prompt addendum, model, tools, permission profile | markdown + frontmatter, body = prompt addendum | the primary session and B6.1 `agent.spawn` (§5.3) |
| `mcpServer` | an MCP server declaration | an entry in `settings.json` (§3.4) | B6.3 (§5.4) |
| `permissionProfile` | a named policy layer | JSON in the `PolicyRule` shape of `policy/rules.ts`, unchanged | the policy (§5.5) |
| `afterEdit` | "when a file matching X was edited, run Y" | an entry in `settings.json` | the loop, as a policy-judged tool call (§5.6) |
| `plugin` | reserved name, **no loader** (D9) | — | nothing yet |

### 3.2 The entry — the same fields for every kind

```ts
interface CatalogueEntry {
  kind: 'command' | 'skill' | 'agent' | 'mcpServer' | 'permissionProfile' | 'afterEdit'
  name: string                      // [a-z0-9][a-z0-9-]{0,63}, unique per kind after precedence
  scope: 'builtin' | 'user' | 'project' | 'compat'
  source: { path?: string; sha256?: string; installed?: LockRef }   // where it came from, exactly
  enabled: boolean                  // a person can switch an entry off without deleting it
  trust: 'n/a' | 'untrusted' | 'trusted'   // project scope only; see §4
  shadows?: { scope: CatalogueEntry['scope']; path?: string }       // said, never silent
  problems: CatalogueProblem[]      // validation findings, each a SENTENCE with file:line
}
```

- An entry with a problem stays **listed and disabled**, carrying its sentence. It is never silently
  dropped: a skill that "does nothing" because of a typo in its frontmatter is indistinguishable
  from a broken harness, the same reason `HARNESS_CAPABILITIES` renders N/A rather than 0.
- **Unknown keys are refused, not ignored.** A misspelled permission key that is silently ignored is
  a rule the person believes is in force and is not. This is opencode's validation stance, read from
  its own configuration skill.

### 3.3 Where each scope lives

| Scope | Location | Backed up? |
|---|---|---|
| `builtin` | compiled into `packages/runtime` | n/a |
| `user` | `<AGENTISTICS_DIR>/harness/` → `settings.json`, `commands/*.md`, `skills/<name>/SKILL.md`, `agents/*.md`, `profiles/*.json`, `harness.lock.json` | **yes, by ADDING `.agentistics/harness` to `ALWAYS`** (see below) |
| grants (trust + remembered approvals) | `<AGENTISTICS_DIR>/runtime/harness-grants.json`: folder trust (§4) and per-server MCP approvals (§5.4) | **no**: it sits under `.agentistics/runtime`, which B4 excludes as `runtime` |
| `project` | `<workspaceRoot>/.agentistics/` (same file layout as user) | it is in the repository |
| `compat` (opt-in) | `~/.claude/skills`, `~/.agents/skills` (skills only, read-only) | not ours to back up |
| secrets | MCP OAuth tokens and header secrets in the host credential store (B1.3, 0600) | **no, `secret` row**, like provider keys |

**How the backup actually decides, VERIFIED in `backup/backup-plan.ts` on 2026-09-28 (not assumed):**

- **The backup is an ALLOWLIST.** From `~/.agentistics` it carries only the paths listed in `ALWAYS`
  (`tags.json`, `workflows`, `tasks.json`, `task-files`, `attachments`, `journal.db`, …) plus the
  per-harness session stores and the archive layer. Every other path needs a decision, and
  `backup-coverage.lint.test.ts` fails the build on an undecided one. So `.agentistics/harness`
  **must be added to `ALWAYS`**, with its reason (configuration a person wrote; nothing regenerates
  it). Merely living outside an excluded directory is not enough.
- **The `.agentistics/runtime` exclusion row (`reason: 'runtime'`) exists on
  `origin/feat/runtime-sessions`** (B4, 7d77e812: "the native runtime's session store … a lease
  naming a pid on THIS machine"). It is **not yet on `origin/dev`** at the time of writing. B8 lands
  after B4 and relies on that row being present.
- **No grant travels in a backup.** Folder trust and remembered server approvals are keyed to paths
  and declarations on THIS machine. Restored elsewhere, they would trust whatever repository sits at
  that path there. So they live under `runtime/`, and a restored machine starts with nothing
  trusted and nothing approved.
- **Stated limit.** The plan's substring rules (`.key`, `.tmp-`, `.corrupt-`, `match: 'contains'`)
  also apply inside `harness/`. A skill file whose path contains one of them does not travel.
  `/catalogue` should say so on that entry rather than let the restore silently lack it.

`AGENTS.md` is NOT a catalogue entry. It is instructions a person wrote, handled by the system
prompt (§10, H2), and it stays out of B6.6 memory.

### 3.4 `settings.json` (user and project), strictly validated

```jsonc
{
  "defaultModel": { "provider": "anthropic", "model": "claude-sonnet-5" }, // user scope only
  "rules": [ /* PolicyRule[] exactly as policy/rules.ts defines it */ ],
  "profile": "default",                     // the permission profile a session starts in
  "mcpServers": {
    "db": { "type": "stdio", "command": ["bunx", "some-mcp"], "env": { "DB_URL": "{env:DB_URL}" } },
    "docs": { "type": "http", "url": "https://mcp.example.com", "auth": { "credential": "docs-oauth" } }
  },
  "afterEdit": [ { "match": "**/*.ts", "run": ["bunx", "biome", "format", "--write", "{path}"], "timeoutMs": 20000 } ],
  "compat": { "claudeSkills": false, "agentsSkills": false },
  "skills": { "budgetTokens": 2000 }
}
```

- **A literal secret in `settings.json` is refused**, in words, in both scopes. Secrets are
  `{env:VAR}` references or a host credential id. The detector is the shape side of
  `redactSecrets` (`@agentistics/core`), used as a refusal, not as a scrub.
- **`defaultModel` is user scope only.** A repository choosing which paid model a person's key is
  billed against is a billing decision made by someone else. It also removes the reason B4 §8 made
  `--model` mandatory ("guessing one is a billing decision"): a setting the PERSON wrote is not a
  guess.

### 3.5 Precedence

1. **Same kind + same name → the more specific scope wins** (`project` > `user` > `compat` >
   `builtin`), and the winner carries `shadows`. `/catalogue` says so in a sentence.
2. **Anything that grants power NARROWS instead of overriding.** Rules compose as `rules.ts` already
   composes them (deny absolute across layers, the earlier layer wins ties). An agent profile or a
   permission profile from a narrower scope may REMOVE tools or ADD deny/ask. It never adds an
   allow, a tool, or a server that the wider scope did not grant, unless the project is trusted
   (§4).
3. **Built-in commands cannot be shadowed** by project scope (a repository must not redefine `/undo`
   or `/permissions`). User scope may shadow a built-in only by an explicit `override: true`, and the
   listing says so.

---

## 4. Trust — a cloned repository does not configure the agent that reads it

Codex (trusted projects) and Gemini (trusted folders) both gate project configuration on trust, for
the reason B3-SEC just spent a review on.

**States.** `untrusted` (default) and `trusted`. Trust is recorded in
`<AGENTISTICS_DIR>/runtime/harness-grants.json` (machine-local, never backed up: §3.3), keyed by the
workspace root's realpath and carrying `{ trustedAt, grants: sha256 }`.

**What an UNTRUSTED project may do:**

| Project entry | Untrusted | Trusted |
|---|---|---|
| rules: `deny` / `ask` | **applied** | applied |
| rules: `allow` | **ignored**, listed as "needs trust" | applied, still below the floor and below any user deny |
| commands, skills, agent prompt text | **loaded**: they are text the model reads, and a skill's scripts run only through `shell.start` under the policy | loaded |
| agent profile widening tools/permissions | **ignored** (the narrowing part applies) | applied, never above the session's own grants |
| `mcpServers` | **not started** | started, after the per-server approval below |
| `afterEdit` | **not run** | proposed as policy-judged tool calls (§5.6) |
| `defaultModel` | not read (user scope only) | not read |

**The grants hash.** At trust time the host hashes the POWER-GRANTING subset of the project's
catalogue: allow rules, `mcpServers`, `afterEdit`, and agent profiles that widen anything. On every
load it recomputes that hash. **A different hash drops the project back to `untrusted` for those
entries, with a sentence naming what changed.** Otherwise a `git pull` could add an MCP server to a
folder trusted last month. Text-only changes (a new command, an edited skill) do not re-ask.

**How trust is granted.** Only by an explicit act of the person: `/trust` in a session, or
`agentop code trust <dir>`. It is never granted by a flag in the repository, never by answering an
unrelated question, and never on a central (§8).

**Revoking trust clears everything the trust earned** [LEADER]. `/untrust` (and
`agentop code untrust`) removes the folder's trust record AND every remembered approval that the
project's entries obtained while trusted: per-server MCP approvals (§5.4), and anything else keyed
to that project in `harness-grants.json`. The same happens when a changed grants hash drops the
project back to `untrusted`. Otherwise a project that is untrusted and later re-trusted would
restart a server the person approved once, under other circumstances, without asking again. A
revocation is audited and names what it cleared.

**What trust never does:** lift the deny floor, lift a user-scope deny, or skip a per-call ask that
the policy decides to make.

---

## 5. How each kind is used at run time

### 5.1 Commands — one registry, shared by every surface

- The registry is **data in `packages/runtime`**:
  - built-ins with `{name, description, args, availability, handlerId}`;
  - custom commands appended from the catalogue.

  Handlers live in the host (D23). The terminal (B4.4 follow-up) and the web composer (UI.3) read
  the SAME list: one gesture implemented twice is the defect `task-reopen.ts` exists to have fixed.
- **Which built-ins exist, and how they look, is UI.6's call.** The matrix's candidate list is
  `/help /new /resume /exit /undo /cost /context /permissions /profile /trust /catalogue /reload`.
- A **custom command** expands its template into ONE user message:
  - `$ARGUMENTS` and `$1…$9` are substituted;
  - `@path` is resolved through the policy's read rules and inlined, or refused in words.

  There is **no shell execution inside a template.** Claude Code's command files can run `!`bash
  lines when they expand; here an `!` in a template is literal text. A person running a command
  themselves is `!cmd` at the prompt, judged by the policy as `shell.start` with the person as actor.
- A command may name an `agent` profile and a `model` (same provider only, §12 Q5); both are
  narrowed like any profile.

### 5.2 Skills

- **The descriptions** of every enabled skill go into the system prompt, bounded by
  `skills.budgetTokens`. Past the budget, the list ends with `N more skills — /catalogue`; it never
  truncates silently.
- **`skill.load(name)`** is a new tool (catalogue class `auto`). It returns the SKILL.md body and
  the names of the skill's other files. The host adds ONE session-scoped read rule naming exactly
  that skill's directory (`pathGlob`). This is how a compat skill outside the workspace becomes
  readable without a general outside-workspace allow. opencode does the same thing: its plan agent's
  permission list, read from `opencode debug agent plan`, carries one `external_directory` allow per
  skill directory.
- A skill's scripts run only through `shell.start`, under the policy. A skill grants no permission.
- Journal: `skill.load` is an ordinary `tool.*` execution. So the product's existing `skills`
  capability (`skill_uses`) can be filled for the native harness from the same events. No new
  vocabulary.

### 5.3 Agent profiles

- **Fields:** `description`, `model?` (same provider), `tools?` (an allowlist over the session's
  tools), `permissionProfile?`, and the body (a prompt addendum).
- **Built-ins:**
  - `default`;
  - `plan`: read-only. The matrix's plan mode is simply this profile. It honours B3 §3's exclusion
    of a separate plan-mode TOOL; `task.plan` stays the checklist;
  - `explore`: read tools only, cheaper model if configured.
- **Used by:** the primary session (`/profile <name>`, `agentop code --profile`) and **B6.1
  `agent.spawn({ profile })`**. This spec asks B6.1 to take a profile rather than invent its own
  option set. A profile only ever NARROWS the spawning session's grants (§3.5).

### 5.4 MCP servers — declared here, connected by B6.3

- **Declaration** lives in `settings.json` (§3.4); **connection** is B6.3.
- **Tool names are `mcp__<server>__<tool>`**, the naming the product already parses for the
  `mcpServers` capability and `tool_counts`. The native harness then shows up in the existing MCP
  metrics with no new reader.
- **Default permission for an MCP tool: `ask`.** A rule may allow a tool by name.
- **Starting a stdio server is spawning a process**, so it is a policy decision: one approval per
  server, keyed by the hash of its declaration, remembered in `runtime/harness-grants.json`
  (machine-local, never backed up). A changed declaration asks again. A project server additionally
  needs trust (§4), and **`/untrust` clears that project's remembered server approvals** along with
  the trust itself.
- **Remote servers and tokens** follow the rule B3-SEC F1 applied to provider keys, and the rule
  G-1 applied to the Google client:
  - the credential is bound to the server's ORIGIN and never sent anywhere else;
  - `redirect: 'error'`;
  - a token is never accepted for a different service;
  - its use is never an ask that a person could release into "allow everything".

  OAuth tokens live in the host credential store (0600, backup `secret` row).
- **Reuse, don't reimplement:** "is it up?" is `mcp-check.ts` (`initialize`) and "what does it
  offer?" is `mcp-tools.ts` (`tools/list`). The host already has both.
- **Import from another harness's config** (`mcp-config.ts` knows Claude's three scopes) is an
  explicit, one-time COPY into user scope, never a link. The native harness keeps working if that
  file changes or disappears.

### 5.5 Permission profiles

- **A profile is a `PolicyLayer`** in the existing `rules.ts` shape, inserted between the user and
  project layers.
- **Built-ins:**
  - `default`: no extra rules;
  - `plan`: deny `write` and every mutating shell segment the parser can classify; ask on opaque
    ones;
  - `accept-edits`: allow `file.patch` / `file.write` inside the workspace.
- **The floor is untouched by every profile.** A "bypass" profile does not exist and cannot be
  written: the loader refuses any profile rule that targets a floor subject, in words.
- Switching a profile mid-session is an event-bearing act (§6) and resets nothing else. Session
  approvals survive a switch into a STRICTER profile and are dropped on a switch into a looser one:
  approving something under `plan` must not become permission under `accept-edits` by accident.

### 5.6 After-edit steps — a proposal, not a hook

- When `file.patch` or `file.write` succeeds on a path matching an `afterEdit.match`, the runtime
  builds `shell.start(run with {path} substituted)`. That call **goes through the policy exactly as
  if the model had asked for it**: floor first, then rules, then ask. A user rule may allow it (e.g.
  `commandPrefix: ['bunx','biome']`).
- **Its output is appended to the model's next context as a tool result**, so the model sees "the
  formatter changed 3 lines" or "the linter failed". Its failure never fails the edit that
  triggered it.
- **Observation hooks do not exist as a mechanism.** "Tell me when X happens" is a subscriber to the
  journal/event stream the product already has (`agentop events`). There an event carries facts and
  never an instruction (`events-frontier.test.ts`), so an observer cannot become a way to act around
  the policy [LEADER].

---

## 6. The loader, and what the journal records

- **Pure planning in the runtime:** `packages/runtime/src/catalogue/`:
  - `parse.ts`: frontmatter, JSON, and the strict key allowlists;
  - `plan.ts`: precedence, shadowing, trust gating, the grants hash;
  - `profiles.ts`: built-ins.

  Fed with `{ path, bytes }` records by the host. No global in the runtime reads a host path (D23).
- **IO in the host:** `packages/server/server/harness-catalogue.ts` walks the scope directories,
  reads trust, resolves credential ids, and hands the records over.
- **When it loads:** at session start, and on `/reload`. There is no file watcher. A catalogue that
  changes under a running turn is a turn whose rules changed midway.
- **What the journal records:** every `run.started` carries `catalogue: { sha256, entries: number,
  trusted: boolean }`, OPTIONAL and additive in the D20 style. So "which skills and rules were in
  force for this run" is answerable forever, and the content is not copied into the journal.
  Profile switches, trust grants and revocations, and server approvals are recorded as `policy.*`
  events with the entry name and hash, never file contents. **[LEADER]** decides whether the
  `run.started` field needs an owner decision like D20–D25.

---

## 7. Installing from somewhere — the lockfile, not the store

- **An entry's source** is `local`, `compat` or `installed`.
- **Installing** (from a URL or a git ref: **where from is [OWNER PENDING]**) is:
  1. fetch;
  2. verify the sha256 against what the source declares;
  3. copy into user scope;
  4. write `harness.lock.json` `{ kind, name, origin, ref, sha256, installedAt }`.
- **On every load,** an installed entry whose files no longer match their lock hash is **disabled**
  with a sentence ("modified since install; reinstall or adopt it as local").
- **No auto-update.** Updating is an explicit command showing the diff of what changes (text, rules,
  declared servers). Anything that grants power passes through the same approval as a new one.
- **A `plugin` kind stays without a loader** (D9). A fetched package containing code is refused
  unless it is only skills, commands, agents, profiles and server DECLARATIONS. A declared stdio
  server is still a separate process started under §5.4. Nothing is ever `import()`ed into the
  harness.

---

## 8. Surfaces and security

| Rule | Where it binds |
|---|---|
| Every new route that reads a skill/MCP/project file, downloads for an install, or writes trust is registered in `capability-guard.ts` (`localShell`); an unregistered route is treated as dangerous by that file's own rule | host |
| The catalogue is **refused on a central**, like every `localShell` route (and like the native runtime itself, B4 §7) | host |
| A web screen for the catalogue follows **S-1** (host allowlist) and `exposure.ts`'s `CAPS` | host |
| Trust is granted only by an explicit person act, in the terminal or an authenticated local web session; **never by a relayed central action** | host |
| Writes into the user scope are atomic, 0600/0700, like `credentials.ts` | host |
| An **audit event** for trust grant/revoke, server approval, install and uninstall (`audit.ts`) | host |
| `.agentistics/harness` is added to `backup-plan.ts`'s `ALWAYS` before the first file is written, and the grants file relies on B4's `.agentistics/runtime` exclusion (§3.3). `backup-coverage.lint.test.ts` makes an undecided path fail the build | host |

**CLI (names are a proposal; UI.6 may rename the in-session commands):**

```
agentop code catalogue ls [--kind <k>] [--scope <s>] [--problems]
agentop code catalogue show <kind> <name>
agentop code trust <dir> | untrust <dir>
agentop code install <source> | uninstall <kind> <name>     # source kinds: [OWNER PENDING]
```

---

## 9. What this spec deliberately does NOT do

| Not doing | Why |
|---|---|
| A generic shell hook system (Claude Code's shape) | C3/C4: it reopens exactly the holes B3-SEC closed [LEADER] |
| A profile or rule that lifts the floor ("yolo") | the floor is the one guarantee without a sandbox (D-T5) |
| Loading plugin code | D9 [OWNER] |
| Hot reload on file change | rules changing mid-turn; `/reload` is explicit |
| Reading `CLAUDE.md` / `GEMINI.md` / `.claude/commands` by default | precedent, never a dependency; opt-in compat only, and for skills first |
| Running `!` lines inside command templates | a template is text, not a script |
| A marketplace backend | later, and probably Enterprise [LEADER] |

---

## 10. The harness basics (Part B) — the matrix's M1 seams, stated here so they have a home

These are not catalogue kinds, but the catalogue needs two of them (the system prompt carries skill
descriptions and `AGENTS.md`), and none is on the board.

| Id | What | Status |
|---|---|---|
| **H1-lean** | **System prompt, host facts only, no catalogue**:<br>• cwd and workspace root;<br>• git branch and a status summary;<br>• platform and date;<br>• the "no sandbox: tools run as you" fact that `agentop code` already prints to the PERSON (B3-SEC F5) and never tells the model;<br>• the tool conventions (`file.patch` is read-before-write; `shell.*` is one persistent session; `task.plan` is a checklist).<br>No skill descriptions and no active profile: those exist only after B8. Generated in `packages/runtime` from facts the host supplies (D23), marked cacheable (`systemCache` exists on the loop). **Verified 2026-09-28:** the shipped `agentop code` sends NO system prompt at all (`session/runtime.ts:288` calls `runToolLoop` without `system`), and the B4 spec does not mention one. | **proposed for M1** [LEADER] as a SMALL item inside the work already in flight (UI.6 / B4.4 follow-up), pending the owner's yes (§12 Q1). Language: **EN proposed**, [OWNER PENDING] |
| H1-full | H1-lean plus the catalogue's parts: skill descriptions (budgeted), the active agent/permission profile, `AGENTS.md` (H2) | post-M1, with B8.6 |
| H2 | `AGENTS.md`, from the workspace root down the directory chain to `cwd`, into the system prompt. `CLAUDE.md`/`GEMINI.md` via `compat` only | **post-M1** [LEADER]: its absence is a nuisance, not a session with no context at all |
| H4 | Undo: expose `tools/file/checkpoint.ts`'s `restore` (last run / session) as `/undo`; persist the checkpoint through the content store (engine verified present by the leader) | proposed |
| H5 | Context floor until B4-CTX: a token-counted trim against `resolveContextWindow`, plus a sentence on a provider "input too long". **Replaced wholesale by B4-CTX** | **post-M1** [LEADER] |
| H6 | Per-run line (tokens, cost, cache share) + the context gauge, reusing `contextFraction` / `resolveContextWindow` (the look is UI.6's) | proposed |
| H7 | Deterministic session title from the first prompt (`sessionLabel` rules), no model call | proposed |
| H8 | Audit event for creating and driving a native session (the B4 §8 stated limit) | proposed |
| H9 | Terminal-as-client of `agentop server`: **a dependency pointer to the B4 spec §8 limit, not a decision** | [LEADER] |

---

## 11. Delivery breakdown (proposed; the leader reconciles and files)

Model: **Opus** for the implementing sessions [LEADER, owner rule of 2026-09-28]. Sizes on the
board's ruler.

| Draft id | Item | Size | Depends on |
|---|---|---|---|
| B8.1 | `catalogue/` pure core: entry, parse, strict validation, precedence, shadowing, problems-as-sentences + tests | medium | — |
| B8.2 | Host loader + scope dirs + the `ALWAYS` entry for `.agentistics/harness` + `catalogue ls/show` | medium | B8.1, B4 landed on dev (its `.agentistics/runtime` row) |
| B8.3 | Trust: `runtime/harness-grants.json`, grants hash, `trust/untrust` (untrust clears the project's remembered approvals), re-ask on change, audit | medium | B8.2 |
| B8.4 | Permission profiles (`default`/`plan`/`accept-edits`) + `settings.json` rules into `PolicyLayer`s (ends `layers: []`) | medium | B8.2, B8.3 |
| B8.5 | Command registry (runtime data + host handlers) + custom markdown commands | medium | B8.1; UI.6 for the list |
| B8.6 | Skills: discovery (native + opt-in compat), `skill.load`, budgeted descriptions | medium | B8.2, H1 |
| B8.7 | Agent profiles + the `agent.spawn({profile})` contract handed to B6.1 | small | B8.4 |
| B8.8 | MCP declarations in the catalogue + per-server approval + credential binding; **extends B6.3** | medium | B8.3, B6.3 |
| B8.9 | After-edit steps as policy-judged tool calls | small | B8.4 |
| B8.10 | Installer + `harness.lock.json` + hash verification (source kinds per the owner) | medium | B8.2, C8 decided |
| H1-lean | Part B (§10): the M1 exception | small | the owner's yes (§12 Q1) + C9 |
| H1-full, H2, H4–H8 | Part B (§10), post-M1 | 1 medium + 6 small | H1-full needs B8.6 |

---

## 12. Open questions

1. **For the owner — pull H1-lean into M1? The leader's concrete recommendation is YES** [LEADER].
   The shipped `agentop code` sends no system prompt. A test run without one has a model that does
   not know where it is, that there is no sandbox, or how its tools behave, and the harness would be
   judged bad for missing the basics. H1-lean (§10) is SMALL, uses host facts only, needs nothing
   from B8, and fits inside the UI.6 / B4.4 follow-up work already in flight. H2 (`AGENTS.md`) and
   H5 (the context floor) stay post-M1. The leader takes this to the owner.
2. **For the owner — C8.** Where do installable entries come from: nothing yet, git URLs, a curated
   list, or a store?
3. **For the owner — C9.** The system prompt's content and language (EN proposed).
4. **For the leader.** Does `run.started.catalogue` (§6) need a D-numbered decision?
5. **For the leader/B6.1.** Model change inside a profile or command: same provider only (the
   matrix's recommendation), or out of scope for now?
6. **For UI.6.** The final built-in command list and names, and whether the in-session commands for
   trust and catalogue appear in the terminal UI at all or stay CLI verbs.

---

## 13. Acceptance criteria

1. An untrusted project's `allow` rule, MCP server and after-edit step have NO effect, and each is
   listed with the sentence saying why; its deny/ask rules DO apply.
2. Changing a trusted project's power-granting subset re-asks; editing a command's text does not.
   `untrust` followed by `trust` asks again for every MCP server of that project; nothing the first
   trust earned survives the revocation.
3. No catalogue entry can lift the deny floor; the loader refuses such a rule in words (test over
   every floor subject).
4. An invalid entry is listed disabled with a file:line sentence, never dropped.
5. A literal secret in either scope's `settings.json` is refused.
6. A skill outside the workspace is readable through `skill.load` and nothing else outside the
   workspace becomes readable.
7. `run.started` carries the catalogue hash; two runs with the same catalogue carry the same hash.
8. The terminal and the web read one command list (a test over the registry, not over two copies).
9. An installed entry modified after install is disabled with a sentence.
10. Every new host path has a backup row, and every new route is in `capability-guard.ts`
    (both enforced by the existing lint tests).
