/**
 * fake-structured-agent.ts — a protocol PEER for `structured-durable.test.ts`: one JSON value per line
 * on stdin/stdout, like every structured protocol. `init` answers a session id; `prompt` streams its
 * reply as `{chunk}` lines and then answers the request. A prompt starting with `slow` streams ten
 * chunks 80 ms apart (a turn long enough to restart the server in the middle of). Every prompt it
 * RECEIVES is appended to `$AGENT_LOG`, so a test can count deliveries.
 */
import { appendFileSync } from 'node:fs'

const log = process.env.AGENT_LOG
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let buf = ''
let chain: Promise<void> = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    let m: { id?: number; method?: string; text?: string }
    try { m = JSON.parse(line) } catch { continue }
    chain = chain.then(async () => {
      if (m.method === 'init') { out({ id: m.id, result: { sid: 'conv-fake-1' } }); return }
      if (m.method === 'prompt') {
        const text = m.text ?? ''
        if (log) appendFileSync(log, `${text}\n`)
        if (text.startsWith('slow')) {
          for (let i = 0; i < 10; i++) { out({ chunk: `c${i} ` }); await sleep(80) }
        } else out({ chunk: `echo:${text}` })
        out({ id: m.id, result: 'end_turn' })
      }
    })
  }
})
process.stdin.on('end', () => process.exit(0))
