import { IdleSwap, JsonWorker, executableVersion, runningExecutableVersion, helperCommand, swapLog, type Message } from './helper-hotswap'

/** Own only the harness's pipes and JSON framing. The MCP SDK/catalogue live in a replaceable child.
 * Replaying initialize into a candidate restores the SDK state without a second host handshake. */
export function runMcpForwarder(pollMs = 5000): void {
  let initialize: Message | undefined
  let initialized = false
  const requests = new Map<string, () => void>()
  const worker = (): JsonWorker => {
    const w = new JsonWorker(helperCommand('mcp'), { ...process.env, AGENTOP_MCP_WORKER: '1' })
    w.onmessage = message => {
      if (w !== swap.current) return
      if (message.method && message.id !== undefined) requests.set(`server:${JSON.stringify(message.id)}`, swap.enter())
      process.stdout.write(`${JSON.stringify(message)}\n`, () => {
        if (!message.method && message.id !== undefined) {
          requests.get(`client:${JSON.stringify(message.id)}`)?.(); requests.delete(`client:${JSON.stringify(message.id)}`)
        }
      })
    }
    w.onerror = error => {
      if (w === swap.current) { console.error('[agentop mcp] worker connection lost:', error.message); process.exit(1) }
    }
    return w
  }
  const swap = new IdleSwap(worker(), runningExecutableVersion(), {
    version: executableVersion,
    prepare: async () => {
      if (!initialize || !initialized) throw new Error('waiting for MCP initialization')
      const w = worker()
      try {
        const response = await w.request('initialize', initialize.params)
        if (response.error) throw new Error('replacement rejected MCP initialize')
        w.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        return w
      } catch (error) { w.close(); throw error }
    },
    close: w => w.close(), usable: w => w.healthy, log: swapLog,
  })
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      let message: Message
      try { message = JSON.parse(line) as Message }
      catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue }
      if (message.method === 'initialize') initialize = message
      if (message.method === 'notifications/initialized') initialized = true
      if (message.method && message.id !== undefined) requests.set(`client:${JSON.stringify(message.id)}`, swap.enter())
      // Queue the response before releasing the server's request: idle cannot precede this write.
      swap.current.send(message)
      if (!message.method && message.id !== undefined) {
        requests.get(`server:${JSON.stringify(message.id)}`)?.(); requests.delete(`server:${JSON.stringify(message.id)}`)
      }
    }
  })
  const timer = setInterval(() => { if (initialized) void swap.check() }, pollMs)
  const stop = (): void => { clearInterval(timer); swap.close() }
  process.stdin.on('end', () => { stop(); process.exit(0) })
  process.on('exit', stop)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stop(); process.exit(0) })
}
