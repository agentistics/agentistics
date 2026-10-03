/**
 * scripts/perf/fake-claude.ts — a stand-in `claude` for the perf baseline (PERF.1). It behaves like the
 * harness where the server can see it, and nowhere else:
 *
 * - it takes `--session-id <uuid>` and writes `$HOME/.claude/projects/<cwd slug>/<uuid>.jsonl`;
 * - each line typed into its terminal (tmux send-keys) is appended AT ONCE as a user turn;
 * - the answer is printed to the terminal word by word over `FAKE_STREAM_MS` (the in-flight text the
 *   chat scrapes), then appended as an assistant turn.
 *
 * Every turn carries the epoch ms it was written (`writtenAt=<ms>`), so the baseline can measure
 * "harness wrote it" → "the chat shows it" without a clock shared with anything else.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const i = process.argv.indexOf('--session-id')
const sessionId = i >= 0 ? process.argv[i + 1]! : randomUUID()
const cwd = process.cwd()
const dir = join(process.env.HOME!, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })
const file = join(dir, `${sessionId}.jsonl`)
// A long session: start from an existing transcript's history (the baseline's "open a long session").
// The seed is named by a `.fake-seed` file in the cwd (the tmux server's env is fixed at its start).
const seedRef = join(cwd, '.fake-seed')
if (existsSync(seedRef) && !existsSync(file)) appendFileSync(file, readFileSync(readFileSync(seedRef, 'utf8').trim()))
const STREAM_MS = Number(process.env.FAKE_STREAM_MS ?? 1500)
let parent: string | null = null
const base = { sessionId, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false }
function write(type: 'user' | 'assistant', content: string) {
  const uuid = randomUUID()
  const message = type === 'user' ? { role: 'user', content } : { id: `msg_${uuid.slice(0, 8)}`, role: 'assistant', model: 'claude-sonnet-5-5', type: 'message', content: [{ type: 'text', text: content }], usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } }
  appendFileSync(file, JSON.stringify({ ...base, type, uuid, parentUuid: parent, timestamp: new Date().toISOString(), message }) + '\n')
  parent = uuid
}
process.stdout.write('\x1b[1m✻ fake claude\x1b[0m ready\n> ')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    write('user', `${line} writtenAt=${Date.now()}`)
    const words = `answer to ${line.slice(0, 40)} ${'lorem ipsum dolor sit amet '.repeat(6)}`.split(' ')
    process.stdout.write('\n● ')
    for (const w of words) { process.stdout.write(`${w} `); await Bun.sleep(STREAM_MS / words.length) }
    write('assistant', `${words.join(' ')} writtenAt=${Date.now()}`)
    process.stdout.write('\n> ')
  }
})
