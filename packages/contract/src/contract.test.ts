// Holds this package to the contract it ships (the Cloud runs the mirror image in
// services/cloud/test/contract/wire-v1.test.ts):
//   - the spec + fixtures bytes match CONTRACT.lock for the spec's version (same digest both sides);
//   - the typed constants in index.ts equal the spec's `x-agentistics-constants`;
//   - every fixture body the Cloud must accept validates against the spec's request schema, with
//     the same dependency-free checker the Cloud uses.
// What it cannot check here — that the Cloud answers as the fixtures say — the Cloud's suite does.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as C from './index.ts'
import { unknownKeywords, validate, type Schema } from './json-schema.ts'

const ROOT = join(import.meta.dir, '..')
const SPEC_FILE = 'openapi/machine-v1.yaml'
const FIXTURE_DIR = 'fixtures/v1'

const spec = Bun.YAML.parse(await Bun.file(join(ROOT, SPEC_FILE)).text()) as any
const K = spec['x-agentistics-constants']

/** sha256 over every contract file (path, NUL, bytes, NUL), in path order — the Cloud computes the same. */
async function contractDigest(dir: string): Promise<string> {
  const files = [SPEC_FILE, ...(await readdir(join(dir, FIXTURE_DIR))).filter((f) => f.endsWith('.json')).map((f) => `${FIXTURE_DIR}/${f}`)].sort()
  const hash = createHash('sha256')
  for (const f of files) hash.update(`${f}\0`).update(new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer())).update('\0')
  return hash.digest('hex')
}

describe('@agentistics/contract', () => {
  test('the shipped spec and fixtures are the locked bytes of this version', async () => {
    const lock = (await Bun.file(join(ROOT, 'CONTRACT.lock')).json()) as { machine: Record<string, string> }
    expect(spec.info.version).toBe(C.CONTRACT_VERSION)
    expect(await contractDigest(ROOT)).toBe(lock.machine[C.CONTRACT_VERSION]!)
  })

  test('the typed constants are the spec’s', () => {
    expect(K.contractVersion).toBe(C.CONTRACT_VERSION)
    expect(K.clientId).toBe(C.MACHINE_CLIENT_ID)
    expect(K.deviceCodeGrant).toBe(C.DEVICE_CODE_GRANT)
    expect(K.dpop).toEqual({ ...C.DPOP })
    const { deviceCodeExpiresInS, pollIntervalS, slowDownIncrementS, accessTokenExpiresInS, refreshIdleDays, userCodeAlphabet, maxFormBytes } = K
    expect({ deviceCodeExpiresInS, pollIntervalS, slowDownIncrementS, accessTokenExpiresInS, refreshIdleDays, userCodeAlphabet, maxFormBytes }).toEqual({ ...C.PAIRING })
    expect(K.machineKinds).toEqual([...C.MACHINE_KINDS])
    expect(K.flowNames).toEqual([...C.FLOW_NAMES])
    expect(K.defaultFlows).toEqual(C.DEFAULT_FLOWS)
    expect(K.backup).toEqual({ ...C.BACKUP })
    const { sampleMetrics, t2Fields, sessionStatuses, contentFields, ...limits } = K.metrics
    expect(limits).toEqual({ ...C.METRICS })
    expect(sampleMetrics).toEqual([...C.SAMPLE_METRICS])
    expect(t2Fields).toEqual([...C.T2_FIELDS])
    expect(sessionStatuses).toEqual([...C.SESSION_STATUSES])
    expect(contentFields).toEqual([...C.CONTENT_FIELDS])
  })

  test('PATHS names exactly the spec’s paths', () => {
    expect((Object.values(C.PATHS) as string[]).sort()).toEqual(Object.keys(spec.paths).sort())
  })

  test('the session type declares every field the spec does', () => {
    // A compile-time list kept next to the interface; a field added to the spec without the type fails here.
    const declared: (keyof C.SessionMetrics)[] = [
      'session_id', 'harness', 'seq', 'project_path', 'start_time', 'git_remote', 'model', 'end_time', 'duration_minutes',
      'active_minutes', 'user_message_count', 'assistant_message_count', 'user_chars', 'user_char_messages', 'assistant_chars',
      'assistant_char_messages', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
      'cache_creation_1h_input_tokens', 'cache_creation_5m_input_tokens', 'context_tokens', 'context_window', 'compact_count',
      'compact_ms', 'compact_dropped_tokens', 'cost_usd', 'tool_counts', 'tool_output_tokens', 'tool_errors',
      'tool_error_categories', 'skill_uses', 'mcp_tool_call_count', 'mcp_tool_names', 'languages', 'git_commits', 'git_pushes',
      'lines_added', 'lines_removed', 'files_modified', 'user_interruptions', 'user_response_times', 'message_hours',
      'user_message_timestamps', 'uses_task_agent', 'uses_mcp', 'uses_web_search', 'uses_web_fetch', 'daily', 'model_usage',
      'title', 'first_prompt', 'user_label', 'user_note',
    ]
    expect(([...declared] as string[]).sort()).toEqual(Object.keys(spec.components.schemas.SessionMetrics.properties).sort())
  })

  test('every schema stays inside the checker’s keyword subset', () => {
    expect(Object.entries(spec.components.schemas as Record<string, Schema>).flatMap(([n, s]) => unknownKeywords(s, n))).toEqual([])
  })

  test('every fixture body the Cloud must accept validates against the request schema', async () => {
    const ops = new Map<string, any>()
    for (const item of Object.values(spec.paths) as Record<string, any>[]) for (const op of Object.values(item)) ops.set(op.operationId, op)
    const names = (await readdir(join(ROOT, FIXTURE_DIR))).filter((f) => f.endsWith('.json'))
    expect(names.length).toBeGreaterThan(0)
    const problems: string[] = []
    for (const name of names) {
      const fixture = (await Bun.file(join(ROOT, FIXTURE_DIR, name)).json()) as { contract: string; steps: { operation: string; body?: unknown; expect: { status: number } }[] }
      expect(fixture.contract.split('.')[0]).toBe(C.CONTRACT_VERSION.split('.')[0])
      for (const [i, step] of fixture.steps.entries()) {
        const op = ops.get(step.operation)
        if (!op) problems.push(`${name} step ${i}: unknown operation ${step.operation}`)
        else if (step.body !== undefined && step.expect.status < 300) {
          const schema = (Object.values(op.requestBody.content)[0] as { schema: Schema }).schema
          problems.push(...validate(spec, schema, step.body, `${name} step ${i}`))
        }
      }
    }
    expect(problems).toEqual([])
  })
})
