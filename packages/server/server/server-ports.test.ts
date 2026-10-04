import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_PORTS_FILE, bounceTarget, isOwnersStore, readServerPorts, recordServerPorts } from './server-ports'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('a config bounce restarts THIS data dir\'s server, on its own ports', () => {
  test('the server records its ports (0600) and they read back; garbage reads as none', async () => {
    const d = await mkdtemp(join(tmpdir(), 'agentistics-ports-')); dirs.push(d)
    expect(await readServerPorts(d)).toBeNull()
    await recordServerPorts(d, { pid: 4242, port: 48791, webPort: 48792 })
    expect(await readServerPorts(d)).toEqual({ pid: 4242, port: 48791, webPort: 48792 })
    expect((await stat(join(d, SERVER_PORTS_FILE))).mode & 0o777).toBe(0o600)
    await writeFile(join(d, SERVER_PORTS_FILE), '{"pid":"x"}')
    expect(await readServerPorts(d)).toBeNull()
  })
  test('no lock holder: nothing to restart — never "whatever answers on the default port"', () => {
    expect(bounceTarget({ lockHolder: null, recorded: { pid: 1, port: 48791, webPort: 48792 }, cliPort: 47291, cliWebPort: 47292 })).toEqual({ kind: 'none' })
  })
  test('a preview (isolated HOME, no PORT in the shell) bounces its own server on its own ports', () => {
    expect(bounceTarget({ lockHolder: 900, recorded: { pid: 900, port: 48791, webPort: 48792 }, cliPort: 47291, cliWebPort: 47292 }))
      .toEqual({ kind: 'server', pid: 900, port: 48791, webPort: 48792, fromRecord: true })
  })
  test('a stale record (another pid) is not trusted: the CLI\'s own ports, marked as such', () => {
    expect(bounceTarget({ lockHolder: 901, recorded: { pid: 900, port: 48791, webPort: 48792 }, cliPort: 47291, cliWebPort: 47292 }))
      .toEqual({ kind: 'server', pid: 901, port: 47291, webPort: 47292, fromRecord: false })
  })
  test('only the owner\'s own store may touch the installed service unit', () => {
    expect(isOwnersStore('/home/o/.agentistics', '/home/o')).toBe(true)
    expect(isOwnersStore('/home/o/.agentistics/', '/home/o')).toBe(true)
    expect(isOwnersStore('/tmp/pv/home/.agentistics', '/home/o')).toBe(false)
  })
})
