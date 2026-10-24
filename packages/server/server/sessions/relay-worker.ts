/** Replaceable relay protocol logic. The keeper alone owns sockets, the child and durable writes;
 * a prepared worker reads the same journals, so replacing it requires no volatile cursor transfer. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInRecord, parseJsonl, type InRecord } from './structured-replay'

export interface RelayDecision { messages: unknown[]; write?: string; record?: boolean }

export function relayDecision(dir: string, msg: Record<string, unknown>, out?: string): RelayDecision {
  if (msg.hello && typeof msg.hello === 'object') {
    const from = Math.max(0, Number((msg.hello as { from?: unknown }).from) || 0)
    const recs = (out ?? readFileSync(join(dir, 'out.jsonl'), 'utf8')).split('\n').filter(Boolean)
    return { messages: recs.slice(from).flatMap(r => {
      try { const { t, l } = JSON.parse(r); return [{ o: l, t }] } catch { return [] }
    }) }
  }
  if (typeof msg.w === 'string') {
    if (typeof msg.replayAt === 'number') {
      const written = parseJsonl<InRecord>(readFileSync(join(dir, 'in.jsonl'), 'utf8'), isInRecord).map(r => r.w).join('')
      const at = msg.replayAt
      if (!Number.isSafeInteger(at) || at < 0 || at > written.length
        || (at < written.length && !written.startsWith(msg.w, at))) {
        return { messages: [{ replayError: 'the re-created driver diverged from the relay input record' }] }
      }
      if (at < written.length) return { messages: [{ replayAck: true }] }
    }
    return { write: msg.w, record: true, messages: typeof msg.replayAt === 'number' ? [{ replayAck: true }] : [] }
  }
  return { messages: [] }
}

export function runRelayWorker(): void {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      const msg = JSON.parse(line)
      try {
        const result = msg.method === 'ready' ? true : relayDecision(msg.params.dir, msg.params.message, msg.params.out)
        process.stdout.write(`${JSON.stringify({ id: msg.id, result })}\n`)
      } catch { process.stdout.write(`${JSON.stringify({ id: msg.id, error: 'relay decision failed' })}\n`) }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
