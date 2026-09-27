import { describe, expect, it } from 'bun:test'
import { isLoopbackAddress, parseLsofListenOutput, parseProcNetTcp } from './native-bind'

// ---------------------------------------------------------------------------
// /proc/net/tcp (IPv4) — hex verified by hand against a live decode:
//   47291 = 0xB8BB, 47292 = 0xB8BC, 80 = 0x0050, 8080 = 0x1F90
//   0.0.0.0     -> 00000000
//   127.0.0.1   -> 0100007F
//   192.168.1.5 -> 0501A8C0
// ---------------------------------------------------------------------------
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:B8BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:B8BC 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0501A8C0:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1F90 0100007F:9C41 01 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0
`

// ---------------------------------------------------------------------------
// /proc/net/tcp6 — 32 hex chars = four independently-byte-reversed 32-bit words:
//   '::'                    -> 32 zero chars
//   '::1'                   -> 24 zero chars + '01000000'
//   '::ffff:192.168.1.5'    -> 16 zero chars + 'FFFF0000' + '0501A8C0' (the v4 word above)
// ---------------------------------------------------------------------------
const ALL_ZERO_V6 = '0'.repeat(32)
const LOOPBACK_V6 = '0'.repeat(24) + '01000000'
const MAPPED_V6 = '0'.repeat(16) + 'FFFF0000' + '0501A8C0'
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: ${ALL_ZERO_V6}:B8BB ${ALL_ZERO_V6}:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22345 1 0000000000000000 100 0 0 10 0
   1: ${LOOPBACK_V6}:B8BC ${ALL_ZERO_V6}:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22346 1 0000000000000000 100 0 0 10 0
   2: ${MAPPED_V6}:0050 ${ALL_ZERO_V6}:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22347 1 0000000000000000 100 0 0 10 0
`

describe('parseProcNetTcp — IPv4', () => {
  it('decodes 0.0.0.0, 127.0.0.1 and a LAN IP for the requested ports, LISTEN only', () => {
    const listeners = parseProcNetTcp(PROC_NET_TCP, { ipv6: false, ports: new Set([47291, 47292, 80, 8080]) })
    expect(listeners).toEqual([
      { port: 47291, address: '0.0.0.0' },
      { port: 47292, address: '127.0.0.1' },
      { port: 80, address: '192.168.1.5' },
    ])
  })

  it('ignores a matching port that is not in LISTEN state', () => {
    const listeners = parseProcNetTcp(PROC_NET_TCP, { ipv6: false, ports: new Set([8080]) })
    expect(listeners).toEqual([])
  })

  it('ignores a LISTEN row whose port was not asked about', () => {
    const listeners = parseProcNetTcp(PROC_NET_TCP, { ipv6: false, ports: new Set([9999]) })
    expect(listeners).toEqual([])
  })
})

describe('parseProcNetTcp — IPv6', () => {
  it('decodes ::, ::1 and an IPv4-mapped address', () => {
    const listeners = parseProcNetTcp(PROC_NET_TCP6, { ipv6: true, ports: new Set([47291, 47292, 80]) })
    expect(listeners).toEqual([
      { port: 47291, address: '::' },
      { port: 47292, address: '::1' },
      { port: 80, address: '::ffff:192.168.1.5' },
    ])
  })
})

describe('parseLsofListenOutput', () => {
  it('parses a wildcard IPv4 listener', () => {
    const raw = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'agentop  1234   scion   9u  IPv4 0x123456789abcdef      0t0  TCP *:47291 (LISTEN)',
    ].join('\n')
    expect(parseLsofListenOutput(raw)).toEqual([{ port: 47291, address: '0.0.0.0' }])
  })

  it('parses a wildcard IPv6 listener distinctly from an IPv4 one', () => {
    const raw = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'agentop  1234   scion   9u  IPv6 0x123456789abcdef      0t0  TCP *:47291 (LISTEN)',
    ].join('\n')
    expect(parseLsofListenOutput(raw)).toEqual([{ port: 47291, address: '::' }])
  })

  it('parses a loopback IPv4 listener', () => {
    const raw = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'agentop  1234   scion  10u  IPv4 0x123456789abcdef      0t0  TCP 127.0.0.1:47292 (LISTEN)',
    ].join('\n')
    expect(parseLsofListenOutput(raw)).toEqual([{ port: 47292, address: '127.0.0.1' }])
  })

  it('unwraps a bracketed IPv6 address', () => {
    const raw = [
      'COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'agentop  1234   scion  11u  IPv6 0x123456789abcdef      0t0  TCP [::1]:47292 (LISTEN)',
    ].join('\n')
    expect(parseLsofListenOutput(raw)).toEqual([{ port: 47292, address: '::1' }])
  })

  it('returns nothing for empty output (lsof found no match)', () => {
    expect(parseLsofListenOutput('')).toEqual([])
  })
})

describe('isLoopbackAddress', () => {
  it('accepts 127.0.0.1, other 127.x addresses, ::1 and an IPv4-mapped loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects a wildcard bind and a LAN address', () => {
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('::')).toBe(false)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false)
  })
})
