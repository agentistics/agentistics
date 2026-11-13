/**
 * S1c — the CLI doors: `agentop task evidence add|ls|rm` and `agentop evidence capture <url> [--out f]`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDeliveryCli } from './cli'
import type { CliAuth } from './cli-principal'
import { forgetClassifyCache } from './classify-host'
import { formatCapture, runEvidenceCapture } from './capture'
import { validateApiCapture } from './evidence'
import { makeWorld, png } from './evidence-world.testing'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'evidence-cli-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } } }
/** S0d: the CLI's principal is what the process tree PROVES. The fixture's tree proves whatever id it exports; `owner` steps up. */
const proving = (o: { stepUp?: boolean; interactive?: boolean } = {}): CliAuth => ({ prove: async () => true, stepUp: async () => o.stepUp ?? false, interactive: o.interactive ?? false })
const cli = (svc: never, args: string[], env: Record<string, string> = { AGENTOP_MANAGED_ID: 'worker' }, auth: CliAuth = proving()) => { const c = io(); return runDeliveryCli(['task-evidence', ...args], c.io, env, svc, async () => auth).then(code => ({ code, out: c.out.join('\n'), err: c.err.join('\n') })) }

describe('agentop task evidence add|ls|rm', () => {
  test('add --file uploads the bytes, prints the item with the SERVER\'s hash; ls shows it; rm removes it', async () => {
    const { svc } = makeWorld(root)
    const f = join(root, 'desk.png'); writeFileSync(f, png(1280, 800, 70))
    const added = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f])
    expect(added.code).toBe(0)
    const item = JSON.parse(added.out).evidence
    expect(item).toMatchObject({ kind: 'screenshot', by: 'worker', width: 1280, height: 800 }); expect(item.sha256).toMatch(/^[0-9a-f]{64}$/)
    const listed = JSON.parse((await cli(svc as never, ['ls', '--subtask', 'p1'])).out)
    expect(listed.evidence).toHaveLength(1); expect(listed.binding.treeClean).toBe(true)
    expect((await cli(svc as never, ['rm', '--subtask', 'p1', '--id', item.id])).code).toBe(0)
    expect(JSON.parse((await cli(svc as never, ['ls', '--subtask', 'p1'])).out).evidence).toHaveLength(0)
  })

  test('a probe by --probe-json, a refusal prints the service\'s code and exits 1, usage errors exit 2', async () => {
    const { svc } = makeWorld(root)
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'probe', '--probe-json', '{"kind":"bundle","literal":"a-literal-of-12+"}'])).code).toBe(0)
    const bad = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'probe', '--probe-json', '{"kind":"bundle","literal":"short"}'])
    expect(bad.code).toBe(1); expect(bad.err).toContain('evidence_invalid')
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'probe', '--probe-json', 'not json'])).code).toBe(2)
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot'])).code).toBe(2)                         // no payload
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', 'a', '--file-id', 'b'])).code).toBe(2) // two payloads
    expect((await cli(svc as never, ['add', '--kind', 'screenshot', '--file', 'a'])).code).toBe(2)                              // no --subtask
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'report', '--report-ref', 'garbage'])).code).toBe(2)
  })

  test('the CLI is not a way around the rules: a stranger session is refused, reuse is refused, an oversize file is refused before it is read', async () => {
    const { svc } = makeWorld(root)
    const f = join(root, 'a.png'); writeFileSync(f, png(1280, 800, 71))
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f], { AGENTOP_MANAGED_ID: 'stranger' })).err).toContain('evidence_forbidden')
    expect((await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f])).code).toBe(0)
    const reused = await cli(svc as never, ['add', '--subtask', 'p2', '--kind', 'screenshot', '--file', f], { AGENTOP_MANAGED_ID: 'worker2' })
    expect(reused.code).toBe(1); expect(reused.err).toContain('evidence_reused')
    const big = join(root, 'big.bin'); writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    const oversize = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', big])
    expect(oversize.code).toBe(2); expect(oversize.err).toMatch(/8 MB/)
  })

  test('F5/S0d: no PROVEN session is NOT the owner — unattributed is refused; an exported id the tree does not prove is refused; --owner needs the vault', async () => {
    const { svc } = makeWorld(root)
    const f = join(root, 'o.png'); writeFileSync(f, png(1280, 800, 72))
    const bare = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f], {})
    expect(bare.code).toBe(1); expect(bare.err).toContain('evidence_forbidden')
    const notProven: CliAuth = { prove: async () => false, stepUp: async () => true, interactive: true }
    const forged = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f], { AGENTOP_MANAGED_ID: 'worker' }, notProven)
    expect(forged.code).toBe(1); expect(forged.err).toContain('evidence_forbidden'); expect(forged.err).toContain('not running inside that session')
    const piped = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f, '--owner'], {}, proving({ stepUp: true, interactive: false }))
    expect(piped.code).toBe(1); expect(piped.err).toContain('interactive terminal')
    const owner = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'screenshot', '--file', f, '--owner'], {}, proving({ stepUp: true, interactive: true }))
    expect(owner.code).toBe(0); expect(JSON.parse(owner.out).evidence.by).toBe('owner')
    // A read needs no principal.
    expect((await cli(svc as never, ['ls', '--subtask', 'p1'], {}, { prove: async () => false, stepUp: async () => false, interactive: false })).code).toBe(0)
  })

  test('`agentop task evidence` is routed from `agentop task` (cli-task.ts) to this verb set', () => {
    const src = readFileSync(join(import.meta.dir, '../sessions/cli-task.ts'), 'utf8')
    expect(src).toMatch(/argv\[0\] === 'evidence'\) return \(await import\('\.\.\/delivery\/cli'\)\)\.runDeliveryCli\(\['task-evidence'/)
  })
})

describe('agentop evidence capture', () => {
  test('formatCapture output is exactly what the api-capture validator accepts', () => {
    const text = formatCapture({ method: 'GET', url: 'http://127.0.0.1:1/api/version?x=1', status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json'], ['X-Secret', 'nope']], body: '{"version":"2.211.0"}' })
    expect(text).toContain('GET /api/version?x=1 HTTP/1.1'); expect(text).toContain('HTTP/1.1 200 OK'); expect(text).toContain('content-type: application/json')
    expect(text).not.toContain('X-Secret'); expect(text).not.toContain('x-secret')
    expect(validateApiCapture(new TextEncoder().encode(text)).ok).toBe(true)
  })

  test('against a real server: --out writes a file that validates AND attaches as api-capture evidence', async () => {
    const api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ version: '2.211.0', ok: true }) })
    try {
      const out = join(root, 'cap.txt'); const c = io()
      expect(await runEvidenceCapture(['capture', `http://127.0.0.1:${api.port}/api/version`, '--out', out], c.io)).toBe(0)
      const bytes = readFileSync(out)
      expect(validateApiCapture(new Uint8Array(bytes)).ok).toBe(true)
      const { svc } = makeWorld(root)
      const added = await cli(svc as never, ['add', '--subtask', 'p1', '--kind', 'api-capture', '--file', out])
      expect(added.code).toBe(0); expect(JSON.parse(added.out).evidence.kind).toBe('api-capture')
    } finally { api.stop(true) }
  })

  test('to stdout without --out; a non-2xx is still captured (the status line is the evidence)', async () => {
    const api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('{"error":"nope"}', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }) })
    try {
      const c = io(); expect(await runEvidenceCapture(['capture', `http://127.0.0.1:${api.port}/api/x`], c.io)).toBe(0)
      expect(c.out.join('\n')).toContain('HTTP/1.1 404 Not Found')
    } finally { api.stop(true) }
  })

  test('refusals: usage, non-http scheme, unreachable server, empty body (it would not be accepted), oversize body', async () => {
    const c = () => io()
    expect(await runEvidenceCapture([], c().io)).toBe(2)
    expect(await runEvidenceCapture(['capture'], c().io)).toBe(2)
    expect(await runEvidenceCapture(['capture', 'file:///etc/passwd'], c().io)).toBe(2)
    expect(await runEvidenceCapture(['capture', 'not a url'], c().io)).toBe(2)
    expect(await runEvidenceCapture(['capture', 'http://127.0.0.1:9/api/x'], c().io)).toBe(1)
    const empty = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('', { status: 204 }) })
    const big = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x'.repeat(1024 * 1024 + 10)) })
    try {
      const e = c(); expect(await runEvidenceCapture(['capture', `http://127.0.0.1:${empty.port}/`], e.io)).toBe(1); expect(e.err.join(' ')).toContain('api-capture-empty-body')
      const b = c(); expect(await runEvidenceCapture(['capture', `http://127.0.0.1:${big.port}/`], b.io)).toBe(1); expect(b.err.join(' ')).toMatch(/1 MB/)
    } finally { empty.stop(true); big.stop(true) }
  })

  test('`agentop evidence` is wired in bin/cli.ts', () => {
    expect(readFileSync(join(import.meta.dir, '../../bin/cli.ts'), 'utf8')).toMatch(/command === 'evidence'[\s\S]{0,200}runEvidenceCapture\(args/)
  })
})
