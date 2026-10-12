import { describe, expect, test } from 'bun:test'
import { fileInFolder, folderTree, resolveFolders, callerIsLeader, folderLineText, type FolderDeps } from './cli-folder'
import type { Preferences } from '../preferences'

const mk = (): { deps: FolderDeps; prefs: Preferences } => {
  const prefs = {
    sessionGroups: { groups: [
      { id: 'g1', name: 'Eng', sessionKeys: [] },
      { id: 'g2', name: 'Workers', parentId: 'g1', sessionKeys: [] },
      { id: 'g3', name: 'Finalizadas', parentId: 'g1', sessionKeys: [] },
      { id: 'g4', name: 'Ops', sessionKeys: [] },
      { id: 'g5', name: 'Workers', parentId: 'g4', sessionKeys: [] },
    ] },
    pinnedSessions: [],
  } as unknown as Preferences
  const deps: FolderDeps = {
    read: async () => prefs,
    update: async mutate => { const patch = mutate(prefs); if (patch) Object.assign(prefs, patch); return prefs },
  }
  return { deps, prefs }
}

describe('resolveFolders', () => {
  test('by id, exact name and Parent/Child path (case-insensitive)', async () => {
    const { deps } = mk()
    const r = await resolveFolders(['g4', 'ops', 'eng/workers', 'ENG'], deps)
    expect(r.ok && [...r.byRef.values()].map(v => v.id)).toEqual(['g4', 'g4', 'g2', 'g1'])
  })
  test('ambiguous bare name lists "Parent/Child (id)" candidates and refuses', async () => {
    const r = await resolveFolders(['Workers'], mk().deps)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain('Eng/Workers (g2)')
    expect(!r.ok && r.message).toContain('Ops/Workers (g5)')
  })
  test('unknown refuses, lists folders, creates nothing', async () => {
    const { deps, prefs } = mk()
    const r = await resolveFolders(['nope'], deps)
    expect(!r.ok && r.message).toContain('No folder matches "nope"')
    expect(!r.ok && r.message).toContain('Eng/Finalizadas (g3)')
    expect((prefs.sessionGroups as { groups: unknown[] }).groups).toHaveLength(5)
  })
  test('siblings are the other folders under the same parent', async () => {
    const r = await resolveFolders(['eng/workers'], mk().deps)
    expect(r.ok && r.byRef.get('eng/workers')!.siblings).toEqual(['Eng/Finalizadas'])
  })
})

describe('fileInFolder / folderTree', () => {
  test('files a session, moving it out of its previous folder', async () => {
    const { deps, prefs } = mk()
    expect(await fileInFolder('g2', { id: 's1', conversationId: 'c1' }, deps)).toBe(true)
    expect(await fileInFolder('g3', { id: 's1', conversationId: 'c1' }, deps)).toBe(true)
    const groups = (prefs.sessionGroups as { groups: { id: string; sessionKeys: string[] }[] }).groups
    expect(groups.find(g => g.id === 'g2')!.sessionKeys).toEqual([])
    expect(groups.find(g => g.id === 'g3')!.sessionKeys).toHaveLength(1)
  })
  test('prints the tree with counts', async () => {
    const { deps } = mk()
    await fileInFolder('g2', { id: 's1' }, deps)
    const lines = (await folderTree(deps)).map(folderLineText)
    expect(lines[0]).toBe('Eng (g1) · 0 sessions')
    expect(lines[1]).toBe('Eng/Workers (g2) · 1 session')
  })
})

describe('leader warning', () => {
  test('only a leader caller', async () => {
    const conv = async () => 'c9'
    expect(await callerIsLeader('s', async () => 'leader', conv)).toBe(true)
    expect(await callerIsLeader('s', async () => 'worker', conv)).toBe(false)
    expect(await callerIsLeader(undefined, async () => 'leader', conv)).toBe(false)
  })
})
