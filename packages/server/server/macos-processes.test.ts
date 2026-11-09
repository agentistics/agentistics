import { describe, expect, test } from 'bun:test'
import {
  cwdFromLsof, etimeToMs, macExecutable, parseLsofFields, parsePsList, processStartFromEtime, splitPsCommand,
} from './macos-processes'
import { harnessOfProcess } from './live-sessions'

describe('parsePsList', () => {
  test('parses pid, etime, comm from ps -axwwo pid=,etime=,comm=', () => {
    const raw = [
      '  1234 03:12 /usr/local/bin/claude',
      ' 56789 1-04:03:12 node',
      '    42 00:05 bun',
    ].join('\n')
    expect(parsePsList(raw)).toEqual([
      { pid: 1234, etime: '03:12', comm: '/usr/local/bin/claude' },
      { pid: 56789, etime: '1-04:03:12', comm: 'node' },
      { pid: 42, etime: '00:05', comm: 'bun' },
    ])
  })

  test('a comm containing spaces is kept whole, not split', () => {
    const raw = ' 100 00:01 /Applications/Some App.app/Contents/MacOS/binary'
    expect(parsePsList(raw)).toEqual([
      { pid: 100, etime: '00:01', comm: '/Applications/Some App.app/Contents/MacOS/binary' },
    ])
  })

  test('blank lines and unparseable lines are skipped', () => {
    const raw = '\n  not a pid line\n 5 00:01 sh\n'
    expect(parsePsList(raw)).toEqual([{ pid: 5, etime: '00:01', comm: 'sh' }])
  })

  test('empty input yields an empty list', () => {
    expect(parsePsList('')).toEqual([])
  })
})

describe('etimeToMs', () => {
  test('mm:ss', () => {
    expect(etimeToMs('03:12')).toBe((3 * 60 + 12) * 1000)
  })

  test('hh:mm:ss', () => {
    expect(etimeToMs('04:03:12')).toBe(((4 * 60 + 3) * 60 + 12) * 1000)
  })

  test('dd-hh:mm:ss', () => {
    expect(etimeToMs('1-04:03:12')).toBe((((24 + 4) * 60 + 3) * 60 + 12) * 1000)
  })

  test('an unrecognised shape is undefined, never a guessed number', () => {
    expect(etimeToMs('')).toBeUndefined()
    expect(etimeToMs('garbage')).toBeUndefined()
  })
})

describe('processStartFromEtime', () => {
  test('subtracts elapsed time from now', () => {
    const now = 1_000_000
    expect(processStartFromEtime('00:01', now)).toBe(now - 1000)
  })

  test('undefined when etime cannot be parsed, never a zero start time', () => {
    expect(processStartFromEtime('???', 1_000_000)).toBeUndefined()
  })
})

describe('splitPsCommand', () => {
  test('splits a joined argv string on whitespace', () => {
    expect(splitPsCommand('claude --resume abc-123')).toEqual(['claude', '--resume', 'abc-123'])
  })

  test('collapses doubled spaces instead of producing empty tokens', () => {
    expect(splitPsCommand('claude  --resume  abc-123')).toEqual(['claude', '--resume', 'abc-123'])
  })

  test('trims leading and trailing whitespace', () => {
    expect(splitPsCommand('  node script.js  ')).toEqual(['node', 'script.js'])
  })
})

describe('parseLsofFields', () => {
  test('parses one process block with its cwd (lsof -a -d cwd -Fpn)', () => {
    const raw = ['p1234', 'fcwd', 'n/Users/dev/project'].join('\n')
    const byPid = parseLsofFields(raw)
    expect(byPid.get(1234)).toEqual(['/Users/dev/project'])
  })

  test('parses several process blocks with several open files each', () => {
    const raw = [
      'p1234',
      'f10',
      'n/Users/dev/project',
      'f11',
      'n/Users/dev/project/.claude/sessions/1234.json',
      'p5678',
      'f9',
      'n/Users/dev/other',
    ].join('\n')
    const byPid = parseLsofFields(raw)
    expect(byPid.get(1234)).toEqual([
      '/Users/dev/project',
      '/Users/dev/project/.claude/sessions/1234.json',
    ])
    expect(byPid.get(5678)).toEqual(['/Users/dev/other'])
  })

  test('a pid with no open files reported is present with an empty list, not absent', () => {
    const raw = 'p999'
    expect(parseLsofFields(raw).get(999)).toEqual([])
  })

  test('empty input yields an empty map', () => {
    expect(parseLsofFields('').size).toBe(0)
  })
})

describe('cwdFromLsof', () => {
  test('returns the single path lsof named for that pid', () => {
    const byPid = new Map([[1234, ['/Users/dev/project']]])
    expect(cwdFromLsof(byPid, 1234)).toBe('/Users/dev/project')
  })

  test('undefined when the pid is absent or named nothing', () => {
    const byPid = new Map([[1234, [] as string[]]])
    expect(cwdFromLsof(byPid, 1234)).toBeUndefined()
    expect(cwdFromLsof(byPid, 9999)).toBeUndefined()
  })
})

// OPENCODE.ATIVAS-TUI — `ps -o comm=` names the path the process was EXECUTED by, which for an npm/nvm/volta install
// is a symlink; Linux reads `/proc/<pid>/exe`, already resolved. Without resolving it, a 2.x TUI installed with
// `npm i -g @opencode/cli` under nvm matched no install layout and was never seen at all.
describe('macExecutable — the ps path resolved like /proc/<pid>/exe', () => {
  const NVM_BIN = '/Users/u/.nvm/versions/node/v22.11.0/bin/opencode'
  const REAL = '/Users/u/.nvm/versions/node/v22.11.0/lib/node_modules/@opencode/cli/bin/opencode.exe'
  const resolve = (p: string) => (p === NVM_BIN ? REAL : undefined)

  test('a symlinked opencode 2.x is resolved and recognised', () => {
    expect(harnessOfProcess('opencode', NVM_BIN, [NVM_BIN])).toBeUndefined() // the bug: the link itself is no layout
    expect(macExecutable(NVM_BIN, resolve)).toBe(REAL)
    expect(harnessOfProcess('opencode', macExecutable(NVM_BIN, resolve), [NVM_BIN])).toBe('opencode')
  })

  test('the real path read back by ps (opencode.exe) is recognised too', () => {
    expect(harnessOfProcess('opencode.exe', REAL, [REAL])).toBe('opencode')
    expect(harnessOfProcess('opencode.exe', REAL, [REAL, 'serve', '--service'])).toBeUndefined()
  })

  test('a relative or unresolvable path is kept as it is', () => {
    expect(macExecutable('opencode', resolve)).toBe('opencode')
    expect(macExecutable('/usr/local/bin/claude', resolve)).toBe('/usr/local/bin/claude')
  })
})
