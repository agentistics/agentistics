/**
 * F1 (QA S3): WHO is calling the padlock, read from the SOCKET, never from the body. A caller inside the
 * process tree of any managed session is a session; a caller that cannot be identified with certainty is
 * refused (fail-closed); the person's browser keeps working.
 */
import { describe, expect, test } from 'bun:test'
import { classifyCaller, callerRefusal, parseProcNetTcp, type CallerInput, type ProcLink } from './browser-caller'

// /proc/net/tcp lines as the kernel prints them (127.0.0.1:41000 → 127.0.0.1:47291, uid 1000, inode 777).
const TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:B8D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0',
  // client side of the request: local 127.0.0.1:41000 (0xA028), remote 127.0.0.1:47291 (0xB8BB)
  '   1: 0100007F:A028 0100007F:B8BB 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 20 4 30 10 -1',
  // server side of the same connection (must never be taken for the client)
  '   2: 0100007F:B8BB 0100007F:A028 01 00000000:00000000 00:00000000 00000000  1000        0 778 1 0000000000000000 20 4 30 10 -1',
  // the WSL localhost relay (root) carrying the Windows browser: 127.0.0.1:45978 (0xB39A) → :47292 (0xB8BC)
  '   3: 0100007F:B39A 0100007F:B8BC 01 00000000:00000000 00:00000000 00000000     0        0 900 1 0000000000000000 20 4 30 10 -1',
].join('\n')

const TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  // ::ffff:127.0.0.1:41500 (0xA21C) → ::ffff:127.0.0.1:47291
  '   0: 0000000000000000FFFF00000100007F:A21C 0000000000000000FFFF00000100007F:B8BB 01 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000000000000000 20 4 30 10 -1',
  // ::1:41600 (0xA280) → ::1:47291
  '   1: 00000000000000000000000001000000:A280 00000000000000000000000001000000:B8BB 01 00000000:00000000 00:00000000 00000000  1000        0 556 1 0000000000000000 20 4 30 10 -1',
].join('\n')

describe('parseProcNetTcp', () => {
  test('IPv4 rows: addresses, ports, uid, inode', () => {
    const rows = parseProcNetTcp(TCP, false)
    expect(rows[1]).toEqual({ localAddr: '127.0.0.1', localPort: 41000, remAddr: '127.0.0.1', remPort: 47291, uid: 1000, inode: 777 })
    expect(rows[3]).toMatchObject({ localPort: 45978, remPort: 47292, uid: 0, inode: 900 })
  })
  test('IPv6 rows: v4-mapped is read as v4, ::1 as ::1', () => {
    const rows = parseProcNetTcp(TCP6, true)
    expect(rows[0]).toMatchObject({ localAddr: '127.0.0.1', localPort: 41500, remPort: 47291, inode: 555 })
    expect(rows[1]).toMatchObject({ localAddr: '::1', localPort: 41600, inode: 556 })
  })
  test('garbage lines are skipped', () => {
    expect(parseProcNetTcp('nonsense\n  x: y z', false)).toEqual([])
  })
})

/** A machine: pid 4242 is curl (client of inode 777) under bash 4241 under claude 4240 (managed). */
function machine(over: Partial<CallerInput> = {}, chain?: ProcLink[]): CallerInput {
  const links: ProcLink[] = chain ?? [
    { pid: 4242, managedId: null, interop: false },
    { pid: 4241, managedId: null, interop: false },
    { pid: 4240, managedId: 'abc123', interop: false },
    { pid: 100, managedId: null, interop: false },
  ]
  return {
    peer: { address: '127.0.0.1', port: 41000 },
    serverPorts: [47291, 47292],
    localAddresses: ['127.0.0.1', '172.23.255.165'],
    sockets: () => [...parseProcNetTcp(TCP, false), ...parseProcNetTcp(TCP6, true)],
    ourUid: 1000,
    pidOfInode: (inode) => (inode === 777 || inode === 555 || inode === 556 ? 4242 : null),
    ancestry: (pid) => (pid === 4242 ? links : null),
    serverPid: 7,
    sessionPids: new Set<number>(),
    wsl: true,
    sessionInterop: () => false,
    ...over,
  }
}

const person: ProcLink[] = [{ pid: 4242, managedId: null, interop: false }, { pid: 900, managedId: null, interop: false }, { pid: 1, managedId: null, interop: false }]

describe('classifyCaller', () => {
  test('a curl from inside a session tree is a SESSION (body says nothing about it)', () => {
    expect(classifyCaller(machine())).toEqual({ kind: 'session', pid: 4242, managedId: 'abc123' })
  })

  test('a process outside every session tree is the PERSON', () => {
    expect(classifyCaller(machine({}, person))).toEqual({ kind: 'person', via: 'process', pid: 4242 })
  })

  test('the session is found by its pane/row pid too (env scrubbed)', () => {
    const chain: ProcLink[] = [{ pid: 4242, managedId: null, interop: false }, { pid: 3000, managedId: null, interop: false }, { pid: 1, managedId: null, interop: false }]
    expect(classifyCaller(machine({ sessionPids: new Set([3000]) }, chain))).toEqual({ kind: 'session', pid: 4242, managedId: null })
  })

  test('a descendant of the server itself (a structured session) is a session', () => {
    const chain: ProcLink[] = [{ pid: 4242, managedId: null, interop: false }, { pid: 7, managedId: null, interop: false }, { pid: 1, managedId: null, interop: false }]
    expect(classifyCaller(machine({}, chain))).toEqual({ kind: 'session', pid: 4242, managedId: null })
  })

  test('IPv4-mapped and ::1 peers are matched too', () => {
    expect(classifyCaller(machine({ peer: { address: '::ffff:127.0.0.1', port: 41500 } })).kind).toBe('session')
    expect(classifyCaller(machine({ peer: { address: '::1', port: 41600 } })).kind).toBe('session')
  })

  test('the SERVER side of the connection is never taken for the caller', () => {
    // peer port 47291 would match row 2's local port if the rule ignored the remote port
    expect(classifyCaller(machine({ peer: { address: '127.0.0.1', port: 47291 } }))).toEqual({ kind: 'unknown', reason: 'socket-not-found' })
  })

  describe('fail-closed', () => {
    test('no /proc (another platform): unknown', () => {
      expect(classifyCaller(machine({ sockets: () => null }))).toEqual({ kind: 'unknown', reason: 'no-proc' })
    })
    test('socket not in the table: unknown', () => {
      expect(classifyCaller(machine({ peer: { address: '127.0.0.1', port: 1 } }))).toEqual({ kind: 'unknown', reason: 'socket-not-found' })
    })
    test('our socket but no process holds it (it closed, or it was passed on): unknown', () => {
      expect(classifyCaller(machine({ pidOfInode: () => null }))).toEqual({ kind: 'unknown', reason: 'pid-not-found' })
    })
    test('the process tree cannot be read: unknown', () => {
      expect(classifyCaller(machine({ ancestry: () => null }))).toEqual({ kind: 'unknown', reason: 'tree-unreadable' })
    })
    test('no peer address: unknown', () => {
      expect(classifyCaller(machine({ peer: null }))).toEqual({ kind: 'unknown', reason: 'no-peer' })
    })
    test('another user\'s socket (not the WSL relay): unknown', () => {
      expect(classifyCaller(machine({ wsl: false, peer: { address: '127.0.0.1', port: 45978 } }))).toEqual({ kind: 'unknown', reason: 'foreign-uid' })
    })
  })

  describe('the person\'s Windows browser on WSL (root localhost relay)', () => {
    test('is the person while no session is running a Windows program', () => {
      expect(classifyCaller(machine({ peer: { address: '127.0.0.1', port: 45978 } }))).toEqual({ kind: 'person', via: 'wsl-relay' })
    })
    test('is refused while a session runs a Windows program (curl.exe through interop)', () => {
      expect(classifyCaller(machine({ peer: { address: '127.0.0.1', port: 45978 }, sessionInterop: () => true }))).toEqual({ kind: 'unknown', reason: 'wsl-relay-ambiguous' })
    })
  })

  test('a peer that is not an address of this machine is another machine (the auth gate already ran)', () => {
    expect(classifyCaller(machine({ peer: { address: '100.64.0.9', port: 5555 } }))).toEqual({ kind: 'person', via: 'remote' })
  })

  test('this machine\'s LAN address is local (a session cannot dodge by calling it)', () => {
    const rows = 'sl local rem\n   0: A5FF17AC:A028 A5FF17AC:B8BB 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 20 4 30 10 -1'
    expect(classifyCaller(machine({ peer: { address: '172.23.255.165', port: 41000 }, sockets: () => parseProcNetTcp(rows, false) })).kind).toBe('session')
  })
})

describe('callerRefusal', () => {
  test('session ⇒ 403 session_cannot_unlock; unknown ⇒ 403 caller_unidentified; person ⇒ null', () => {
    expect(callerRefusal({ kind: 'session', pid: 1, managedId: 'x' })).toMatchObject({ status: 403, error: 'session_cannot_unlock' })
    expect(callerRefusal({ kind: 'unknown', reason: 'no-proc' })).toMatchObject({ status: 403, error: 'caller_unidentified' })
    expect(callerRefusal({ kind: 'person', via: 'process', pid: 1 })).toBeNull()
    expect(callerRefusal({ kind: 'person', via: 'remote' })).toBeNull()
  })
})
