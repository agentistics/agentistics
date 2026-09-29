import { describe, expect, test } from 'bun:test'
import { runEndedEvent, runStartedEvent, sessionEndedEvent, sessionStartedEvent } from './lifecycle.ts'

const CTX = { adapterVersion: 'runtime@test', occurredAt: '2026-09-27T00:00:00.000Z', recordedAt: '2026-09-27T00:00:00.000Z' }

describe('session/lifecycle — pure builders', () => {
  test('session.started: shape, provenance, and no message content anywhere', () => {
    const e = sessionStartedEvent('ses_1', { origin: 'native', title: 'hi', projectPath: '/ws' }, CTX)
    expect(e.type).toBe('session.started')
    expect(e.sessionId).toBe('ses_1')
    expect(e.provenance).toEqual({ mode: 'native', confidence: 'exact', adapterVersion: 'runtime@test', sourceRef: 'session:ses_1' })
    expect(e.source).toEqual({ kind: 'runtime', id: 'agentistics' })
    expect(e.data).toEqual({ origin: 'native', title: 'hi', projectPath: '/ws' })
  })

  test('session.ended carries no data', () => {
    const e = sessionEndedEvent('ses_1', CTX)
    expect(e.type).toBe('session.ended')
    expect(e.data).toEqual({})
  })

  test('run.started names the run and the session, harness agentistics, conversationLink none', () => {
    const e = runStartedEvent('ses_1', 'run_1', { harness: 'agentistics', conversationLink: 'none', cwd: '/ws' }, CTX)
    expect(e.sessionId).toBe('ses_1')
    expect(e.runId).toBe('run_1')
    expect(e.provenance.sourceRef).toBe('run:run_1')
    expect(e.data).toEqual({ harness: 'agentistics', conversationLink: 'none', cwd: '/ws' })
  })

  test('run.ended never carries `running`', () => {
    const e = runEndedEvent('ses_1', 'run_1', 'completed', CTX)
    expect(e.data).toEqual({ status: 'completed' })
  })

  test('ids are STABLE — the same transition, built twice, hashes to the same eventId', () => {
    const a = sessionStartedEvent('ses_1', { origin: 'native' }, CTX)
    const b = sessionStartedEvent('ses_1', { origin: 'native' }, CTX)
    expect(a.eventId).toBe(b.eventId)

    const ra = runStartedEvent('ses_1', 'run_1', { harness: 'agentistics', conversationLink: 'none' }, CTX)
    const rb = runStartedEvent('ses_1', 'run_1', { harness: 'agentistics', conversationLink: 'none' }, CTX)
    expect(ra.eventId).toBe(rb.eventId)
  })

  test('ids DIFFER across sessions, across runs, and across types of the same subject', () => {
    const s1 = sessionStartedEvent('ses_1', { origin: 'native' }, CTX)
    const s2 = sessionStartedEvent('ses_2', { origin: 'native' }, CTX)
    expect(s1.eventId).not.toBe(s2.eventId)

    const started = runStartedEvent('ses_1', 'run_1', { harness: 'agentistics', conversationLink: 'none' }, CTX)
    const ended = runEndedEvent('ses_1', 'run_1', 'completed', CTX)
    expect(started.eventId).not.toBe(ended.eventId)

    const otherRun = runStartedEvent('ses_1', 'run_2', { harness: 'agentistics', conversationLink: 'none' }, CTX)
    expect(started.eventId).not.toBe(otherRun.eventId)
  })

  test('every eventId is 32 lowercase hex characters', () => {
    const e = sessionStartedEvent('ses_1', { origin: 'native' }, CTX)
    expect(e.eventId).toMatch(/^[0-9a-f]{32}$/)
  })
})
