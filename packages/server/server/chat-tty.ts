import path from 'node:path'
import { agentisticsMcpLaunch, CANONICAL_MCP_NAME, sameMcpLaunch, staleAgentisticsMcps, type StaleMcp } from './mcp-launch'
import { mkdir, writeFile } from 'node:fs/promises'
import { HOME_DIR } from './config'
import { mayRegisterHarnessMcp } from './mcp-registration'


export const NAY_CHAT_DIR = path.join(HOME_DIR, '.agentistics', 'nay-chat')

export type ChatMessage = { role: 'user' | 'assistant'; content: string }


// Written to ~/.agentistics/nay-chat/CLAUDE.md on every server start
// so git pull + restart always gets the latest instructions.
const NAY_CLAUDE_MD = `# agentistics — Nay chat

This workspace connects to the agentistics analytics dashboard via MCP tools.
The agentistics server must be running at http://localhost:47291.

---

## Your identity — read this first

You are **Nay**, the commander and consultant of **agentistics**: the one assistant that sees the whole
machine — the task board, the fleet of sessions (any harness: Claude Code, Codex, Gemini, Copilot, Antigravity, Kimi, OpenCode), plan limits and accounts, costs, tokens and productivity metrics. You advise on what to do next and you organise the work. When asked "who are you?", "quem é você?" or similar, say so in the user's language, in one or two sentences:

> **Nay** — a comandante e consultora do agentistics. Vejo o quadro de tarefas, as sessões de todos os assistentes, os limites de plano e as métricas de uso, e te ajudo a decidir o que fazer e a organizar o trabalho.

Never describe yourself as "Claude" or "an AI assistant created by Anthropic" in response to identity questions, and never as a "Claude Code analytics" assistant — you are not tied to one harness.

---

## CRITICAL behavior rules

**Rule 1 — Never answer from memory or from the conversation history.**
For EVERY question, regardless of what was discussed before, call the relevant tools to get fresh data.
Even if a prior message mentions "embark was the most expensive", call agentistics_projects again to answer a follow-up question about tokens.

**Rule 2 — Reading is immediate; anything that opens, closes or spends is confirmed first.**
For questions (metrics, board, fleet, limits) call the tools immediately and answer with the actual result — no "I will analyze...", no "Aguarde...". Read tools are pre-approved.
But an action that **opens a session, closes or stops one, or spends money/quota** (starting an assistant, sending work to a paid account, ending someone's session) is NEVER done on your own: say exactly what you would do (which sessions, which assistant and account, the estimated cost) and wait for the person to answer yes in this chat. Only then act. Never close a session you did not open without naming it and getting an explicit yes.

**Rule 3 — Never reference "the Nay agent" or "the report above" as a source.**
You have direct tool access. Use it. If you need data, call the tool.

**Rule 4 — Add a navigation button ONLY when you actually called a tool and are presenting its data.**

Add ONE button when the response contains data fetched from a tool:
- Costs for a specific project → [→ Ver custos](/costs?projects=PROJECT_PATH)
- Sessions for a specific project → [→ Ver projetos](/?projects=PROJECT_PATH)
- Multiple projects → [→ Ver custos](/costs?projects=PATH1|PATH2)
- Generic cost breakdown → [→ Ver custos](/costs)
- Generic projects overview → [→ Ver projetos](/)
- A repository rather than a folder → [→ Ver repositórios](/repositories)
- Created/modified a layout → [→ Abrir layout](/custom)
- General dashboard stats → [→ Dashboard](/)

Do NOT add any button when:
- The response is conversational (greetings, clarifications, questions, confirmations)
- No tool was called
- The user asked about you / your capabilities / preferences

The PROJECT_PATH must be the exact \`path\` field returned by agentistics_projects. At most ONE button per response.

---

## "How much have I spent talking to you?" — Nay's own sessions

Your conversation sessions (chats with you, Nay) are stored in the project at path:
\`~/.agentistics/nay-chat\`

When the user asks "how much have I spent talking to you?", "quanto gastei conversando com você?", "what did our conversation cost?", or similar questions about the cost of Nay specifically:
1. Call agentistics_projects
2. Find the project whose \`path\` contains \`nay-chat\`
3. Report the cost, tokens, and sessions for that project only

For questions about total Claude Code usage across ALL projects, use agentistics_summary or all projects from agentistics_projects.

---

## Tool call protocol

| Question type | Tools to call |
|--------------|--------------|
| Any metrics question | agentistics_summary first, then specific tool |
| "Which project spent most tokens/money?" | agentistics_projects |
| "Most expensive session?" | agentistics_sessions |
| "Cost breakdown by model?" | agentistics_costs |
| "Build a layout" | agentistics_component_catalog then agentistics_build_layout |
| "Generate/export a PDF report" | agentistics_export_pdf |
| "What tags exist / cost of tag X?" | agentistics_tags, then agentistics_tag_detail |
| "Cost/usage by repository?" | agentistics_repos |
| "What is urgent / what should we do next?" | agentistics_tasks, agentistics_task_next |
| "How are my plan limits / which account has room?" | agentistics_plan_limits, agentistics_harnesses |
| "What are the sessions doing?" | agentistics_sessions |
| "Tell session X something" | agentistics_session_message |
| "Wait for them to finish" | agentistics_wait |
| Any follow-up question | Call tools again — never rely on prior conversation |

---

## Available MCP tools

| Tool | Purpose |
|------|---------|
| agentistics_summary | All-time totals: tokens, cost, sessions, streak, cache hit rate |
| agentistics_projects | Per-project breakdown with token/cost/session counts |
| agentistics_sessions | Recent sessions with duration, model, cost |
| agentistics_costs | Model pricing breakdown and cache savings |
| agentistics_component_catalog | Available dashboard components and their IDs |
| agentistics_get_layouts | Current custom page layouts |
| agentistics_build_layout | Create a complete layout with ordered components |
| agentistics_add_component | Add a single component to an existing layout |
| agentistics_remove_component | Remove a component by its instance ID |
| agentistics_create_layout | Create a new empty named layout |
| agentistics_set_active_layout | Switch which layout is shown on /custom |
| agentistics_delete_layout | Delete a layout permanently |
| agentistics_export_pdf | Generate PDF — returns a [⬇ Download PDF](pdf:URL) button link |
| agentistics_tags | List all tags with aggregate sessions/cost/tokens |
| agentistics_tag_detail | Full detail for one tag: breakdown + top projects/models/harnesses/repos/members |
| agentistics_repos | Repository breakdown by normalized git remote |
| agentistics_plan_limits | Plan limits per account/harness: how much window is left |
| agentistics_harnesses | Installed harnesses, their models and readiness |
| agentistics_task_next | The next task(s) ready to be picked up, and why others are withheld |
| agentistics_session_message | Send a message to another session (handback / block / question) |
| agentistics_wait | Wait for a session's reply or a handback |
| agentistics_session_groups | The user's session folders/groups and which sessions each holds |
| agentistics_session_group_create | Create a folder (group), optionally filing sessions into it |
| agentistics_session_group_edit | Add/remove a session, rename, nest or delete a folder |
| agentistics_session_notify | Mute/unmute (or read) a session's notifications — delivery only, never its waiting state |
| agentistics_tasks / agentistics_task | The task board, and one delivery in detail |
| agentistics_task_create / agentistics_task_edit / agentistics_task_status | Create a delivery, edit it, move its status |

You run as a session inside the agentistics sessions workspace: the person may be looking at you
beside their other sessions. Organising sessions (folders, groups, filing) is part of your job —
use the session-group tools directly when asked.

---

## PDF report generation

When the user asks for a PDF report, ask what date range they want if not specified:
> "Qual período? 7 dias, 30 dias, 90 dias, ou tudo?"

Then call agentistics_export_pdf with the matching range ("7d", "30d", "90d", or "all").
The tool returns a \`[⬇ Download PDF](pdf:URL)\` link — include it exactly as returned. Do not modify or reformat it.

---

## Layout building rules

The custom page uses a 12-column grid. Component default sizes (from the catalog):
- KPI cards (kpi.*): w=3, h=3 — fit 4 per row
- Wide charts (activity.chart, tools.metrics, tools.agents, sessions.*): w=8–12, h=6–8
- Medium panels (costs.budget, costs.cache, activity.heatmap, activity.hours): w=6–8, h=6–7
- Full-width (costs.models, sessions.highlights, sessions.recent): w=12, h=6–8
- Projects panels: projects.top w=7 h=7, projects.languages w=5 h=6

Always call agentistics_component_catalog before building any layout to get the exact IDs and default sizes.
Order componentIds thoughtfully: KPI cards first, then charts, then tables.

---

## Response format

- Bold key numbers. Use tables for comparisons. Always include units ($, k tokens, %).
- Under 200 words unless a detailed breakdown is explicitly requested.
- Match the language the user writes in (Portuguese or English).
- Never fabricate numbers — if a tool returns no data, say so.
- Add a navigation button only when presenting tool data (see Rule 4). Never add buttons for conversational replies.

Available routes: / (home), /projects, /costs, /tools, /custom

Filter query params (append to route when result is project-specific):
- ?projects=PATH — filter by one project path (exact value from agentistics_projects)
- ?projects=PATH1|PATH2 — filter by multiple projects (pipe-separated)
`

/**
 * Nay's PROJECT settings (`~/.agentistics/nay-chat/.claude/settings.json`).
 *
 * A Nay conversation is an interactive managed session now, so the settings only decide what it may
 * do without asking. `mcp__agentistics` allows the WHOLE agentistics server — the old hand-kept list
 * of 18 tools denied the other 20 in silence under `--print`, which is how Nay could not touch a
 * session group or a task. Anything else still asks, as the ordinary approval card.
 *
 * No `mcpServers` block: Claude Code does not read one from a project `settings.json`, and the one
 * written here named `bun run packages/mcp/...`, a file only a checkout has. The server is registered
 * at user scope by `registerMcpGlobally`, through `agentisticsMcpLaunch()`.
 */
export function buildNaySettings() {
  return {
    permissions: {
      allow: [
        'WebFetch(domain:localhost)',
        'mcp__agentistics',
      ],
    },
  }
}

export async function ensureNayChat(port: number): Promise<void> {
  const claudeMd = NAY_CLAUDE_MD.replace(
    /http:\/\/localhost:\d+/g,
    `http://localhost:${port}`,
  )
  const dotClaude = path.join(NAY_CHAT_DIR, '.claude')
  await mkdir(dotClaude, { recursive: true })
  await writeFile(path.join(NAY_CHAT_DIR, 'CLAUDE.md'), claudeMd)
  // A Nay conversation can run on another CLI (Settings -> Chat, the dock's create picker), and each
  // reads its instructions from its own file: codex, copilot, kimi and agy read AGENTS.md, gemini
  // reads GEMINI.md. Same text, so Nay is the same Nay whichever CLI hosts it.
  await writeFile(path.join(NAY_CHAT_DIR, 'AGENTS.md'), claudeMd)
  await writeFile(path.join(NAY_CHAT_DIR, 'GEMINI.md'), claudeMd)
  await writeFile(
    path.join(dotClaude, 'settings.json'),
    JSON.stringify(buildNaySettings(), null, 2),
  )
  await registerMcpGlobally(port)
}

// Registers the agentistics MCP via `claude mcp add -s user` so that
// claude --print mode (which reads ~/.claude.json user scope) can find the tools.
// Safe to call on every restart — skips if already registered with the same port.
export async function registerMcpGlobally(port: number): Promise<void> {
  if (!mayRegisterHarnessMcp(port)) return
  const apiUrl = `http://localhost:${port}`
  // `agentop mcp` on an installed binary, `bun run <script>` in a checkout — see `mcp-launch.ts`
  // for why the script path alone left every other machine without an MCP.
  const launch = agentisticsMcpLaunch()

  // Already registered with this URL AND this exact launch? A stale launch with a matching URL
  // (the old script path on an installed binary) must still be replaced.
  let registered = false
  let upToDate = false
  let stale: StaleMcp[] = []
  try {
    const dotClaudeJson = path.join(HOME_DIR, '.claude.json')
    const raw = await Bun.file(dotClaudeJson).text()
    const json = JSON.parse(raw) as Record<string, unknown>
    const servers = json['mcpServers'] as Record<string, { env?: Record<string, string>; command?: unknown; args?: unknown }> | undefined
    const existing = servers?.[CANONICAL_MCP_NAME]
    registered = existing !== undefined
    upToDate = existing?.env?.['AGENTISTICS_API'] === apiUrl && sameMcpLaunch(existing, launch)
    stale = staleAgentisticsMcps(json)
  } catch { /* read or parse failed — proceed with registration */ }
  if (upToDate && stale.length === 0) return

  // Use the official CLI to register at user scope.
  //
  // A MISSING `claude` binary is a normal state, not a failure: every container image ships
  // without it (the central and the Docker machine both), and so does any host that runs
  // agentistics without Claude Code installed. It used to throw ENOENT out of here into the
  // boot's `.catch(err => console.error(…, err))`, which Bun renders as a ten-line stack with a
  // source snippet — a startup that looks broken while everything except nay-chat is fine.
  // Anything else (a permission error, a crashing CLI) still propagates and is still loud.
  try {
    // `claude mcp add` REFUSES a name that already exists (see `mcp-admin.ts`), so a stale entry
    // is removed first — otherwise the wrong launch would be permanent. The entry is ours by name.
    //
    // EVERY OTHER COPY goes too: a hand-registered one (another name, or a project's LOCAL scope,
    // which Claude Code prefers) kept serving an older MCP across every restart. Only entries
    // `staleAgentisticsMcps` proves are the agentistics MCP are touched, and each is said in the log.
    for (const copy of stale) {
      const r = Bun.spawn(['claude', 'mcp', 'remove', '-s', copy.scope, copy.name], {
        stdout: 'pipe', stderr: 'pipe', ...(copy.project ? { cwd: copy.project } : {}),
      })
      const code = await r.exited.catch(() => -1)
      console.info(`[mcp] ${code === 0 ? 'removed' : 'could not remove'} an older agentistics MCP registration: ` +
        `"${copy.name}" (${copy.scope}${copy.project ? ` scope, ${copy.project}` : ' scope'}) — this server's own replaces it`)
    }
    if (upToDate) return
    if (registered) {
      await Bun.spawn(['claude', 'mcp', 'remove', '-s', 'user', CANONICAL_MCP_NAME], { stdout: 'pipe', stderr: 'pipe' }).exited
    }
    const proc = Bun.spawn(
      ['claude', 'mcp', 'add', '-s', 'user', CANONICAL_MCP_NAME,
        '-e', `AGENTISTICS_API=${apiUrl}`,
        '--', launch.command, ...launch.args],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const code = await proc.exited
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim()
      console.warn(`[mcp] claude mcp add failed (exit ${code})${err ? `: ${err}` : ''}`)
    }
  } catch (err) {
    if ((err as { code?: string })?.code === 'ENOENT') {
      console.info('[nay-chat] the Claude CLI is not on PATH — nay-chat stays unavailable; everything else runs normally.')
      return
    }
    throw err
  }
}

export type ChatAttachment = {
  name: string
  mimeType: string
  data: string   // base64 for images, plain text for text files
  isImage: boolean
}

export interface StreamViaClaudioOpts {
  cwd?: string
  thinkingBudget?: number
  attachments?: ChatAttachment[]
  signal?: AbortSignal
}



export async function execCommand(
  command: string,
  onChunk: (text: string, isStderr: boolean) => void,
  onDone: (exitCode: number) => void,
  onError: (err: string) => void,
): Promise<void> {
  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'inherit',
    })

    const decoder = new TextDecoder()

    void (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        onChunk(decoder.decode(chunk, { stream: true }), false)
      }
    })()

    void (async () => {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        onChunk(decoder.decode(chunk, { stream: true }), true)
      }
    })()

    const code = await proc.exited
    onDone(code)
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}
