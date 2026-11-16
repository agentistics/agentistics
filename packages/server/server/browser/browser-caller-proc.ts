/**
 * browser-caller-proc.ts — the Linux readers behind `browser-caller.ts` (IO). Every reader answers
 * `null` rather than throwing, and `null` is what makes the pure classifier fail CLOSED.
 *
 * Cost: one request reads the two TCP tables and walks our own processes' fd links once — only on the
 * person-only routes (the padlock, the input socket's upgrade), which a person hits a few times a minute.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { classifyCaller, parseProcNetTcp, type CallerVerdict, type ProcLink, type SockRow } from './browser-caller'

const MAX_DEPTH = 64

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

export function readSockets(): SockRow[] | null {
  const v4 = read('/proc/net/tcp')
  const v6 = read('/proc/net/tcp6')
  if (v4 === null && v6 === null) return null
  return [...(v4 ? parseProcNetTcp(v4, false) : []), ...(v6 ? parseProcNetTcp(v6, true) : [])]
}

function numericDirs(): number[] {
  try { return readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number) } catch { return [] }
}

/** The process holding `socket:[inode]` (only our own processes' fds are readable — which is the point). */
export function pidOfInode(inode: number): number | null {
  const want = `socket:[${inode}]`
  for (const pid of numericDirs()) {
    let fds: string[]
    try { fds = readdirSync(`/proc/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      try { if (readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return pid } catch { /* fd closed meanwhile */ }
    }
  }
  return null
}

function ppidOf(pid: number): number | null {
  const stat = read(`/proc/${pid}/stat`)
  if (!stat) return null
  // `pid (comm) state ppid …` — comm may contain spaces and parentheses: cut after the LAST ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(rest[1])
  return Number.isInteger(ppid) ? ppid : null
}

export function managedIdOf(pid: number): string | null {
  const env = read(`/proc/${pid}/environ`)
  if (!env) return null
  for (const kv of env.split('\0')) if (kv.startsWith('AGENTOP_MANAGED_ID=')) return kv.slice(19) || null
  return null
}

function isInterop(pid: number): boolean {
  try { return readlinkSync(`/proc/${pid}/exe`) === '/init' } catch { return false }
}

/** The caller and its ancestors, nearest first. `null` when the caller itself cannot be read. */
export function ancestry(pid: number): ProcLink[] | null {
  if (ppidOf(pid) === null) return null
  const chain: ProcLink[] = []
  const seen = new Set<number>()
  let cur: number | null = pid
  while (cur !== null && cur > 0 && !seen.has(cur) && chain.length < MAX_DEPTH) {
    seen.add(cur)
    chain.push({ pid: cur, managedId: managedIdOf(cur), interop: isInterop(cur) })
    if (cur === 1) break
    cur = ppidOf(cur)
  }
  return chain
}

/** Some interop proxy (a Windows program run from Linux) carries a session's identity right now. */
export function sessionInterop(): boolean {
  const uid = process.getuid?.()
  for (const pid of numericDirs()) {
    if (pid === 1 || !isInterop(pid)) continue
    if (uid !== undefined) {
      const status = read(`/proc/${pid}/status`)
      const m = status ? /^Uid:\s+(\d+)/m.exec(status) : null
      if (!m || Number(m[1]) !== uid) continue
    }
    if (managedIdOf(pid)) return true
  }
  return false
}

export function isWsl(): boolean {
  const rel = read('/proc/sys/kernel/osrelease')
  return !!rel && /microsoft|wsl/i.test(rel)
}

export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.push(a.address)
  return out
}

/** Classify the caller of one request on this machine. Off Linux every local caller is `unknown`. */
export function identifyCaller(input: {
  peer: { address: string; port: number } | null
  serverPorts: readonly number[]
  sessionPids?: ReadonlySet<number>
}): CallerVerdict {
  const linux = process.platform === 'linux'
  return classifyCaller({
    peer: input.peer,
    serverPorts: input.serverPorts,
    localAddresses: localAddresses(),
    sockets: () => (linux ? readSockets() : null),
    ourUid: process.getuid?.() ?? -1,
    pidOfInode,
    ancestry,
    serverPid: process.pid,
    sessionPids: input.sessionPids ?? new Set(),
    wsl: linux && isWsl(),
    sessionInterop,
  })
}
