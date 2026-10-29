import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { flowStatusResponse } from './status'
import { flowStatusRunId } from '../../../mcp/flow-status'

test('HTTP rejects traversal and malformed IDs with 400 before engine status', async () => {
  for (const id of ['../../x', '..\\x', 'bad', '%', '00000000-0000-0000-0000-00000000000z']) {
    let calls = 0
    const out = await flowStatusResponse(encodeURIComponent(id), async () => { calls++; return null })
    expect(out.status).toBe(400)
    expect(calls).toBe(0)
    expect(() => flowStatusRunId(id)).toThrow('invalid flow run id')
  }
  expect((await flowStatusResponse('%', async () => null)).status).toBe(400)
})

test('HTTP and MCP accept a minted UUID and distinguish missing runs', async () => {
  const id = crypto.randomUUID()
  expect(flowStatusRunId(id)).toBe(id)
  expect((await flowStatusResponse(id, async () => null)).status).toBe(404)
  const record = { runId: id, status: 'refused' }
  expect(await flowStatusResponse(id, async runId => { expect(runId).toBe(id); return record })).toEqual({ body: record, status: 200 })
})

test('MCP entrypoint parses with the flow status import', () => {
  const source = readFileSync(new URL('../../../mcp/agentistics-mcp.ts', import.meta.url), 'utf8')
  expect(() => new Bun.Transpiler({ loader: 'ts' }).scan(source)).not.toThrow()
})
