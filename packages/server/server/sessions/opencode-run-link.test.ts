import { describe, expect, test } from 'bun:test'
import { linkOpencodeProcesses, parseOpencodeRuns, START_SKEW_MS } from './opencode-run-link'

// Lines copied from opencode 1.19.5's own log, captured under tmux on 2026-10-31 (throwaway HOME).
const DIR = '/home/u/proj'
const real = [
  `timestamp=2026-10-31T01:15:14.318Z level=INFO run=2c3fc2e4 message="creating instance" directory=${DIR}`,
  `timestamp=2026-10-31T01:15:14.320Z level=INFO run=2c3fc2e4 message=fromDirectory directory=${DIR}`,
  `timestamp=2026-10-31T01:15:22.088Z level=INFO run=2c3fc2e4 message=created id=ses_e70797397ffeSYPpraVLuN7l9J slug=calm-otter version=1.19.5 projectID=global directory=${DIR} path="" workspaceID=undefined parentID=undefined title="New session - 2026-10-31T01:15:22.088Z"`,
  `timestamp=2026-10-31T01:15:22.125Z level=INFO run=2c3fc2e4 message=loop session.id=ses_e70797397ffeSYPpraVLuN7l9J step=0`,
  `timestamp=2026-10-31T01:15:23.048Z level=INFO run=2c3fc2e4 message=process session.id=ses_e70797397ffeSYPpraVLuN7l9J messageID=msg_18f868c92001argq7LwuLpr1nW`,
].join('\n')
const START = Date.parse('2026-10-31T01:15:14.000Z')

describe('parseOpencodeRuns', () => {
  test('a run opens on "creating instance" and keeps the last session it named', () => {
    const runs = parseOpencodeRuns(real)
    expect([...runs.keys()]).toEqual(['2c3fc2e4'])
    const r = runs.get('2c3fc2e4')!
    expect(r.directory).toBe(DIR)
    expect(r.startMs).toBe(Date.parse('2026-10-31T01:15:14.318Z'))
    expect(r.sessionId).toBe('ses_e70797397ffeSYPpraVLuN7l9J')
  })

  test('a run whose opening line was cut off is never a candidate', () => {
    const tail = real.split('\n').slice(2).join('\n')
    expect(parseOpencodeRuns(tail).size).toBe(0)
  })

  test('a quoted directory with a space is read whole', () => {
    const runs = parseOpencodeRuns(`timestamp=2026-10-31T01:15:14.318Z level=INFO run=ab message="creating instance" directory="/home/u/my proj"`)
    expect(runs.get('ab')!.directory).toBe('/home/u/my proj')
  })

  test('a subagent session (parentID=ses_…) never becomes the run\'s session', () => {
    const child = 'ses_e70700000ffeCHILDchildCHILD01'
    const runs = parseOpencodeRuns([
      real,
      `timestamp=2026-10-31T01:16:00.000Z level=INFO run=2c3fc2e4 message=created id=${child} slug=x version=1.19.5 projectID=global directory=${DIR} parentID=ses_e70797397ffeSYPpraVLuN7l9J title="sub"`,
      `timestamp=2026-10-31T01:16:00.100Z level=INFO run=2c3fc2e4 message=loop session.id=${child} step=0`,
    ].join('\n'))
    expect(runs.get('2c3fc2e4')!.sessionId).toBe('ses_e70797397ffeSYPpraVLuN7l9J')
  })

  test('/new: the run follows the session it names last', () => {
    const next = 'ses_e70800000ffeNEXTnextNEXTnx01'
    const runs = parseOpencodeRuns(`${real}\ntimestamp=2026-10-31T01:20:00.000Z level=INFO run=2c3fc2e4 message=loop session.id=${next} step=0`)
    expect(runs.get('2c3fc2e4')!.sessionId).toBe(next)
  })

  test('junk lines are skipped', () => {
    expect(parseOpencodeRuns('garbage\n\nlevel=INFO run=zz\n').size).toBe(0)
  })
})

describe('linkOpencodeProcesses', () => {
  const runs = parseOpencodeRuns(real)

  test('the process that started in that folder at that moment gets the run\'s session', () => {
    expect(linkOpencodeProcesses([{ pid: 7, cwd: DIR, startedMs: START }], runs).get(7)).toBe('ses_e70797397ffeSYPpraVLuN7l9J')
  })

  test('another folder, a far start time, or no start time: no answer', () => {
    expect(linkOpencodeProcesses([{ pid: 7, cwd: '/elsewhere', startedMs: START }], runs).size).toBe(0)
    expect(linkOpencodeProcesses([{ pid: 7, cwd: DIR, startedMs: START + START_SKEW_MS + 1000 }], runs).size).toBe(0)
    expect(linkOpencodeProcesses([{ pid: 7, cwd: DIR }], runs).size).toBe(0)
  })

  test('two processes on one run: neither is linked', () => {
    const out = linkOpencodeProcesses([{ pid: 7, cwd: DIR, startedMs: START }, { pid: 8, cwd: DIR, startedMs: START + 200 }], runs)
    expect(out.size).toBe(0)
  })

  test('two candidate runs for one process: no answer', () => {
    const two = parseOpencodeRuns(`${real}\ntimestamp=2026-10-31T01:15:15.000Z level=INFO run=ffff message="creating instance" directory=${DIR}\ntimestamp=2026-10-31T01:15:30.000Z level=INFO run=ffff message=loop session.id=ses_e70900000ffeOTHERotherOTH01 step=0`)
    expect(linkOpencodeProcesses([{ pid: 7, cwd: DIR, startedMs: START }], two).size).toBe(0)
  })

  test('a run that has named no session yet (before the first message): no answer', () => {
    const fresh = parseOpencodeRuns(real.split('\n').slice(0, 2).join('\n'))
    expect(linkOpencodeProcesses([{ pid: 7, cwd: DIR, startedMs: START }], fresh).size).toBe(0)
  })
})
