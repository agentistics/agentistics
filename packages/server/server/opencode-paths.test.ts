import { describe, expect, test } from 'bun:test'
import { opencodePaths } from './opencode-paths'

describe('opencodePaths — the rule opencode itself follows (1.17.9)', () => {
  test('default', () => expect(opencodePaths({}, '/h')).toEqual({ dir: '/h/.local/share/opencode', dbPath: '/h/.local/share/opencode/opencode.db' }))
  test('XDG_DATA_HOME moves the store', () => expect(opencodePaths({ XDG_DATA_HOME: '/x' }, '/h')).toEqual({ dir: '/x/opencode', dbPath: '/x/opencode/opencode.db' }))
  test('OPENCODE_DB is the exact file and wins over XDG_DATA_HOME', () => expect(opencodePaths({ OPENCODE_DB: '/d/a.db', XDG_DATA_HOME: '/x' }, '/h')).toEqual({ dir: '/d', dbPath: '/d/a.db' }))
  test('OPENCODE_DB_PATH is ignored — opencode ignores it', () => expect(opencodePaths({ OPENCODE_DB_PATH: '/nope/o.db' }, '/h').dbPath).toBe('/h/.local/share/opencode/opencode.db'))
  test('OPENCODE_DIR is agentistics\'s own override of the directory', () => expect(opencodePaths({ OPENCODE_DIR: '/o', XDG_DATA_HOME: '/x' }, '/h')).toEqual({ dir: '/o', dbPath: '/o/opencode.db' }))
  test('empty values are unset', () => expect(opencodePaths({ OPENCODE_DB: '', XDG_DATA_HOME: '', OPENCODE_DIR: '' }, '/h').dbPath).toBe('/h/.local/share/opencode/opencode.db'))
})
