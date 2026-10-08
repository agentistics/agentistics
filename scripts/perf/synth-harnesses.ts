/**
 * scripts/perf/synth-harnesses.ts — the NON-Claude half of a synthetic machine home (PERF.1 step 1).
 *
 * `synth-home.ts` writes Claude Code's transcripts; this adds Codex rollouts, Gemini chats and Copilot
 * session-state beside them, so a build measured on the fixture pays for every harness reader the way
 * a real heavy machine does. Nothing comes from a real machine: content is generated from a fixed
 * seed, in each CLI's own on-disk shape (the same shapes the adapters' parse tests use).
 *
 * Usage: bun scripts/perf/synth-harnesses.ts <home> [--codex 300] [--codex-kb 400] [--gemini 30] [--copilot 20]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const home = args[0]
if (!home || home.startsWith('-')) { console.error('usage: synth-harnesses.ts <home> [--codex n] [--codex-kb n] [--gemini n] [--copilot n]'); process.exit(2) }
const opt = (name: string, d: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : d }
const CODEX = opt('codex', 300), CODEX_KB = opt('codex-kb', 400), GEMINI = opt('gemini', 30), COPILOT = opt('copilot', 20)

let seed = 0xc0dec
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
const WORDS = 'the a function test refactor module cache server client parse render stream query index file line error value config build route event token model session project branch commit review fix add remove update check'.split(' ')
const text = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const PROJECTS = Array.from({ length: 12 }, (_, i) => join(home, 'work', `proj-${i}`))
const BASE = Date.parse('2026-08-01T12:00:00Z')

/** One Codex rollout of roughly `kb` kilobytes, in the envelope format `codex-parse.ts` reads. */
function codexRollout(id: string, start: number, cwd: string, kb: number): string {
  let t = start
  const ts = () => new Date((t += 4000)).toISOString()
  const lines: string[] = [
    JSON.stringify({ timestamp: ts(), type: 'session_meta', payload: { id, timestamp: new Date(start).toISOString(), cwd, model_provider: 'openai' } }),
    JSON.stringify({ timestamp: ts(), type: 'turn_context', payload: { model: 'gpt-5.5', cwd } }),
  ]
  let size = 0, input = 0, cached = 0, output = 0
  while (size < kb * 1024) {
    const msg = text(10 + Math.floor(rnd() * 40))
    const turn = [
      JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: msg } }),
      JSON.stringify({ timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: msg }] } }),
      JSON.stringify({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `rg ${pick(WORDS)} src`, workdir: cwd }) } }),
      JSON.stringify({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', output: text(80 + Math.floor(rnd() * 200)) } }),
      JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'agent_message', message: text(30 + Math.floor(rnd() * 80)) } }),
    ]
    input += 2000 + Math.floor(rnd() * 8000); cached += 1000 + Math.floor(rnd() * 4000); output += 100 + Math.floor(rnd() * 800)
    turn.push(JSON.stringify({ timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input + cached, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 200 }, model_context_window: 272000 } } }))
    for (const l of turn) { lines.push(l); size += l.length + 1 }
  }
  return lines.join('\n') + '\n'
}

function geminiChat(id: string, start: number, turns: number): string {
  let t = start
  const lines = [JSON.stringify({ sessionId: id, projectHash: hex(16), startTime: new Date(start).toISOString(), lastUpdated: new Date(start).toISOString(), kind: 'main' }), JSON.stringify({ $set: { messages: [] } })]
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ id: `u${i}`, timestamp: new Date((t += 5000)).toISOString(), type: 'user', content: [{ text: text(15) }] }))
    lines.push(JSON.stringify({ $set: { lastUpdated: new Date(t).toISOString() } }))
    lines.push(JSON.stringify({ id: `g${i}`, timestamp: new Date((t += 5000)).toISOString(), type: 'gemini', content: text(60), model: 'gemini-3-flash-preview', tokens: { input: 900, output: 120, cached: 300, thoughts: 0, tool: 0, total: 1320 } }))
  }
  return lines.join('\n') + '\n'
}

function copilotEvents(id: string, start: number, cwd: string, turns: number): string {
  let t = start
  const ts = () => new Date((t += 3000)).toISOString()
  const lines = [JSON.stringify({ type: 'session.start', data: { sessionId: id, startTime: new Date(start).toISOString(), context: { cwd, gitRoot: cwd, branch: 'main' } }, timestamp: ts() })]
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user.message', data: { content: text(20) }, timestamp: ts() }))
    lines.push(JSON.stringify({ type: 'assistant.turn_start', data: { turnId: String(i) }, timestamp: ts() }))
    lines.push(JSON.stringify({ type: 'assistant.turn_end', data: { turnId: String(i) }, timestamp: ts() }))
  }
  lines.push(JSON.stringify({ type: 'session.shutdown', data: { shutdownType: 'routine', totalPremiumRequests: 1, totalApiDurationMs: 9000, sessionStartTime: start, codeChanges: { linesAdded: 5, linesRemoved: 1, filesModified: [`${cwd}/a.ts`] }, modelMetrics: { 'gpt-5.4-mini': { requests: { count: turns, cost: 1 }, usage: { inputTokens: 30000, outputTokens: 900, cacheReadTokens: 12000, cacheWriteTokens: 0, reasoningTokens: 10 } } } }, timestamp: ts() }))
  return lines.join('\n') + '\n'
}

let bytes = 0
for (let i = 0; i < CODEX; i++) {
  const start = BASE + i * 3_600_000
  const d = new Date(start)
  const dir = join(home, '.codex', 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'))
  await mkdir(dir, { recursive: true })
  const id = uuid()
  // Log-normal-ish: most rollouts small, a tail of big ones.
  const kb = Math.max(8, Math.round(CODEX_KB * Math.exp((rnd() - 0.5) * 2.5)))
  const body = codexRollout(id, start, pick(PROJECTS), kb)
  bytes += body.length
  await writeFile(join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), body)
}
const projectsJson: Record<string, string> = {}
for (let i = 0; i < GEMINI; i++) {
  const proj = PROJECTS[i % PROJECTS.length]!
  const short = `proj-${i % PROJECTS.length}`
  projectsJson[proj] = short
  const dir = join(home, '.gemini', 'tmp', short, 'chats')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `session-${i}.jsonl`), geminiChat(uuid(), BASE + i * 7_200_000, 5 + Math.floor(rnd() * 30)))
}
if (GEMINI > 0) await writeFile(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: projectsJson }))
for (let i = 0; i < COPILOT; i++) {
  const id = uuid()
  const dir = join(home, '.copilot', 'session-state', id)
  await mkdir(dir, { recursive: true })
  const cwd = pick(PROJECTS)
  await writeFile(join(dir, 'events.jsonl'), copilotEvents(id, BASE + i * 5_000_000, cwd, 4 + Math.floor(rnd() * 20)))
  await writeFile(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nname: ${text(3)}\n`)
}
console.log(`synth-harnesses: ${CODEX} codex rollouts (${(bytes / 1024 / 1024).toFixed(1)} MB), ${GEMINI} gemini chats, ${COPILOT} copilot sessions under ${home}`)
