/**
 * host-allow.test.ts — the DNS-rebinding gate in front of every `localShell` route.
 *
 * Pure: every case builds its own allowlist and passes explicit capabilities, never the runtime
 * singletons, so nothing here depends on this machine's hostname or interfaces.
 */
import { describe, expect, it, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  parseHostHeader,
  buildHostAllowlist,
  hostAllowed,
  hostGate,
  ownPorts,
  magicDnsNames,
  badRequestTarget,
  type HostAllowlist,
} from './host-allow'
import { registeredRoutes, routeCapability } from './capability-guard'
import { capabilitiesFor } from './exposure'

const PORT = 47291
const byNum = (a: number, b: number) => a - b
const WEB_PORT = 47292

const localCaps = capabilitiesFor('local', { central: false, exposure: undefined, allowLocalShell: false, tls: false })
const lanCaps = capabilitiesFor('lan', { central: true, exposure: 'lan', allowLocalShell: false, tls: false })
const publicCaps = capabilitiesFor('public', { central: true, exposure: 'public', allowLocalShell: true, tls: true })

function allowlist(overrides: Partial<Parameters<typeof buildHostAllowlist>[0]> = {}): HostAllowlist {
  return buildHostAllowlist({
    hostname: 'BRAIAODE2',
    interfaceAddresses: [
      '127.0.0.1',
      '::1',
      '192.168.1.40',
      '100.109.247.39', // a tailnet address
      'fd7a:115c:a1e0::1501:f729', // the tailnet's IPv6
      'fe80::215:5dff:fe01:2%eth0', // link-local, with the zone id the OS appends
    ],
    ports: [PORT, WEB_PORT],
    allowedOrigins: ['https://dash.example.com', 'http://split.example:8080'],
    secureOrigin: 'https://alien-wsl.seahorse-cobia.ts.net:8443',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------------------------
// The finding itself: a page whose name resolves to 127.0.0.1 sends ITS name as the Host.
// ---------------------------------------------------------------------------------------------

/** Every localShell registration, plus a sub-path and a not-yet-written sub-path under prefixes. */
function localShellPaths(): string[] {
  const out: string[] = []
  for (const r of registeredRoutes()) {
    if (r.capability !== 'localShell') continue
    out.push(r.path)
    if (r.match === 'prefix') {
      out.push(`${r.path}/some-id`, `${r.path}/route-nobody-has-written-yet`)
    }
  }
  // The two WebSocket write channels and the stream readers, by name: the walk above already
  // covers them through their prefixes, and naming them makes a regression read as what it is.
  out.push('/api/fleet/input', '/api/fleet/stream', '/api/fleet/new', '/api/shell/input', '/api/shell/stream', '/api/shell/open')
  return out
}

describe('a rebinding Host is refused on every localShell route', () => {
  const paths = localShellPaths()

  it('walks a non-trivial table (the walk is only as good as the list it walks)', () => {
    // If registeredRoutes() ever returned nothing this suite would pass vacuously.
    expect(paths).toContain('/api/exec')
    expect(paths).toContain('/api/fleet/input')
    expect(paths).toContain('/api/fleet/route-nobody-has-written-yet')
    expect(paths.length).toBeGreaterThan(20)
  })

  for (const path of paths) {
    test(`${path} → 421 under Host: evil.example:${PORT}`, async () => {
      expect(routeCapability(path)).toBe('localShell')
      const res = hostGate(path, `evil.example:${PORT}`, allowlist(), localCaps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(421)
      const body = await res!.json() as { error: string; host: string; message: string }
      expect(body.error).toBe('misdirected_host')
      expect(body.host).toBe(`evil.example:${PORT}`)
      expect(body.message).toContain('evil.example:47291')
      expect(body.message).toContain('AGENTISTICS_ALLOWED_ORIGINS')
    })
  }

  it('also refuses the rebinding name with no port at all', () => {
    const res = hostGate('/api/fleet', 'evil.example', allowlist(), localCaps)
    expect(res?.status).toBe(421)
  })
})

// ---------------------------------------------------------------------------------------------
// What must keep working.
// ---------------------------------------------------------------------------------------------

describe('hostAllowed — the names this machine answers to', () => {
  const list = allowlist()
  const ok = (h: string) => expect(hostAllowed(h, list)).toEqual({ ok: true })

  it('loopback names and the whole of 127.0.0.0/8', () => {
    ok(`localhost:${PORT}`)
    ok(`LOCALHOST:${WEB_PORT}`)
    ok(`localhost.:${PORT}`) // trailing dot: the fully-qualified spelling of the same name
    ok(`127.0.0.1:${PORT}`)
    ok(`127.1.2.3:${WEB_PORT}`)
    ok(`127.255.255.254:${PORT}`)
    ok(`[::1]:${PORT}`)
    ok(`[::ffff:127.0.0.1]:${PORT}`)
    ok(`[::ffff:7f00:1]:${PORT}`) // the form a browser canonicalises the line above to
  })

  it('does not mistake a name that merely starts like loopback for loopback', () => {
    expect(hostAllowed(`127.0.0.1.evil.example:${PORT}`, list).ok).toBe(false)
    expect(hostAllowed(`localhost.evil.example:${PORT}`, list).ok).toBe(false)
    expect(hostAllowed(`128.0.0.1:${PORT}`, list).ok).toBe(false)
    expect(hostAllowed(`[::2]:${PORT}`, list).ok).toBe(false)
  })

  it("the machine's own hostname, lowercased, and its .local name", () => {
    ok(`braiaode2:${WEB_PORT}`)
    ok(`BRAIAODE2:${PORT}`)
    ok(`braiaode2.local:${WEB_PORT}`)
  })

  it('every interface address — LAN, tailnet 100.x, IPv6, and link-local with its zone stripped', () => {
    ok(`192.168.1.40:${WEB_PORT}`)
    ok(`100.109.247.39:${WEB_PORT}`)
    ok(`[fd7a:115c:a1e0::1501:f729]:${PORT}`)
    ok(`[FD7A:115C:A1E0:0:0:0:1501:F729]:${PORT}`) // an uncompressed spelling of the same address
    ok(`[fe80::215:5dff:fe01:2]:${PORT}`)
    ok(`[fe80::215:5dff:fe01:2%25eth0]:${PORT}`) // RFC 6874 zone in a Host header
  })

  it('an address this machine does NOT hold is foreign', () => {
    expect(hostAllowed(`192.168.1.41:${WEB_PORT}`, list)).toEqual({ ok: false, reason: 'foreign-host', host: `192.168.1.41:${WEB_PORT}` })
  })

  it('an exact AGENTISTICS_ALLOWED_ORIGINS origin passes regardless of the own-ports rule', () => {
    ok('dash.example.com') // https, default port 443 — a browser omits it from Host
    ok('dash.example.com:443')
    ok('split.example:8080')
    // …and only that origin: same name, another port, is not what was allowed.
    expect(hostAllowed('split.example:8081', list).ok).toBe(false)
    expect(hostAllowed('split.example', list).ok).toBe(false)
    // Exact, never a suffix test.
    expect(hostAllowed('evil-dash.example.com', list).ok).toBe(false)
  })

  it('the tailscale-serve secure origin passes, as it arrives and on our own ports', () => {
    ok('alien-wsl.seahorse-cobia.ts.net:8443')
    ok(`alien-wsl.seahorse-cobia.ts.net:${WEB_PORT}`) // same name, reached directly over the tailnet
    const on443 = allowlist({ secureOrigin: 'https://box.tail1234.ts.net' })
    expect(hostAllowed('box.tail1234.ts.net', on443)).toEqual({ ok: true })
    expect(hostAllowed('box.tail1234.ts.net:443', on443)).toEqual({ ok: true })
  })

  it('a junk AGENTISTICS_ALLOWED_ORIGINS entry is skipped, not a crash and not a wildcard', () => {
    const list2 = allowlist({ allowedOrigins: ['not a url', '*', 'ftp://x.example', 'http://ok.example:9000'] })
    expect(hostAllowed('ok.example:9000', list2)).toEqual({ ok: true })
    expect(hostAllowed('evil.example:9000', list2).ok).toBe(false)
  })
})

describe('hostAllowed — the port has to be one of ours', () => {
  const list = allowlist()

  it('refuses a local name on a port this server does not listen on', () => {
    expect(hostAllowed('127.0.0.1:9999', list)).toEqual({ ok: false, reason: 'foreign-port', host: '127.0.0.1:9999' })
    expect(hostAllowed('localhost:80', list)).toEqual({ ok: false, reason: 'foreign-port', host: 'localhost:80' })
  })

  it('refuses a local name with NO port unless an origin names it', () => {
    expect(hostAllowed('localhost', list)).toEqual({ ok: false, reason: 'foreign-port', host: 'localhost' })
    expect(hostAllowed('braiaode2', list)).toEqual({ ok: false, reason: 'foreign-port', host: 'braiaode2' })
  })

  it('ownPorts: the two ports in binary mode, plus the Vite port in dev', () => {
    expect(ownPorts({ port: 47291, webPort: 47292, serveStatic: true, vitePort: undefined }).sort(byNum)).toEqual([47291, 47292])
    expect(ownPorts({ port: 48000, webPort: 48001, serveStatic: false, vitePort: undefined }).sort(byNum)).toEqual([47292, 48000, 48001])
    expect(ownPorts({ port: 48000, webPort: 48001, serveStatic: false, vitePort: '5173' }).sort(byNum)).toEqual([5173, 48000, 48001])
    expect(ownPorts({ port: 48000, webPort: 48001, serveStatic: false, vitePort: 'junk' }).sort(byNum)).toEqual([48000, 48001])
  })
})

describe('hostAllowed — missing and malformed', () => {
  const list = allowlist()

  it('a missing Host is refused', () => {
    expect(hostAllowed(null, list)).toEqual({ ok: false, reason: 'missing', host: null })
    expect(hostAllowed('', list)).toEqual({ ok: false, reason: 'missing', host: null })
  })

  for (const raw of [
    'local host:47291',
    'user@localhost:47291',
    'localhost/x:47291',
    'localhost:',
    'localhost:abc',
    'localhost:0',
    'localhost:65536',
    'localhost:123456',
    '::1:47291', // unbracketed IPv6
    '[::1',
    '[::1]x',
    '[not-ipv6]:47291',
    ':47291',
    '.',
    'localhost?x=1:47291',
    'localhost#x',
    'localhost\\x',
  ]) {
    it(`refuses ${JSON.stringify(raw)} as malformed`, () => {
      const v = hostAllowed(raw, list)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason).toBe('malformed')
    })
  }
})

describe('parseHostHeader', () => {
  it('lowercases, strips a trailing dot, and separates the port', () => {
    expect(parseHostHeader('LocalHost.:47291')).toEqual({ host: 'localhost', port: 47291 })
    expect(parseHostHeader('example.com')).toEqual({ host: 'example.com', port: null })
  })
  it('handles bracketed IPv6, with and without a port, and canonicalises it', () => {
    expect(parseHostHeader('[::1]:47291')).toEqual({ host: '::1', port: 47291 })
    expect(parseHostHeader('[0:0:0:0:0:0:0:1]')).toEqual({ host: '::1', port: null })
  })
  it('rejects junk', () => {
    expect(parseHostHeader(null)).toBeNull()
    expect(parseHostHeader('')).toBeNull()
    expect(parseHostHeader('a b')).toBeNull()
    expect(parseHostHeader('a@b')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// hostGate — where it applies, and where it must stay out of the way.
// ---------------------------------------------------------------------------------------------

describe('hostGate', () => {
  const list = allowlist()

  it('lets a loopback Host through on a localShell route', () => {
    expect(hostGate('/api/fleet', `127.0.0.1:${PORT}`, list, localCaps)).toBeNull()
    expect(hostGate('/api/exec', `localhost:${WEB_PORT}`, list, localCaps)).toBeNull()
  })

  it('never gates a route that is not localShell', () => {
    expect(routeCapability('/api/data')).toBeNull()
    expect(hostGate('/api/data', 'evil.example:47291', list, localCaps)).toBeNull()
    expect(hostGate('/', 'evil.example:47291', list, localCaps)).toBeNull()
    // Other capabilities are not this finding's subject and keep their own behaviour.
    expect(hostGate('/api/chat-tty', 'evil.example:47291', list, localCaps)).toBeNull()
    expect(hostGate('/api/claude-sessions', 'evil.example:47291', list, localCaps)).toBeNull()
  })

  it('with localShell OFF it returns null, so the existing 403 answers exactly as before', () => {
    expect(lanCaps.localShell).toBe(false)
    expect(publicCaps.localShell).toBe(false)
    for (const path of localShellPaths()) {
      expect(hostGate(path, 'evil.example:47291', list, lanCaps)).toBeNull()
      expect(hostGate(path, 'evil.example:47291', list, publicCaps)).toBeNull()
      expect(hostGate(path, null, list, publicCaps)).toBeNull()
    }
  })

  it('names the refused host and the knob in a sentence, with a usable example origin', async () => {
    const res = hostGate('/api/fleet', 'evil.example:47291', list, localCaps)!
    const body = await res.json() as { message: string }
    expect(body.message).toBe(
      'This machine does not answer to the host "evil.example:47291" for this route. If you reach it by that name on purpose, add its origin to AGENTISTICS_ALLOWED_ORIGINS (for example http://evil.example:47291) and restart agentop server.',
    )
    const v6 = await hostGate('/api/fleet', '[2001:db8::1]:47291', list, localCaps)!.json() as { message: string }
    expect(v6.message).toContain('http://[2001:db8::1]:47291')
    const noPort = await hostGate('/api/fleet', 'evil.example', list, localCaps)!.json() as { message: string }
    expect(noPort.message).toContain('(for example http://evil.example)')
  })

  it('says so in words when there was no Host header at all', async () => {
    const res = hostGate('/api/fleet', null, list, localCaps)!
    expect(res.status).toBe(421)
    const body = await res.json() as { host: string | null; message: string }
    expect(body.host).toBeNull()
    expect(body.message).toContain('no Host header')
  })

  it('answers a malformed Host with a sentence that does not pretend it was a name', async () => {
    const res = hostGate('/api/fleet', 'user@evil.example', list, localCaps)!
    expect(res.status).toBe(421)
    const body = await res.json() as { message: string }
    expect(body.message).toContain('could not be read')
  })

  it('bounds how much of a hostile header it echoes back', async () => {
    const huge = 'a'.repeat(5000) + '.example:47291'
    const body = await hostGate('/api/fleet', huge, list, localCaps)!.json() as { host: string; message: string }
    expect(body.host.length).toBeLessThanOrEqual(256)
    expect(body.message.length).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------------------------
// MagicDNS: the tailnet names this machine answers to, which os.hostname() does not know.
// ---------------------------------------------------------------------------------------------

describe('magicDnsNames — `tailscale status --json` -> the names', () => {
  it('extracts the full name and its short first label, trailing dot stripped, lowercased', () => {
    expect(magicDnsNames({ Self: { DNSName: 'Alien-WSL.seahorse-cobia.ts.net.' } }))
      .toEqual(['alien-wsl.seahorse-cobia.ts.net', 'alien-wsl'])
  })
  it('a single-label DNSName yields that one name, once', () => {
    expect(magicDnsNames({ Self: { DNSName: 'box.' } })).toEqual(['box'])
  })
  for (const [label, input] of [
    ['null', null],
    ['a string', 'not json'],
    ['no Self', { Version: '1.2.3' }],
    ['Self not an object', { Self: 'x' }],
    ['no DNSName', { Self: { HostName: 'alien-wsl' } }],
    ['DNSName empty', { Self: { DNSName: '' } }],
    ['DNSName a dot', { Self: { DNSName: '.' } }],
    ['DNSName not a string', { Self: { DNSName: 42 } }],
    ['DNSName not a host name', { Self: { DNSName: 'evil.example:47291' } }],
    ['DNSName with a space', { Self: { DNSName: 'a b.ts.net.' } }],
  ] as const) {
    it(`answers [] for ${label}`, () => {
      expect(magicDnsNames(input)).toEqual([])
    })
  }
})

describe('the gate accepts the MagicDNS names on our own ports, and only there', () => {
  // No secure origin here: it would put the full name on the list by another route and hide a
  // regression in this one.
  const list = allowlist({
    secureOrigin: null,
    magicDnsNames: magicDnsNames({ Self: { DNSName: 'alien-wsl.seahorse-cobia.ts.net.' } }),
  })

  it('both forms pass on 47291 and 47292', () => {
    for (const port of [PORT, WEB_PORT]) {
      expect(hostGate('/api/fleet', `alien-wsl:${port}`, list, localCaps)).toBeNull()
      expect(hostGate('/api/fleet', `alien-wsl.seahorse-cobia.ts.net:${port}`, list, localCaps)).toBeNull()
      expect(hostGate('/api/fleet', `ALIEN-WSL.seahorse-cobia.ts.net.:${port}`, list, localCaps)).toBeNull()
    }
  })

  it('both forms are refused on a port that is not ours', () => {
    expect(hostAllowed('alien-wsl:9999', list)).toEqual({ ok: false, reason: 'foreign-port', host: 'alien-wsl:9999' })
    expect(hostAllowed('alien-wsl.seahorse-cobia.ts.net:9999', list))
      .toEqual({ ok: false, reason: 'foreign-port', host: 'alien-wsl.seahorse-cobia.ts.net:9999' })
    expect(hostAllowed('alien-wsl', list).ok).toBe(false)
  })

  it('a foreign name still gets 421, including one that merely extends a MagicDNS name', () => {
    expect(hostGate('/api/fleet', `evil.example:${PORT}`, list, localCaps)?.status).toBe(421)
    expect(hostGate('/api/fleet', `alien-wsl.evil.example:${PORT}`, list, localCaps)?.status).toBe(421)
    expect(hostGate('/api/fleet', `other.seahorse-cobia.ts.net:${PORT}`, list, localCaps)?.status).toBe(421)
  })

  it('without the MagicDNS names (tailscale absent) the short name is refused, as before', () => {
    const bare = allowlist({ secureOrigin: null })
    expect(hostGate('/api/fleet', `alien-wsl:${PORT}`, bare, localCaps)?.status).toBe(421)
  })
})

// ---------------------------------------------------------------------------------------------
// A request with no usable Host: a clean 400 on EVERY route, not a 500 from a URL parse.
// ---------------------------------------------------------------------------------------------

describe('badRequestTarget', () => {
  it('passes an ordinary request', () => {
    expect(badRequestTarget('http://127.0.0.1:47291/api/fleet', '127.0.0.1:47291')).toBeNull()
    expect(badRequestTarget('http://evil.example:47291/', 'evil.example:47291')).toBeNull() // that is hostGate's call
  })

  // Measured against Bun: with no Host (HTTP/1.0) or an empty one, `req.url` is the bare path.
  for (const [label, url, host] of [
    ['no Host at all', '/api/fleet', null],
    ['an empty Host', '/api/fleet', ''],
    ['a blank Host', '/', '   '],
  ] as const) {
    it(`answers 400 missing_host with a sentence for ${label}`, async () => {
      const res = badRequestTarget(url, host)
      expect(res?.status).toBe(400)
      expect(res?.headers.get('content-type')).toBe('application/json')
      const body = await res!.json() as { error: string; message: string }
      expect(body.error).toBe('missing_host')
      expect(body.message).toMatch(/Host header/)
    })
  }

  it('a URL that cannot be parsed for any OTHER reason is a 400 too, never a throw', async () => {
    // Bun builds `http://a b/x` from `Host: a b`, which new URL() refuses.
    const res = badRequestTarget('http://a b/x', 'a b')
    expect(res?.status).toBe(400)
    const body = await res!.json() as { error: string; message: string }
    expect(body.error).toBe('bad_request_target')
    expect(body.message.length).toBeGreaterThan(20)
  })

  it('never echoes a hostile header unbounded', async () => {
    const huge = 'a '.repeat(5000)
    const body = await badRequestTarget(`http://${huge}/`, huge)!.text()
    expect(body.length).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------------------------
// Cost: it runs on every localShell request, so it must be a string/Set check, not IO.
// ---------------------------------------------------------------------------------------------

test('hostAllowed costs microseconds, not a syscall', () => {
  const list = allowlist()
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${WEB_PORT}`, `100.109.247.39:${WEB_PORT}`, 'evil.example:47291', `[::1]:${PORT}`]
  const N = 200_000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) hostAllowed(hosts[i % hosts.length]!, list)
  const us = ((performance.now() - t0) * 1000) / N
  console.log(`[host-allow] hostAllowed: ${us.toFixed(3)} µs/call over ${N} calls`)
  // Generous: a per-request DNS lookup or os.networkInterfaces() call would be 10-1000x this.
  expect(us).toBeLessThan(20)
})

// ---------------------------------------------------------------------------------------------
// Placement: the gate is only a gate if it runs before anything it protects.
// ---------------------------------------------------------------------------------------------

describe('index.ts wires the gate in ONE place, ahead of every handler and every WS upgrade', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
  const handler = src.slice(src.indexOf('async function handleRequestInner'))

  it('calls hostGate exactly once', () => {
    expect(src.match(/hostGate\(/g)?.length).toBe(1)
  })

  it('before the first server.upgrade( — so the fleet input, shell input and agent sockets are all behind it', () => {
    const gate = handler.indexOf('hostGate(')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(handler.indexOf('server.upgrade('))
  })

  it('right after the capability guard and before the auth gate and the first route handler', () => {
    const gate = handler.indexOf('hostGate(')
    expect(gate).toBeGreaterThan(handler.indexOf('capabilityDenied('))
    expect(gate).toBeLessThan(handler.indexOf('getPrincipalSession('))
    // The first route handler: the first `if (url.pathname === '/api/…'` in the handler. (The
    // ingest-only block above the guards compares paths too, but inside a condition that only ever
    // REFUSES — it serves nothing.)
    const firstRoute = handler.search(/if \(url\.pathname === '\/api\//)
    expect(firstRoute).toBeGreaterThan(0)
    expect(gate).toBeLessThan(firstRoute)
  })

  it('answers a request with no usable Host BEFORE anything parses its URL', () => {
    const outer = src.slice(src.indexOf('async function handleRequest('), src.indexOf('async function handleRequestInner'))
    const check = outer.indexOf('badRequestTarget(')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(outer.indexOf('handleRequestInner('))
    expect(check).toBeLessThan(outer.indexOf('new URL(req.url)'))
    expect(src.match(/badRequestTarget\(/g)?.length).toBe(1)
  })

  it('starts the allowlist refresh once at startup', () => {
    expect(src.match(/startHostAllowlistRefresh\(\)/g)?.length).toBe(1)
  })
})
