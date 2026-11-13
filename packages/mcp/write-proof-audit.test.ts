import { expect, test } from 'bun:test'
import { proofAudit } from './write-proof-audit'

test('F8 discarded proof, comments and read-only branches cannot prove a write', () => {
  for (const source of [
    'sessionProof(process.env); await apiSend("POST", "/api/tasks", { title: a.title });',
    '// sessionProof(process.env)\n await apiSend("POST", "/api/tasks", {});',
    'if (a.action === "list") { sessionProof(process.env); return apiGet("/api/tasks"); } await apiSend("POST", "/api/tasks", {});',
    'await apiSend("POST", "/api/tasks", { session: undefined });',
    'await apiSend("POST", "/api/tasks", { session: sessionProof(process.env), ...a });',
    'await apiSend("POST", "/api/tasks", { session: sessionProof(process.env), session: undefined });',
    'const payload = { session: sessionProof(process.env) }; payload.session = undefined; await apiSend("POST", "/api/tasks", payload);',
    'await apiSend("POST", "/api/tasks", { session: sessionProof(process.env) }); await apiSend("DELETE", "/api/tasks/a");',
  ]) expect(proofAudit(source)).toBe(false)
})

test('F8 proof must reach each write payload, directly or through an audited builder', () => {
  expect(proofAudit('await apiSend("POST", "/api/tasks", { session: sessionProof(process.env) });')).toBe(true)
  expect(proofAudit('const req = evidenceRequestOf(a, sessionProof(process.env)); await apiSend("POST", "/api/tasks/a/evidence", req.body);')).toBe(true)
  expect(proofAudit('const req = evidenceRequestOf(a, undefined); sessionProof(process.env); await apiSend("POST", "/api/tasks/a/evidence", req.body);')).toBe(false)
})
