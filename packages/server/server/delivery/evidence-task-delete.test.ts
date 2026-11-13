import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitEnv } from './git-env'

// Fresh config/module graph per case; the real task-web door and persistent TaskFiles are exercised.
async function scenario(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-task-delete-'))
  const script = `
    import { mock } from 'bun:test';
    const base = ${JSON.stringify(join(import.meta.dir, '..'))};
    const cfg = await import(base + '/config.ts');
    const { createTaskStore } = await import(base + '/sessions/task-store.ts');
    const { createDeliveryStore } = await import(base + '/delivery/store.ts');
    const { newDelivery } = await import(base + '/delivery/machine.ts');
    const { deliveryService } = await import(base + '/delivery/host.ts');
    const { evidenceDeleteRequest } = await import(base + '/delivery/evidence-delete.ts');
    const { withEvidenceDeletion } = await import(base + '/delivery/evidence-delete.ts');
    const store = createTaskStore(cfg.TASKS_FILE);
    const { writeFile, readFile, stat } = await import('node:fs/promises');
    const at = new Date().toISOString();
    await store.upsertTask({ id: 't1', title: 'T', status: 'todo', createdAt: at, updatedAt: at });
    const source = await import(base + '/sessions/task-source.ts');
    const web = await import(base + '/sessions/task-web.ts');
    ${body}
  `
  try {
    const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...cleanGitEnv(), AGENTISTICS_DIR: dir, AGENTISTICS_TASKS_FILE: join(dir, 'tasks.json'), AGENTISTICS_DELIVERIES_FILE: join(dir, 'deliveries.json') }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code, err).toBe(0)
    return JSON.parse(out.trim().split('\n').at(-1)!)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const protectedFile = `
  const f = await web.attachFile('t1', { name: 'proof.txt', bytes: new TextEncoder().encode('proof') });
  const ds = createDeliveryStore();
  await ds.update(doc => { const r = newDelivery({ taskId: 't1', subtaskId: 'p1', at }); r.evidence = [{ id: 'e1', fileId: f, sha256: 'hash', revision: 1 }]; doc.deliveries.p1 = r; });
  await writeFile(cfg.AGENTISTICS_DATA_DIR + '/guards.json', JSON.stringify({ version: 1, checkpoints: { p1: { key: 'p1', rank: 1, transitionId: 'tr', auth: [{ kind: 'evidence', ids: ['e1'] }] } }, intents: {} }));
`

test('F1 task-web aggregate delete refuses evidence_in_use and preserves all records/bytes', async () => {
  const result = await scenario(protectedFile + `
    let error; try { await web.deleteTask('t1') } catch (e) { error = e.code }
    console.log(JSON.stringify({ error, task: (await store.read()).tasks.length, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ error: 'evidence_in_use', task: 1, files: 1, bytes: true })
})

test('F1 individual TaskFile door refuses evidence_in_use and preserves bytes', async () => {
  const result = await scenario(protectedFile + `
    let error; try { await web.removeFile(f) } catch (e) { error = e.code }
    console.log(JSON.stringify({ error, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ error: 'evidence_in_use', files: 1, bytes: true })
})

for (const corruption of ['JSON', 'IO']) test(`F2 task-file REST delete refuses ${corruption} deliveries and leaves bytes`, async () => {
  const result = await scenario(protectedFile + `
    const { rm, mkdir } = await import('node:fs/promises');
    if (${JSON.stringify(corruption)} === 'JSON') await writeFile(ds.path, '{invalid');
    else { await rm(ds.path); await mkdir(ds.path); }
    const response = await evidenceDeleteRequest(() => web.removeFile(f));
    console.log(JSON.stringify({ status: response.status, error: response.body.error, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ status: 409, error: 'evidence_in_use', files: 1, bytes: true })
})

test('F1 task-delete REST adapter returns 409 without deleting the task', async () => {
  const result = await scenario(protectedFile + `
    const response = await evidenceDeleteRequest(() => web.deleteTask('t1'));
    console.log(JSON.stringify({ status: response.status, error: response.body.error, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ status: 409, error: 'evidence_in_use', files: 1, bytes: true })
})

test('F1 MCP task_delete reaches the protected aggregate REST delete', async () => {
  const result = await scenario(protectedFile + `
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const result = await evidenceDeleteRequest(() => web.deleteTask('t1'));
      return Response.json(result.body, { status: result.status });
    } });
    const client = new Client({ name: 'delete-probe', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [base + '/../../mcp/agentistics-mcp.ts'], env: { ...process.env, AGENTISTICS_API: 'http://127.0.0.1:' + api.port }, stderr: 'pipe' }));
      const out = await client.callTool({ name: 'agentistics_task_delete', arguments: { ref: 't1' } });
      console.log(JSON.stringify({ isError: out.isError, error: out.content[0].text.includes('evidence_in_use'), files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
    } finally { await client.close(); api.stop(true); }
  `)
  expect(result).toEqual({ isError: true, error: true, files: 1, bytes: true })
}, 15000)

test('F6 attachFile rolls bytes back when addFile fails', async () => {
  const result = await scenario(`
    const world = await source.loadTaskWorld();
    world.store.addFile = async () => { throw new Error('injected addFile failure') };
    mock.module(base + '/sessions/task-source.ts', () => ({ ...source, loadTaskWorld: async () => world }));
    let error; try { await web.attachFile('t1', { name: 'failed.txt', bytes: new TextEncoder().encode('bytes') }); } catch(e) { error = e.message }
    const { readdir } = await import('node:fs/promises');
    console.log(JSON.stringify({ error, files: (await store.read()).files.length, bytes: await readdir(cfg.AGENTISTICS_DATA_DIR + '/task-files/t1').catch(() => []) }));
  `)
  expect(result).toEqual({ error: 'injected addFile failure', files: 0, bytes: [] })
})

test('F3 file deletion keeps authorization locks through byte removal', async () => {
  const result = await scenario(`
    const f = await web.attachFile('t1', { name: 'plain.txt', bytes: new TextEncoder().encode('bytes') });
    let writer;
    await store.removeFile(f, remove => withEvidenceDeletion({ fileId: f }, async () => {
      await remove();
      const code = 'const { withGuardLocks } = await import(' + JSON.stringify(base + '/delivery/guard-locks.ts') + '); try { await withGuardLocks(["deliveries", "guards"], async () => {}, { waitMs: 30 }); console.log("acquired") } catch(e) { console.log(e.code) }';
      const child = Bun.spawn([process.execPath, '-e', code], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
      writer = (await new Response(child.stdout).text()).trim();
      await child.exited;
      const { deleteTaskFile } = await import(base + '/sessions/task-files.ts');
      await deleteTaskFile('t1', f);
      return true;
    }));
    console.log(JSON.stringify({ writer, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ writer: 'guard_busy', files: 0, bytes: false })
})

test('F3 a pending intent protects both file and aggregate task deletion', async () => {
  const result = await scenario(protectedFile + `
    const guardsPath = cfg.AGENTISTICS_DATA_DIR + '/guards.json';
    const doc = JSON.parse(await readFile(guardsPath, 'utf8'));
    doc.intents.p1 = { transitionId: 'tr', target: doc.checkpoints.p1 };
    doc.checkpoints = {};
    await writeFile(guardsPath, JSON.stringify(doc));
    const file = await evidenceDeleteRequest(() => web.removeFile(f));
    const task = await evidenceDeleteRequest(() => web.deleteTask('t1'));
    console.log(JSON.stringify({ file: file.status, task: task.status, files: (await store.read()).files.length, bytes: !!(await web.fetchFile(f)) }));
  `)
  expect(result).toEqual({ file: 409, task: 409, files: 1, bytes: true })
})

test('F6 rollback cleanup failure preserves the persistence error and cleanup error', async () => {
  const result = await scenario(`
    const world = await source.loadTaskWorld();
    world.store.addFile = async () => { throw new Error('persist failed') };
    mock.module(base + '/sessions/task-source.ts', () => ({ ...source, loadTaskWorld: async () => world }));
    const files = await import(base + '/sessions/task-files.ts');
    mock.module(base + '/sessions/task-files.ts', () => ({ ...files, deleteTaskFile: async () => { throw new Error('cleanup failed') } }));
    let out;
    try { await web.attachFile('t1', { name: 'failed.txt', bytes: new TextEncoder().encode('bytes') }); }
    catch(e) { out = { name: e.name, errors: e.errors?.map(x => x.message) } }
    console.log(JSON.stringify(out));
  `)
  expect(result).toEqual({ name: 'AggregateError', errors: ['persist failed', 'cleanup failed'] })
})

test('F6 strict byte cleanup exposes unlink permission errors', async () => {
  const result = await scenario(`
    const f = await web.attachFile('t1', { name: 'failed.txt', bytes: new TextEncoder().encode('bytes') });
    const { chmod } = await import('node:fs/promises');
    const { deleteTaskFile } = await import(base + '/sessions/task-files.ts');
    const parent = cfg.AGENTISTICS_DATA_DIR + '/task-files/t1';
    let error;
    try { await chmod(parent, 0o555); await deleteTaskFile('t1', f, true); } catch(e) { error = e.code }
    finally { await chmod(parent, 0o755) }
    console.log(JSON.stringify({ error }));
  `)
  expect(result).toEqual({ error: 'EACCES' })
})
