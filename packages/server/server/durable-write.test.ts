import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableWriteFile, __setDurableWriteHooksForTest } from './durable-write'

describe('durableWriteFile', () => {
  it('publishes only after the temporary file is fsynced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentop-durable-'))
    const file = join(dir, 'state.json')
    let synced = false
    __setDurableWriteHooksForTest({ fsyncFile: async () => { synced = true }, rename: async (from, to) => {
      expect(synced).toBe(true)
      await import('node:fs/promises').then(fs => fs.rename(from, to))
    } })
    await durableWriteFile(file, '{}')
    expect(await readFile(file, 'utf8')).toBe('{}')
    __setDurableWriteHooksForTest(null)
  })

  it('does not rename after a failed fsync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentop-durable-'))
    const file = join(dir, 'state.json')
    let renamed = false
    __setDurableWriteHooksForTest({ fsyncFile: async () => { throw new Error('fsync failed') }, rename: async () => { renamed = true } })
    await expect(durableWriteFile(file, '{}')).rejects.toThrow('fsync failed')
    expect(renamed).toBe(false)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    __setDurableWriteHooksForTest(null)
  })
})
