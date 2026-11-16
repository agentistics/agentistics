/**
 * browser-caller.ts — WHO is calling, read from the SOCKET (NAVEGADOR S4, F1 of the S3 QA).
 *
 * S3 refused a padlock request that CARRIED a session identity, so a session could unlock its own
 * browser by simply leaving the field out (`curl -d '{"owner":…,"lock":"unlocked"}'` from its Bash →
 * 200). The body is the caller's own statement; the socket is not. So the caller is identified by the
 * connection itself:
 *
 *   peer address:port → the client socket in /proc/net/tcp{,6} (its local end = our peer, its remote
 *   port = one of the server's ports) → its inode → the process holding it → that process and every
 *   ancestor up to init.
 *
 * Verdicts (pure; the IO readers are injected — `browser-caller-proc.ts` is the Linux one):
 *  - `session` — some process in the chain carries `AGENTOP_MANAGED_ID` (the variable every managed
 *    pane is started with and `session-proof.ts` reads), IS a managed session's pane/harness pid, or IS
 *    this server (a structured session's harness is the server's own child). Refused.
 *  - `person` — the chain was read to the end and none of the above holds; or the peer is another
 *    machine (not an address of this one — the auth gate already ran); or the WSL localhost relay
 *    (a root-owned socket in a WSL kernel, how the person's Windows browser arrives) while no session
 *    is running a Windows program.
 *  - `unknown` — anything that cannot be established with certainty: no /proc (macOS, Windows), the
 *    socket not in the table, no process holding it, a tree that cannot be read, another user's socket,
 *    or the WSL relay while a session runs a Windows program (`curl.exe` through interop reaches us via
 *    that same relay, indistinguishable from the person's browser). FAIL-CLOSED: refused.
 *
 * STATED LIMITS: a session that detaches a Windows program which outlives its interop proxy (`cmd.exe
 * /c start …`) is not seen; a session that reaches us from ANOTHER machine (ssh out and back) is a remote
 * peer. Both need a deliberate escape, not an omitted field.
 */

export interface SockRow { localAddr: string; localPort: number; remAddr: string; remPort: number; uid: number; inode: number }

/** One process in the chain from the caller up. */
export interface ProcLink {
  pid: number
  /** `AGENTOP_MANAGED_ID` from its environ (null = absent or unreadable). */
  managedId: string | null
  /** A WSL interop proxy (exe `/init`, running a Windows program). */
  interop: boolean
}

export type CallerVerdict =
  | { kind: 'person'; via: 'process'; pid: number }
  | { kind: 'person'; via: 'remote' | 'wsl-relay' }
  | { kind: 'session'; pid: number; managedId: string | null }
  | { kind: 'unknown'; reason: 'no-peer' | 'no-proc' | 'socket-not-found' | 'ambiguous-socket' | 'pid-not-found' | 'tree-unreadable' | 'foreign-uid' | 'wsl-relay-ambiguous' }

export interface CallerInput {
  peer: { address: string; port: number } | null
  /** The ports this server listens on (PORT, WEB_PORT) — the client socket's REMOTE port is one. */
  serverPorts: readonly number[]
  /** This machine's own interface addresses (loopback is always local). */
  localAddresses: readonly string[]
  /** Both TCP tables, or `null` where there is no /proc. Lazy: never read for a remote peer. */
  sockets(): SockRow[] | null
  ourUid: number
  pidOfInode(inode: number): number | null
  /** The caller and its ancestors, nearest first; `null` = unreadable. */
  ancestry(pid: number): ProcLink[] | null
  serverPid: number
  /** Pids of managed sessions (pane / harness) — a second signal beside the environment variable. */
  sessionPids: ReadonlySet<number>
  /** Running in a WSL kernel. */
  wsl: boolean
  /** Is any session running a Windows program right now (an interop proxy carrying a session id)? */
  sessionInterop(): boolean
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; lowercase. */
export function normalizeIp(a: string): string {
  const s = a.trim().toLowerCase()
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  return m ? m[1]! : s
}

function isLoopback(a: string): boolean {
  return a === '::1' || /^127\./.test(a)
}

function hexV4(h: string): string {
  // The kernel prints the 32-bit address in host (little-endian) order.
  const b = [6, 4, 2, 0].map(i => parseInt(h.slice(i, i + 2), 16))
  return b.join('.')
}

function hexV6(h: string): string {
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) {
    const word = h.slice(w * 8, w * 8 + 8)
    for (const i of [6, 4, 2, 0]) bytes.push(parseInt(word.slice(i, i + 2), 16))
  }
  if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.')
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16))
  // Compress the longest run of zero groups (enough for ::1 and friends to compare equal to Bun's form).
  let best = -1, bestLen = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > bestLen) { best = i; bestLen = j - i }
    i = j
  }
  if (bestLen < 2) return groups.join(':')
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`
}

/** PURE: `/proc/net/tcp` (v6=false) or `/proc/net/tcp6` (v6=true) text → rows. */
export function parseProcNetTcp(text: string, v6: boolean): SockRow[] {
  const rows: SockRow[] = []
  const addrLen = v6 ? 32 : 8
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || !/^\d+:$/.test(f[0]!)) continue
    const [la, lp] = f[1]!.split(':')
    const [ra, rp] = f[2]!.split(':')
    if (!la || !lp || !ra || !rp || la.length !== addrLen || ra.length !== addrLen) continue
    const uid = Number(f[7])
    const inode = Number(f[9])
    if (!Number.isInteger(uid) || !Number.isInteger(inode)) continue
    rows.push({
      localAddr: v6 ? hexV6(la) : hexV4(la), localPort: parseInt(lp, 16),
      remAddr: v6 ? hexV6(ra) : hexV4(ra), remPort: parseInt(rp, 16), uid, inode,
    })
  }
  return rows
}

/** PURE (over its injected readers): who is on the other end of this request. */
export function classifyCaller(i: CallerInput): CallerVerdict {
  if (!i.peer || !i.peer.address || !Number.isInteger(i.peer.port)) return { kind: 'unknown', reason: 'no-peer' }
  const peer = normalizeIp(i.peer.address)
  const local = isLoopback(peer) || i.localAddresses.some(a => normalizeIp(a) === peer)
  if (!local) return { kind: 'person', via: 'remote' }

  const sockets = i.sockets()
  if (sockets === null) return { kind: 'unknown', reason: 'no-proc' }
  const mine = sockets.filter(r => normalizeIp(r.localAddr) === peer && r.localPort === i.peer!.port && i.serverPorts.includes(r.remPort))
  if (mine.length === 0) return { kind: 'unknown', reason: 'socket-not-found' }
  if (new Set(mine.map(r => r.inode)).size > 1) return { kind: 'unknown', reason: 'ambiguous-socket' }
  const sock = mine[0]!

  if (sock.uid !== i.ourUid) {
    // The WSL localhost relay is root's; it carries whatever Windows connects — the person's browser,
    // or a session's `curl.exe`. Only the first is acceptable, and only provably.
    if (i.wsl && sock.uid === 0) return i.sessionInterop() ? { kind: 'unknown', reason: 'wsl-relay-ambiguous' } : { kind: 'person', via: 'wsl-relay' }
    return { kind: 'unknown', reason: 'foreign-uid' }
  }

  const pid = i.pidOfInode(sock.inode)
  if (pid === null) return { kind: 'unknown', reason: 'pid-not-found' }
  const chain = i.ancestry(pid)
  if (chain === null || chain.length === 0) return { kind: 'unknown', reason: 'tree-unreadable' }
  for (const link of chain) {
    if (link.managedId) return { kind: 'session', pid, managedId: link.managedId }
    if (i.sessionPids.has(link.pid) || link.pid === i.serverPid) return { kind: 'session', pid, managedId: null }
  }
  return { kind: 'person', via: 'process', pid }
}

/** The refusal a verdict earns on a person-only route (`null` = proceed). */
export function callerRefusal(v: CallerVerdict): { status: 403; error: 'session_cannot_unlock' | 'caller_unidentified'; sentence: string; why?: string } | null {
  if (v.kind === 'person') return null
  if (v.kind === 'session') {
    return { status: 403, error: 'session_cannot_unlock', sentence: 'Only the person can change this browser\'s padlock; a session cannot unlock it.' }
  }
  return {
    status: 403, error: 'caller_unidentified', why: v.reason,
    sentence: 'Could not confirm that this request comes from the person (not from a session), so the padlock was not changed. Use the agentistics screen.',
  }
}

/**
 * S4b/S4c: the early door on `POST /api/vault/browser-unlock`. A KNOWN session may not even ASK for the
 * proof — it would raise a Hello / Touch ID dialog on the person's desk. Returns the 403 to send (body
 * cancelled, so nothing is read), or `null` to go on to the vault (the proof still decides for everyone else).
 */
export async function browserUnlockEarlyRefusal(req: { body?: { cancel(): Promise<unknown> } | null }, who: CallerVerdict, headers: Record<string, string>): Promise<Response | null> {
  if (who.kind !== 'session') return null
  await req.body?.cancel().catch(() => {})
  const r = callerRefusal(who)!
  return new Response(JSON.stringify({ ok: false, code: r.error, sentence: r.sentence }), { status: 403, headers: { ...headers, 'Cache-Control': 'no-store' } })
}
