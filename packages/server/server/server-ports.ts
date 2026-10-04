/**
 * server-ports.ts — which ports THIS data dir's server listens on, recorded by the server itself.
 *
 * A CLI command that bounces the server (`agentop experimental enable|disable`) used to find "the
 * local server" by asking `$PORT`, default 47291. From an instance with its own data dir (a preview
 * with an isolated HOME, a second instance) run without `PORT`, that is somebody ELSE's server: the
 * command then started a new server on the default port, which found the owner's server there and
 * exited. The server of a data dir is the holder of its `server.lock`; this file says which ports
 * that holder listens on, so the bounce restarts it — on its own ports — and nothing else.
 *
 * Its env cannot be read from `/proc/<pid>/environ`: Bun marks its processes non-dumpable (the same
 * reason `lsof` cannot name their sockets), so the server writes the fact down at boot.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface RecordedPorts { pid: number; port: number; webPort: number }

export const SERVER_PORTS_FILE = join('run', 'server-ports.json')

export async function recordServerPorts(dataDir: string, ports: RecordedPorts): Promise<void> {
  const file = join(dataDir, SERVER_PORTS_FILE)
  await mkdir(join(dataDir, 'run'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${ports.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(ports)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, file)
}

export async function readServerPorts(dataDir: string): Promise<RecordedPorts | null> {
  try {
    const v = JSON.parse(await readFile(join(dataDir, SERVER_PORTS_FILE), 'utf-8')) as Partial<RecordedPorts>
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
    return ok(v.pid) && ok(v.port) && ok(v.webPort) ? { pid: v.pid, port: v.port, webPort: v.webPort } : null
  } catch {
    return null
  }
}

/**
 * PURE. Which server a config bounce acts on, from THIS data dir's facts only:
 *  - no lock holder → none (never "whatever answers on the default port");
 *  - a holder whose recorded ports are known → those ports;
 *  - a holder with no (or a stale) record → the CLI's own ports (the pre-record behaviour), marked so.
 */
export function bounceTarget(o: { lockHolder: number | null; recorded: RecordedPorts | null; cliPort: number; cliWebPort: number }):
  | { kind: 'none' }
  | { kind: 'server'; pid: number; port: number; webPort: number; fromRecord: boolean } {
  if (o.lockHolder === null) return { kind: 'none' }
  if (o.recorded && o.recorded.pid === o.lockHolder) {
    return { kind: 'server', pid: o.lockHolder, port: o.recorded.port, webPort: o.recorded.webPort, fromRecord: true }
  }
  return { kind: 'server', pid: o.lockHolder, port: o.cliPort, webPort: o.cliWebPort, fromRecord: false }
}

/**
 * PURE. Is this data dir the owner's own store (`~/.agentistics` of the ACCOUNT's home)? Only that
 * store's server is the one the installed service unit runs; any other data dir must never bounce it.
 */
export function isOwnersStore(dataDir: string, ownerHome: string): boolean {
  return resolve(dataDir) === resolve(join(ownerHome, '.agentistics'))
}
