import { describe, expect, test } from 'bun:test'
import {
  readComposerMenuFolded, visibleComposerMenuGroups, writeComposerMenuFolded,
  type ComposerMenuGroupId,
} from './composerMenuGroups'

describe('visibleComposerMenuGroups', () => {
  const base = { answeringNow: false, dictationReady: true, hasModel: true }

  test('shows mobile history in Mensagem, but keeps desktop row behavior', () => {
    expect(visibleComposerMenuGroups({ ...base, isMobile: true, hasPrompts: true })).toEqual(['message', 'model', 'notifications'])
    expect(visibleComposerMenuGroups({ ...base, isMobile: false, hasPrompts: true })).toEqual(['model', 'notifications'])
  })

  test('shows dictation refusal as Mensagem and omits unavailable model groups', () => {
    expect(visibleComposerMenuGroups({ ...base, isMobile: false, dictationReady: false, hasModel: false, hasPrompts: false })).toEqual(['message', 'notifications'])
  })

  test('answering a question hides the whole menu', () => {
    expect(visibleComposerMenuGroups({ ...base, isMobile: true, answeringNow: true, hasPrompts: true })).toEqual([])
  })
})

describe('composer menu fold persistence', () => {
  test('round trips valid group ids and ignores malformed values', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } as Storage
    const folded = new Set<ComposerMenuGroupId>(['message', 'notifications'])
    writeComposerMenuFolded(folded, storage)
    expect(readComposerMenuFolded(storage)).toEqual(folded)
    values.set('agentistics-composer-menu-folded-v1', '["model","nope",3]')
    expect(readComposerMenuFolded(storage)).toEqual(new Set(['model']))
  })
})
