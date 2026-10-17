/**
 * Mocked turns in the SHAPES each harness's reader really produces (`ChatTurn`): Claude names are the
 * shared vocabulary (no `canonical`); gemini/copilot names carry `canonical` where `canonicalTool`
 * maps them; codex 0.161 calls every shell `exec`, which nothing maps yet (measured 2026-10-16).
 * `failed` is the PROPOSED field (a `tool_result` with `is_error`).
 */
import type { TurnLike } from '../../src/lib/toolActivity'

const T0 = Date.parse('2026-10-16T14:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
export const NOW_RUNNING = T0 + 2000 * 1000 + 95 * 1000

export interface Scenario { harness: 'claude' | 'codex' | 'gemini'; title: string; turns: TurnLike[] }

const MEM = '/home/dev/.claude/projects/-home-dev-app/memory'

export const CLAUDE: Scenario = {
  harness: 'claude', title: 'Claude Code',
  turns: [
    { role: 'user', at: at(0), text: 'Atualiza as memórias do projeto e cria a instrução de sistema do mentor.' },
    { role: 'assistant', at: at(4), text: 'Vou ler a memória atual antes de mexer em qualquer coisa.',
      tools: [{ name: 'Read', detail: `${MEM}/MEMORY.md`, ref: 'c1' }] },
    { role: 'assistant', at: at(9), text: '', tools: [
      { name: 'Read', detail: `${MEM}/overview.md`, ref: 'c2' },
      { name: 'Grep', detail: 'mentor', ref: 'c3' },
    ] },
    { role: 'assistant', at: at(22), text: '', tools: [
      { name: 'Edit', detail: `${MEM}/overview.md`, ref: 'c4' },
      { name: 'Edit', detail: `${MEM}/agentask-name.md`, ref: 'c5' },
      { name: 'Write', detail: `${MEM}/mentor-voice.md`, ref: 'c6' },
    ] },
    { role: 'assistant', at: at(41), text: '', tools: [
      { name: 'Write', detail: '/home/dev/app/prompts/system-instruction-mentor.md', ref: 'c7' },
      { name: 'Bash', detail: 'bun test packages/web/src/lib/mentor', ref: 'c8' },
      { name: 'Bash', detail: 'git status --short', ref: 'c9' },
      { name: 'WebFetch', detail: 'https://docs.anthropic.com/en/docs/system-prompts', ref: 'c10' },
      { name: 'mcp__agentistics__agentistics_task_comment', detail: '{"ref":"t-b0d0"}', ref: 'c11' },
    ] },
    { role: 'assistant', at: at(80), text: 'Pronto. Criei `system-instruction-mentor.md` e atualizei 3 memórias (Overview, Agentask name e a nova Mentor voice). Os testes passaram.' },
  ],
}

export const CODEX: Scenario = {
  harness: 'codex', title: 'Codex',
  turns: [
    { role: 'user', at: at(1000), text: 'Corrige o teste quebrado do chatFeed.' },
    { role: 'assistant', at: at(1003), text: '', tools: [
      { name: 'exec', detail: "rg -n 'firstFrameStale' packages/web/src", ref: 'x1' },
      { name: 'exec', detail: 'sed -n 1,120p packages/web/src/lib/chatFeed.ts', ref: 'x2' },
      { name: 'exec', detail: 'bun test packages/web/src/lib/chatFeed.test.ts', ref: 'x3', failed: true },
    ] },
    { role: 'assistant', at: at(1031), text: 'O teste falha porque o cache não expira depois de uma reabertura. Vou corrigir a regra de expiração.' ,
      tools: [{ name: 'exec', detail: 'apply_patch *** Begin Patch\n*** Update File: packages/web/src/lib/chatFeed.ts', ref: 'x4' }] },
    { role: 'assistant', at: at(1052), text: '', tools: [
      { name: 'exec', detail: 'bun test packages/web/src/lib/chatFeed.test.ts', ref: 'x5' },
      { name: 'exec', detail: 'git diff --stat', ref: 'x6' },
    ] },
    { role: 'assistant', at: at(1070), text: 'Corrigido: `chatFeed.ts` agora expira o cache numa reabertura e o teste passa.' },
  ],
}

export const GEMINI: Scenario = {
  harness: 'gemini', title: 'Gemini CLI',
  turns: [
    { role: 'user', at: at(2000), text: 'Pesquisa como outros apps resumem chamadas de ferramenta e salva o que achar.' },
    { role: 'assistant', at: at(2004), text: '', tools: [
      { name: 'read_file', canonical: 'Read', detail: 'docs/sessions-web.md', ref: 'g1' },
      { name: 'grep_search', canonical: 'Grep', detail: 'WorkingNote', ref: 'g2' },
      { name: 'google_web_search', detail: 'chat UI collapse tool calls summary', ref: 'g3' },
      { name: 'web_fetch', detail: 'https://example.com/agent-ui-patterns', ref: 'g4' },
    ] },
    { role: 'assistant', at: at(2050), text: '', pending: true, tools: [
      { name: 'write_file', canonical: 'Write', detail: 'notes/tool-summary-research.md', ref: 'g5' },
      { name: 'run_shell_command', canonical: 'Bash', detail: 'wc -l notes/tool-summary-research.md', ref: 'g6' },
      { name: 'save_memory', detail: 'Tool-call summaries: one line per run', ref: 'g7' },
    ] },
  ],
}

export const SCENARIOS = [CLAUDE, CODEX, GEMINI]
