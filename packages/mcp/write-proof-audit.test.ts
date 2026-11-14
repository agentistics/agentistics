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

test('S0d integration: apiSend\'s injection proves a TASK write only when nothing in the handler can pre-empt it', () => {
  const t = { transportProvesTaskWrites: true }
  for (const ok of [
    'await apiSend("POST", "/api/tasks", { title: a.title });',
    'await apiSend("DELETE", `/api/tasks/types/${id}`);',
    'const path = `/api/tasks/${r}/subtasks`; await apiSend("POST", path, edit(false));',
    'const patch: Record<string, unknown> = {}; patch[f] = a[f]; await apiSend("POST", `/api/tasks/${ref}`, patch);',
    'await apiSend("POST", "/api/task-files/x", { ...(c ? { k: 1 } : {}) });',
  ]) expect(proofAudit(ok, false, t), ok).toBe(true)
  for (const bad of [
    'await apiSend("POST", "/api/tasks", { session: undefined });',                         // an explicit non-proof session
    'await apiSend("POST", "/api/tasks", { session: null, title: 1 });',
    'const session = 1; await apiSend("POST", "/api/tasks", { session });',                 // shorthand
    'const b = { t: 1 }; b.session = x; await apiSend("POST", "/api/tasks", b);',          // assigned later
    'const b = { t: 1 }; b["session"] = x; await apiSend("POST", "/api/tasks", b);',
    'const b = { t: 1 }; delete b.t; await apiSend("POST", "/api/tasks", b);',              // R5 shapes
    'const b = { t: 1 }; Object.assign(b, o); await apiSend("POST", "/api/tasks", b);',
    'await apiSend("POST", "/api/tasks", { [k]: v });',                                     // computed key
    'await apiSend("POST", "/api/tasks", { ...a });',                                       // raw tool arguments
    'await apiSend("POST", "/api/tasks", { ...(args as any) });',
    'await apiSend("POST", "/api/deliveries/x", { action: "gate" });',                      // not a task route: needs explicit proof
    'await apiSend("POST", "/api/tasksX", { title: 1 });',                                  // a look-alike route
    'const p = somewhere(); await apiSend("POST", p, { title: 1 });',                      // a path it cannot read
  ]) expect(proofAudit(bad, false, t), bad).toBe(false)
  // Without the option (apiSend NOT injecting) nothing is proven by the transport.
  expect(proofAudit('await apiSend("POST", "/api/tasks", { title: a.title });')).toBe(false)
})

test('F8 proof must reach each write payload, directly or through an audited builder', () => {
  expect(proofAudit('await apiSend("POST", "/api/tasks", { session: sessionProof(process.env) });')).toBe(true)
  expect(proofAudit('const req = evidenceRequestOf(a, sessionProof(process.env)); await apiSend("POST", "/api/tasks/a/evidence", req.body);')).toBe(true)
  expect(proofAudit('const req = evidenceRequestOf(a, undefined); sessionProof(process.env); await apiSend("POST", "/api/tasks/a/evidence", req.body);')).toBe(false)
})
