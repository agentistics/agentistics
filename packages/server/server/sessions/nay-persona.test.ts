import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveNayPersona, validateNayWorkingDir } from './nay-persona'

describe('Nay persona settings', () => {
  test('analytics is the default and uses the generated Nay directory', async () => {
    expect(await resolveNayPersona({}, '/tmp/nay-chat')).toEqual({ responder: 'analytics', cwd: '/tmp/nay-chat', label: 'Nay', mcpEnabled: true })
  })

  test('own-agent accepts an existing absolute directory without creating anything', async () => {
    const root = await mkdtemp('/tmp/nay-own-agent-')
    const before = await readdir(root)
    const persona = await resolveNayPersona({ chatResponder: 'own-agent', chatWorkingDir: root, chatLabel: 'Project helper' }, '/tmp/nay-chat')
    const after = await readdir(root)
    expect(persona).toEqual({ responder: 'own-agent', cwd: root, label: 'Project helper', mcpEnabled: false })
    expect(after).toEqual(before)
  })

  test('refuses missing, relative and file paths', async () => {
    const root = await mkdtemp('/tmp/nay-own-agent-')
    const file = join(root, 'file')
    await writeFile(file, '')
    await mkdir(join(root, 'dir'))
    expect(await validateNayWorkingDir(join(root, 'missing'))).toBeNull()
    expect(await validateNayWorkingDir('relative')).toBeNull()
    expect(await validateNayWorkingDir(file)).toBeNull()
    expect(await validateNayWorkingDir(join(root, 'dir'))).toBe(join(root, 'dir'))
    await expect(resolveNayPersona({ chatResponder: 'own-agent', chatWorkingDir: join(root, 'missing') }, '/tmp/nay-chat')).rejects.toThrow()
  })
})
