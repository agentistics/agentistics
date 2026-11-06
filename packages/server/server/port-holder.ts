/**
 * port-holder.ts — WHO holds a port this server could not bind, said in the refusal.
 *
 * The refusal used to say "already in use by another agentop server" for every EADDRINUSE. That is
 * an assumption, and on 2026-11-06 it was false: both macOS runners of a release's clean-install
 * E2E refused :49191 while THIS server held the data-dir lock — so no other agentop server could
 * exist — and the log gave nobody anything to look at. The port sat inside macOS's ephemeral range
 * (49152-65535), where any process can be handed it for an outbound connection.
 *
 * So the refusal now names the holder when the system can say (`lsof` on macOS and most Linux,
 * `ss` otherwise), says agentop only when the holder IS agentop, and says it could not tell when
 * it could not — never a guess in either direction.
 */

export interface PortHolder { pid: number; command: string; listening: boolean }

/** PURE. `lsof -nP -iTCP:<port> -FpcT` → the first process holding the port (a listener first). */
export function parseLsofHolders(raw: string): PortHolder[] {
  const out: PortHolder[] = []
  let cur: PortHolder | null = null
  for (const line of raw.split('\n')) {
    const tag = line[0], value = line.slice(1)
    if (tag === 'p') { cur = { pid: Number(value), command: '', listening: false }; if (Number.isInteger(cur.pid) && cur.pid > 0) out.push(cur) }
    else if (tag === 'c' && cur) cur.command = value
    else if (tag === 'T' && cur && value === 'ST=LISTEN') cur.listening = true
  }
  return out.sort((a, b) => Number(b.listening) - Number(a.listening))
}

/** PURE. `ss -Htanp sport = :<port>` → the processes it names (`users:(("name",pid=N,fd=M))`). */
export function parseSsHolders(raw: string): PortHolder[] {
  const out: PortHolder[] = []
  for (const line of raw.split('\n')) {
    const listening = /^\s*LISTEN\b/.test(line)
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) out.push({ command: m[1]!, pid: Number(m[2]), listening })
  }
  return out.sort((a, b) => Number(b.listening) - Number(a.listening))
}

/** PURE. The port a Bun listen error names (`Is port 47292 in use?`), else the one we tried first. */
export function portOfListenError(message: string, fallback: number): number {
  const m = /port (\d+)/i.exec(message) ?? /:(\d+)\b/.exec(message)
  return m ? Number(m[1]) : fallback
}

/** PURE. The refusal sentence. `holder` undefined = nothing could be asked; null = asked, none named. */
export function portHeldSentence(port: number, holder: PortHolder | null | undefined): string {
  if (holder === undefined) return `Port ${port} is already in use (could not ask the system which process holds it)`
  if (holder === null) {
    return `Port ${port} is already in use, and no process on this machine is named as holding it ` +
      '(an outbound connection from the system\'s ephemeral port range can hold it briefly)'
  }
  const who = /agentop/i.test(holder.command)
    ? `another agentop server (pid ${holder.pid})`
    : `${holder.command || 'a process'} (pid ${holder.pid}), not an agentop server`
  return `Port ${port} is already in use by ${who}`
}

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => p.kill(), 3_000)
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    clearTimeout(timer)
    return { code, stdout }
  } catch {
    return { code: 127, stdout: '' }
  }
}

/** IO. Who holds `port`, other than this process. undefined when neither lsof nor ss could be run. */
export async function findPortHolder(port: number): Promise<PortHolder | null | undefined> {
  const notMe = (h: PortHolder) => h.pid !== process.pid
  const lsof = await run(['lsof', '-nP', `-iTCP:${port}`, '-FpcT'])
  if (lsof.code !== 127) return parseLsofHolders(lsof.stdout).find(notMe) ?? null
  const ss = await run(['ss', '-Htanp', `sport = :${port}`])
  if (ss.code !== 127) return parseSsHolders(ss.stdout).find(notMe) ?? null
  return undefined
}
