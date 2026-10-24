import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { readProcCards } from './resources/proc-card'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() >= end) throw new Error('condition timed out'); await sleep(10) }
}
const root = mkdtempSync(join(tmpdir(), 'helper-hotswap-'))
beforeAll(() => {
  for (const version of ['v1', 'v2']) {
    const result = spawnSync(process.execPath, ['build', '--compile', join(import.meta.dir, 'helper-hotswap.fixture.ts'), '--define', `FIXTURE_VERSION=${JSON.stringify(version)}`, '--outfile', join(root, version)], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
}, 60_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function channel(stream: NodeJS.ReadableStream, send: (line: string) => void) {
  const messages: any[] = []
  let buf = ''
  stream.on('data', data => {
    buf += data.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1)
    }
  })
  return {
    messages,
    send: (msg: unknown) => send(`${JSON.stringify(msg)}\n`),
    wait: async (fn: (msg: any) => boolean) => { await until(() => messages.some(fn)); return messages.find(fn) },
  }
}

function install(dir: string, version: string): string {
  const bin = join(dir, 'agentop')
  copyFileSync(join(root, version), `${bin}.new`); renameSync(`${bin}.new`, bin)
  return bin
}

test('compiled MCP changes worker at idle without a host handshake; bad binary keeps serving', async () => {
  const dir = mkdtempSync(join(root, 'mcp-')), bin = install(dir, 'v1')
  const child = spawn(bin, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FIXTURE_DIR: dir } })
  let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data })
  const c = channel(child.stdout, line => child.stdin.write(line))
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'host', version: '1' }, protocolVersion: '2024-11-05' } })
    await c.wait(m => m.id === 1)
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { delay: 400 } })
    await until(() => existsSync(join(dir, 'request-started')))
    install(dir, 'v2')
    await until(() => existsSync(join(dir, 'initialized-v2')))
    expect((await c.wait(m => m.id === 2)).result).toEqual({ version: 'v1', initialized: true })
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call' })
    expect((await c.wait(m => m.id === 3)).result).toEqual({ version: 'v2', initialized: true })
    // There was exactly one externally visible initialize response.
    expect(c.messages.filter(m => m.result?.serverInfo)).toHaveLength(1)
    writeFileSync(`${bin}.new`, '#!/bin/sh\nexit 1\n'); chmodSync(`${bin}.new`, 0o755); renameSync(`${bin}.new`, bin)
    await until(() => diagnostics.includes('hot-swap failed'))
    c.send({ jsonrpc: '2.0', id: 4, method: 'tools/call' })
    expect((await c.wait(m => m.id === 4)).result.version).toBe('v2')
    expect(child.exitCode).toBeNull()
  } finally { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())) }
}, 15_000)

test('compiled relay preserves live socket, child and replay cursor while protocol worker changes', async () => {
  const dir = mkdtempSync(join(root, 'relay-')), bin = install(dir, 'v1')
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ bin: '/bin/cat', args: [], cwd: dir }))
  const relay = spawn(bin, ['__structured-relay', dir], { stdio: 'ignore' })
  let sock: Socket | undefined
  try {
    await until(() => existsSync(join(dir, 'relay.pid')))
    const identity = readFileSync(join(dir, 'relay.pid'), 'utf8')
    sock = connect(join(dir, 'relay.sock'))
    await new Promise<void>((resolve, reject) => { sock!.once('connect', resolve); sock!.once('error', reject) })
    const c = channel(sock, line => sock!.write(line))
    c.send({ hello: { from: 0 } }); await c.wait(m => m.version === 'v1')
    c.send({ w: 'first\n', replayAt: 0 }); await c.wait(m => m.o === 'first')
    install(dir, 'v2')
    await sleep(200)
    c.send({ w: 'second\n', replayAt: 6 }); await c.wait(m => m.o === 'second')
    await c.wait(m => m.version === 'v2')
    c.send({ w: 'first\n', replayAt: 0 }); await sleep(100)
    expect(c.messages.filter(m => m.o === 'first')).toHaveLength(1)
    expect(readFileSync(join(dir, 'relay.pid'), 'utf8')).toBe(identity)
    expect(sock.destroyed).toBe(false)
    expect(readFileSync(join(dir, 'in.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  } finally {
    sock?.destroy(); relay.kill('SIGTERM')
    await new Promise<void>(resolve => relay.once('close', () => resolve()))
  }
}, 15_000)

test('production CLI forwarder initializes the real MCP SDK and lists its tools', async () => {
  const child = spawn(process.execPath, ['run', join(import.meta.dir, '../bin/cli.ts'), 'mcp'], {
    stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, AGENTOP_MCP_WORKER: '', AGENTISTICS_API: 'http://127.0.0.1:9' },
  })
  const c = channel(child.stdout, line => child.stdin.write(line))
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'test', version: '1' }, protocolVersion: '2024-11-05' } })
    expect((await c.wait(m => m.id === 1)).result.serverInfo).toBeDefined()
    if (process.platform === 'linux') expect(readProcCards().get(child.pid!)?.helperHotSwap).toBe(true)
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((await c.wait(m => m.id === 2)).result.tools.length).toBeGreaterThan(0)
  } finally { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())) }
}, 10_000)

test('relay drains output and exit when the child ends during a slow hello replay', async () => {
  const dir = mkdtempSync(join(root, 'relay-tail-')), bin = install(dir, 'v1')
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ bin: '/bin/sh', args: ['-c', 'sleep 0.1; echo final-tail'], cwd: dir }))
  const relay = spawn(bin, ['__structured-relay', dir], { stdio: 'ignore', env: { ...process.env, FIXTURE_REPLAY_DELAY: '400' } })
  let sock: Socket | undefined
  try {
    await until(() => existsSync(join(dir, 'relay.pid')))
    sock = connect(join(dir, 'relay.sock'))
    await new Promise<void>((resolve, reject) => { sock!.once('connect', resolve); sock!.once('error', reject) })
    const c = channel(sock, line => sock!.write(line))
    c.send({ hello: { from: 0 } })
    await c.wait(m => m.x === 0)
    expect(c.messages.filter(m => m.o === 'final-tail')).toHaveLength(1)
    expect(c.messages.findIndex(m => m.o === 'final-tail')).toBeLessThan(c.messages.findIndex(m => m.x === 0))
  } finally {
    sock?.destroy()
    if (relay.exitCode === null) { relay.kill('SIGTERM'); await new Promise<void>(resolve => relay.once('close', () => resolve())) }
  }
}, 10_000)

test('compiled MCP survives worker crash, fails uncertain RPC, and keeps the host connection', async () => {
  const dir = mkdtempSync(join(root, 'mcp-crash-')), bin = install(dir, 'v1')
  const child = spawn(bin, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, FIXTURE_DIR: dir } })
  const c = channel(child.stdout, line => child.stdin.write(line))
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); await c.wait(m => m.id === 1)
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    c.send({ jsonrpc: '2.0', id: 2, method: 'fixture/never' })
    await until(() => existsSync(join(dir, 'request-started')))
    const oldPid = Number(readFileSync(join(dir, 'worker.pid'), 'utf8'))
    process.kill(oldPid, 'SIGKILL')
    expect((await c.wait(m => m.id === 2)).error.code).toBe(-32603)
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect((await c.wait(m => m.id === 3)).result.initialized).toBe(true)
    expect(Number(readFileSync(join(dir, 'worker.pid'), 'utf8'))).not.toBe(oldPid)
    expect(c.messages.filter(m => m.result?.serverInfo)).toHaveLength(1)
    expect(child.exitCode).toBeNull()
  } finally { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())) }
}, 10_000)

test('compiled MCP cancelled unanswered request does not prevent a swap', async () => {
  const dir = mkdtempSync(join(root, 'mcp-cancel-')), bin = install(dir, 'v1')
  const child = spawn(bin, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, FIXTURE_DIR: dir } })
  const c = channel(child.stdout, line => child.stdin.write(line))
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); await c.wait(m => m.id === 1)
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    c.send({ jsonrpc: '2.0', id: 2, method: 'fixture/never' })
    await until(() => existsSync(join(dir, 'request-started')))
    install(dir, 'v2'); await until(() => existsSync(join(dir, 'initialized-v2')))
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect((await c.wait(m => m.id === 3)).result.version).toBe('v2')
  } finally { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())) }
}, 10_000)

test('compiled relay retries a decision after worker crash without killing child or duplicating input', async () => {
  const dir = mkdtempSync(join(root, 'relay-crash-')), bin = install(dir, 'v1')
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ bin: '/bin/cat', args: [], cwd: dir }))
  const relay = spawn(bin, ['__structured-relay', dir], {
    stdio: 'ignore', env: { ...process.env, FIXTURE_DIR: dir, FIXTURE_DECISION_GATE: '1' },
  })
  let sock: Socket | undefined
  try {
    await until(() => existsSync(join(dir, 'relay.pid')) && existsSync(join(dir, 'worker.pid')))
    const identity = readFileSync(join(dir, 'relay.pid'), 'utf8')
    sock = connect(join(dir, 'relay.sock'))
    await new Promise<void>((resolve, reject) => { sock!.once('connect', resolve); sock!.once('error', reject) })
    const c = channel(sock, line => sock!.write(line))
    c.send({ hello: { from: 0 } }); await c.wait(m => m.version === 'v1')
    c.send({ w: 'once\n', replayAt: 0 })
    await until(() => existsSync(join(dir, 'decision-started')))
    const pid = Number(readFileSync(join(dir, 'worker.pid'), 'utf8'))
    install(dir, 'v2')
    process.kill(pid, 'SIGKILL')
    await until(() => Number(readFileSync(join(dir, 'worker.pid'), 'utf8')) !== pid)
    writeFileSync(join(dir, 'release-decision'), '')
    await c.wait(m => m.o === 'once')
    await c.wait(m => m.version === 'v2')
    c.send({ w: 'after\n', replayAt: 5 }); await c.wait(m => m.o === 'after')
    expect(readFileSync(join(dir, 'relay.pid'), 'utf8')).toBe(identity)
    expect(Number(readFileSync(join(dir, 'worker.pid'), 'utf8'))).not.toBe(pid)
    expect(c.messages.filter(m => m.o === 'once')).toHaveLength(1)
    expect(readFileSync(join(dir, 'in.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(sock.destroyed).toBe(false)
  } finally {
    sock?.destroy(); relay.kill('SIGTERM')
    await new Promise<void>(resolve => relay.once('close', () => resolve()))
  }
}, 10_000)

test('production relay worker rejects malformed JSON and keeps answering', async () => {
  const file = join(import.meta.dir, 'sessions/relay-worker.ts')
  const worker = spawn(process.execPath, ['-e', `import {runRelayWorker} from ${JSON.stringify(file)}; runRelayWorker()`], { stdio: ['pipe', 'pipe', 'ignore'] })
  const c = channel(worker.stdout, line => worker.stdin.write(line))
  try {
    worker.stdin.write('bad json\nnull\n')
    c.send({ id: 1, method: 'ready' })
    expect((await c.wait(m => m.id === 1)).result).toBe(true)
    expect(worker.exitCode).toBeNull()
  } finally { worker.kill(); await new Promise<void>(resolve => worker.once('close', () => resolve())) }
}, 10_000)
