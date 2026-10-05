/**
 * scripts/perf/synth-home.ts — a SYNTHETIC machine home for the perf baseline and budgets (PERF.1).
 *
 * No byte of it comes from a real machine: the projects, prompts, tool calls and answers are generated
 * from a fixed seed, in Claude Code's transcript format (`~/.claude/projects/<slug>/<uuid>.jsonl`), with
 * the SHAPE of a heavy user's machine: many projects, most sessions small, a tail of very long ones
 * (the largest transcripts on the reference machine are 20–36 MB).
 *
 * Usage: bun scripts/perf/synth-home.ts <dest> [--projects 160] [--sessions 480] [--big 2] [--big-mb 70] [--scale 1]

 * Calibrated on the reference machine's METADATA only (counts and sizes, never content): 483 main
 * transcripts, 1.8 GB, size p50 1.9 MB / p90 8.3 MB / max 71 MB. Each session draws a target size from
 * a log-normal with that p50 and p90 (capped at 40 MB), plus `--big` sessions of `--big-mb`.
 * `--scale 0.1` builds a tenth of it (the CI budgets).
 *
 * `--git` puts each project in a REAL git repository under `<dest>/repos/` (one commit, an `origin`
 * remote), so what a build spends on git per project is measured too — the rebuild storm's load test
 * (`storm.ts`) needs it; without it every git call fails at once and costs nothing.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const dest = args[0]
if (!dest || dest.startsWith('-')) { console.error('usage: synth-home.ts <dest> [--projects n] [--sessions n] [--big n] [--big-mb n]'); process.exit(2) }
const opt = (name: string, d: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : d }
const SCALE = opt('scale', 1)
const PROJECTS = Math.max(1, Math.round(opt('projects', 160) * Math.min(1, SCALE * 2))), SESSIONS = Math.max(2, Math.round(opt('sessions', 480) * SCALE)), BIG = opt('big', 2), BIG_MB = opt('big-mb', 70) * Math.min(1, SCALE * 2)
const GIT = args.includes('--git')
const MB = 1024 * 1024
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
/** Log-normal: median 1.9 MB, p90 8.3 MB (σ = ln(8.3/1.9)/1.2816). */
const targetSize = () => Math.min(40 * MB, Math.exp(Math.log(1.9 * MB) + gauss() * (Math.log(8.3 / 1.9) / 1.2816))) * SCALE

// mulberry32: a fixed seed, so two runs build the same home.
let seed = 0x5eed
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
const WORDS = 'the a function test refactor module cache server client parse render stream query index file line error value config build route event token model session project branch commit review fix add remove update check'.split(' ')
const text = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Write'] as const
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']

function* turns(sessionId: string, cwd: string, start: number, count: number, bodyWords: number) {
  let parent: string | null = null
  let t = start
  const model = pick(MODELS)
  for (let i = 0; i < count; i++) {
    const base = { sessionId, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false }
    const u = uuid()
    yield { ...base, type: 'user', uuid: u, parentUuid: parent, timestamp: new Date((t += 20_000)).toISOString(), message: { role: 'user', content: text(8 + Math.floor(rnd() * 30)) } }
    parent = u
    const tools = Math.floor(rnd() * 4)
    for (let k = 0; k < tools; k++) {
      const a = uuid(), id = `toolu_${hex(20)}`, name = pick(TOOLS)
      yield { ...base, type: 'assistant', uuid: a, parentUuid: parent, timestamp: new Date((t += 3000)).toISOString(), requestId: `req_${hex(16)}`,
        message: { id: `msg_${hex(16)}`, role: 'assistant', model, type: 'message', content: [{ type: 'tool_use', id, name, input: { file_path: `${cwd}/src/${pick(WORDS)}.ts`, command: name === 'Bash' ? `bun test ${pick(WORDS)}` : undefined } }],
          usage: { input_tokens: 5 + Math.floor(rnd() * 50), output_tokens: 50 + Math.floor(rnd() * 400), cache_read_input_tokens: 20000 + Math.floor(rnd() * 80000), cache_creation_input_tokens: Math.floor(rnd() * 3000) } } }
      const r = uuid()
      yield { ...base, type: 'user', uuid: r, parentUuid: a, timestamp: new Date((t += 2000)).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text(bodyWords) }] }, toolUseResult: { stdout: '', stderr: '' } }
      parent = r
    }
    const a = uuid()
    yield { ...base, type: 'assistant', uuid: a, parentUuid: parent, timestamp: new Date((t += 8000)).toISOString(), requestId: `req_${hex(16)}`,
      message: { id: `msg_${hex(16)}`, role: 'assistant', model, type: 'message', content: [{ type: 'text', text: text(30 + Math.floor(rnd() * 120)) }],
        usage: { input_tokens: 5, output_tokens: 100 + Math.floor(rnd() * 900), cache_read_input_tokens: 30000 + Math.floor(rnd() * 90000), cache_creation_input_tokens: Math.floor(rnd() * 5000) } } }
    parent = a
  }
}

const projectsDir = join(dest, '.claude', 'projects')
const now = Date.parse('2026-10-01T00:00:00Z')
let files = 0, bytes = 0
const bigTargets = new Set(Array.from({ length: BIG }, (_, i) => Math.floor((i + 0.5) * (SESSIONS / Math.max(1, BIG)))))
for (let s = 0; s < SESSIONS; s++) {
  const p = s % PROJECTS
  const cwd = GIT ? join(dest, 'repos', `project-${String(p).padStart(3, '0')}`) : `/home/perf/work/project-${String(p).padStart(3, '0')}`
  if (GIT && s < PROJECTS) {
    await mkdir(cwd, { recursive: true })
    const env = { ...process.env, GIT_AUTHOR_NAME: 'perf', GIT_AUTHOR_EMAIL: 'perf@x', GIT_COMMITTER_NAME: 'perf', GIT_COMMITTER_EMAIL: 'perf@x' }
    delete env.GIT_DIR
    const g = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env, stdio: 'ignore' })
    await writeFile(join(cwd, 'README.md'), `project ${p}\n`)
    g('init', '-q', '-b', 'main'); g('add', '.'); g('commit', '-qm', 'init'); g('remote', 'add', 'origin', `https://github.com/perf/project-${p}.git`)
  }
  const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  const id = uuid()
  const start = now - Math.floor(rnd() * 180) * 86_400_000
  const big = bigTargets.has(s)
  const target = big ? BIG_MB * MB : Math.max(4096, targetSize())
  const lines: string[] = []
  let size = 0
  for (const ev of turns(id, cwd, start, 1_000_000, 300)) { const l = JSON.stringify(ev); lines.push(l); size += l.length + 1; if (size > target) break }
  await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
  files++; bytes += size
  if (big) console.log(`big session ${id} in ${cwd}: ${(size / 1048576).toFixed(1)} MB, ${lines.length} lines`)
}
await mkdir(join(dest, '.agentistics'), { recursive: true })
console.log(`synthetic home at ${dest}: ${files} transcripts, ${(bytes / 1048576).toFixed(0)} MB, ${PROJECTS} projects`)
