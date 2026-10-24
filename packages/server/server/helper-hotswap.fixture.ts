/** Compiled by the hot-swap integration tests; never used by the application. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMcpForwarder } from './mcp-forwarder'
import { runRelay } from './sessions/structured-relay'
import { relayDecision } from './sessions/relay-worker'

declare const FIXTURE_VERSION: string
const command = process.argv[2]
if (command === '__structured-relay') runRelay(process.argv[3]!, 30)
else if (command === 'mcp' && process.env.AGENTOP_MCP_WORKER !== '1') runMcpForwarder(30)
else {
  let buf = '', initialized = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
      if (command === '__relay-worker') {
        if (msg.method === 'ready') reply(true)
        else {
          const result = relayDecision(msg.params.dir, msg.params.message, msg.params.out)
          result.messages.push({ version: FIXTURE_VERSION })
          if (msg.params.message.hello && process.env.FIXTURE_REPLAY_DELAY) {
            setTimeout(() => reply(result), Number(process.env.FIXTURE_REPLAY_DELAY))
          } else reply(result)
        }
      } else if (msg.method === 'initialize') {
        if (process.env.FIXTURE_DIR) writeFileSync(join(process.env.FIXTURE_DIR, `initialized-${FIXTURE_VERSION}`), '')
        reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: FIXTURE_VERSION } })
      } else if (msg.method === 'notifications/initialized') initialized = true
      else if (msg.id !== undefined) {
        if (msg.params?.delay) {
          writeFileSync(join(process.env.FIXTURE_DIR!, 'request-started'), '')
          setTimeout(() => reply({ version: FIXTURE_VERSION, initialized }), msg.params.delay)
        } else reply({ version: FIXTURE_VERSION, initialized })
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
