/**
 * DOCKER.AMBIENTES S2 — the egress proxy (SPEC-r3 §3.6): the ONLY way out of a `--network none` container.
 *
 * It listens on a fresh unix socket the download container has mounted (its forwarder exposes it on
 * 127.0.0.1:3128 inside). For each connection it reads ONE request line + headers, resolves the host ON THE HOST,
 * asks the pure `egressDecision` (CONNECT to an allowed registry on 443, every resolved address public and not
 * the host's), and connects to the CHECKED address — never re-resolving. A refusal answers 403 with the reason.
 * The journal records host, port, decision and reason; never content. It dies with the launcher (child of it).
 */
import { createServer, connect, type Server, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { appendFileSync, chmodSync, rmSync } from 'node:fs'
import { connectTarget, egressDecision } from './egress-policy'

export interface EgressOptions {
  socketPath: string
  allow: readonly string[]
  journal?: string
  resolve?: (host: string) => Promise<string[]>
  hostAddresses?: () => string[]
  /** Tests: where an allowed CONNECT really goes (default: the checked ip:443). */
  connectTo?: (ip: string, port: number) => Socket
}

/** Every address of every interface (bridges included: docker0's gateway is one of them), read at decision time. */
export function hostAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.push(a.address.split('%')[0]!)
  return out
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map(a => a.address)

export function startEgressProxy(o: EgressOptions): Promise<Server> {
  const note = (host: string, port: number | string, decision: string, reason: string) => {
    if (o.journal) try { appendFileSync(o.journal, JSON.stringify({ at: new Date().toISOString(), host, port, decision, reason }) + '\n', { mode: 0o600 }) } catch {}
  }
  const server = createServer(c => {
    let buf = Buffer.alloc(0)
    const refuse = (reason: string) => { try { c.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`) } catch {} }
    const onData = async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length > 8192) { c.off('data', onData); note('?', '?', 'refuse', 'header too large'); return refuse('header too large') }
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      c.off('data', onData)
      c.pause()
      const line = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1')
      const target = connectTarget(line)
      const host = 'host' in target ? target.host : '?'
      const port = 'port' in target ? target.port : '?'
      let resolved: string[] = []
      if ('host' in target && /^[a-z0-9.-]+$/.test(target.host)) { try { resolved = await (o.resolve ?? defaultResolve)(target.host) } catch { resolved = [] } }
      const d = egressDecision({ requestLine: line, allow: o.allow, resolved, hostAddresses: (o.hostAddresses ?? hostAddresses)() })
      if (!d.allow) { note(String(host), port, 'refuse', d.reason); return refuse(d.reason) }
      note(d.host, 443, 'allow', d.ip)
      const up = (o.connectTo ?? ((ip, p) => connect({ host: ip, port: p })))(d.ip, 443)
      up.once('connect', () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n')
        const rest = buf.subarray(end + 4)
        if (rest.length) up.write(rest)
        c.pipe(up); up.pipe(c); c.resume()
      })
      up.on('error', () => c.destroy()); c.on('error', () => up.destroy())
      up.on('close', () => c.destroy()); c.on('close', () => up.destroy())
    }
    c.on('data', onData)
    c.on('error', () => {})
  })
  rmSync(o.socketPath, { force: true })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.socketPath, () => { try { chmodSync(o.socketPath, 0o600) } catch {}; resolve(server) })
  })
}
