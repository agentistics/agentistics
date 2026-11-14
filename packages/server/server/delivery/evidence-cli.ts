/**
 * delivery/evidence-cli.ts — `agentop task evidence add|ls|rm` (spec §3.4). Same service the REST route and the MCP tool reach;
 * this file only reads the flags (and the file, capped at 8 MB before it is read) and prints what the service answered.
 *
 *   agentop task evidence add --subtask S --kind screenshot --file shot.png
 *   agentop task evidence add --subtask S --kind report --report-ref <repo>@<sha>:<path>
 *   agentop task evidence add --subtask S --kind probe --probe-json '{"kind":"bundle","literal":"…"}'
 *   agentop task evidence ls --subtask S
 *   agentop task evidence rm --subtask S --id ev-…
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { DeliveryService } from './service'

type Io = { out(line: string): void; err(line: string): void }
export const EVIDENCE_CLI_MAX_BYTES = 8 * 1024 * 1024

export const EVIDENCE_CLI_HELP = `agentop task evidence — the proof a piece needs before it can move to review.

  agentop task evidence add --subtask S --kind screenshot|api-capture|test-log|report|probe
         ( --file <path> | --file-id <TaskFile id> | --report-ref <repo>@<sha>:<path> | --probe-json '<json>' )
  agentop task evidence ls --subtask S
  agentop task evidence rm --subtask S --id ev-…

The server validates the bytes, computes the hash and binds the item to the piece's verified commit; you supply neither.
Capture an API response for an api-capture with:  agentop evidence capture <url> --out capture.txt`

function parseRepoRef(s: string): { repo: string; sha: string; path: string } | null {
  const m = /^(.+)@([0-9a-f]{7,40}):(.+)$/i.exec(s)
  return m ? { repo: m[1]!, sha: m[2]!, path: m[3]! } : null
}

export async function runEvidenceCli(svc: DeliveryService, argv: readonly string[], flags: Record<string, string>, io: Io, actor: string): Promise<number> {
  const verb = argv[0]
  if (!verb || verb === 'help' || verb === '--help') { io.out(EVIDENCE_CLI_HELP); return verb ? 0 : 2 }
  const piece = flags.subtask
  if (!piece) { io.err('--subtask <piece> is required'); return 2 }
  const show = (r: { ok: false; code: string; sentence: string }): number => { io.err(`${r.code}: ${r.sentence}`); return 1 }

  if (verb === 'ls') {
    const r = await svc.evidenceList(piece)
    if (!r.ok) return show(r)
    io.out(JSON.stringify({ ok: true, evidence: r.evidence, binding: r.binding }, null, 2)); return 0
  }
  if (verb === 'rm') {
    if (!flags.id) { io.err('--id <evidence id> is required'); return 2 }
    const r = await svc.evidenceRemove(piece, flags.id, actor)
    if (!r.ok) return show(r)
    io.out(JSON.stringify({ ok: true })); return 0
  }
  if (verb !== 'add') { io.err(EVIDENCE_CLI_HELP); return 2 }
  if (!flags.kind) { io.err('--kind is required'); return 2 }
  const payloads = ['file', 'fileId', 'reportRef', 'probeJson'].filter(k => flags[k] !== undefined)
  if (payloads.length !== 1) { io.err('name exactly ONE payload: --file, --file-id, --report-ref or --probe-json'); return 2 }
  const input: Record<string, unknown> = { kind: flags.kind }
  if (flags.file) {
    let size: number
    try { size = statSync(flags.file).size } catch { io.err(`cannot read ${flags.file}`); return 2 }
    if (size > EVIDENCE_CLI_MAX_BYTES) { io.err(`${flags.file} is ${size} bytes; an upload is limited to 8 MB`); return 2 }
    input.bytesBase64 = readFileSync(flags.file).toString('base64'); input.name = flags.name ?? basename(flags.file)
  } else if (flags.fileId) input.fileId = flags.fileId
  else if (flags.reportRef) {
    const ref = parseRepoRef(flags.reportRef)
    if (!ref) { io.err('--report-ref must look like <repo>@<sha>:<path>'); return 2 }
    input.repoRef = ref
  } else {
    try { input.probe = JSON.parse(flags.probeJson!) } catch { io.err('--probe-json is not valid JSON'); return 2 }
  }
  const r = await svc.evidenceAdd(piece, input, actor)
  if (!r.ok) return show(r)
  io.out(JSON.stringify({ ok: true, evidence: r.evidence, ...(r.warnings.length ? { warnings: r.warnings } : {}) }, null, 2))
  return 0
}
