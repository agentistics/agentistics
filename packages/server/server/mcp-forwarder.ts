import { IdleSwap, JsonWorker, executableVersion, runningExecutableVersion, helperCommand, swapLog, RequestLeases, type Message } from './helper-hotswap'

/** Own only the harness's pipes and JSON framing. The MCP SDK/catalogue live in a replaceable child.
 * Replaying initialize into a candidate restores the SDK state without a second host handshake. */
export function runMcpForwarder(pollMs = 5000): void {
  let initialize: Message | undefined
  let initialized = false
  const requests = new RequestLeases(() => swap.enter())
  const worker = (): JsonWorker => {
    const w = new JsonWorker(helperCommand('mcp'), { ...process.env, AGENTOP_MCP_WORKER: '1' })
    w.onmessage = message => {
      if (w !== swap.current) return
      if (message.method && message.id !== undefined) requests.start(`server:${JSON.stringify(message.id)}`)
      process.stdout.write(`${JSON.stringify(message)}\n`, () => {
        if (message.method === 'notifications/cancelled') requests.finish(`server:${JSON.stringify(message.params?.requestId)}`)
        if (!message.method && message.id !== undefined) {
          requests.finish(`client:${JSON.stringify(message.id)}`)
        }
      })
    }
    w.onerror = error => {
      if (w !== swap.current) return
      console.error('[agentop mcp] worker connection lost:', error.message)
      // A tool might already have had effects. Fail its outstanding RPC instead of replaying it.
      for (const key of requests.clear()) {
        if (key.startsWith('client:')) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(key.slice(7)), error: { code: -32603, message: 'MCP worker restarted; request outcome unknown' } })}\n`)
      }
      void swap.recover()
    }
    return w
  }
  const swap = new IdleSwap(worker(), runningExecutableVersion(), {
    version: executableVersion,
    prepare: async () => {
      const w = worker()
      try {
        if (initialize) {
          const response = await w.request('initialize', initialize.params)
          if (response.error) throw new Error('replacement rejected MCP initialize')
          if (initialized) w.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        }
        return w
      } catch (error) { w.close(); throw error }
    },
    close: w => w.close(), usable: w => w.healthy, log: swapLog,
  })
  let buf = ''
  let queue = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      let message: Message
      try { message = JSON.parse(line) as Message }
      catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); continue }
      queue = queue.then(async () => {
        await swap.recover()
        if (message.method === 'initialize') initialize = message
        if (message.method === 'notifications/initialized') initialized = true
        if (message.method && message.id !== undefined) requests.start(`client:${JSON.stringify(message.id)}`)
        // Deliver cancellation before releasing its lease, so an idle swap cannot eat it.
        swap.current.send(message)
        if (message.method === 'notifications/cancelled') requests.finish(`client:${JSON.stringify(message.params?.requestId)}`)
        if (!message.method && message.id !== undefined) requests.finish(`server:${JSON.stringify(message.id)}`)
      }).catch(error => { swapLog(error); void swap.recover() })
    }
  })
  const timer = setInterval(() => { requests.expire(); if (initialized) void swap.check() }, pollMs)
  const stop = (): void => { clearInterval(timer); swap.close() }
  process.stdin.on('end', () => { stop(); process.exit(0) })
  process.on('exit', stop)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stop(); process.exit(0) })
}
