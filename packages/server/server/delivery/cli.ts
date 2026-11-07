/**
 * delivery/cli.ts — the delivery flow's verbs at the command line. Exit code 0 = passed/moved, 1 = refused
 * (the sentence says what is missing), 2 = usage. These are the commands the DSL flows name as gates:
 *
 *   agentop flow gate <predispatch|vaga|salvo|qa-modelo|delecoes|release> --subtask S
 *   agentop flow phase <to> --subtask S [--verdict APROVADO|REPROVADO] [--findings …] [--reviewed-sha …] [--merge-sha …] [--detail …]
 *   agentop flow entrega [--subtask S]                         read one delivery, or list them
 *   agentop flow stage run --subtask S                         predispatch + vaga, start the staged session → executando
 *   agentop flow qa open --subtask S --harness H --model M [--account A] [--prompt …]
 *   agentop flow ajustes open --subtask S
 *   agentop flow wait qa-verdict --subtask S                   prints APROVADO|REPROVADO (exit 3 = no verdict yet; never waits)
 *   agentop flow merge --subtask S [--batch <version>]
 *   agentop flow block --subtask S --reason R --text …  |  agentop flow unblock --subtask S [--detail …]
 *   agentop flow approve --subtask S --phase P --decision approve|reject [--note …]   (the owner only)
 *   agentop flow release --version <x.y.z> --merge-sha <main sha> [--repo <owner/name>] --subtask S1 --subtask S2 …
 *                                  the leader DECLARES what a release contains: each piece → ci (legacy pieces adopted), and → publicado
 *                                  as soon as release.yml is green and the tag exists, with the release's own publish time. Idempotent.
 *   agentop flow tick
 *   agentop flow calendario [filters]                          the Delivery calendar (read-only), see `delivery/calendar.ts`
 *   agentop task stage <subtaskId> --prompt … --harness … --model … --effort … --account … [--cwd …]
 *
 * Runs in-process against the same store (cross-process lock), so it works with the server stopped and
 * without the experimental flows flag. The actor is the managed session this runs in (`AGENTOP_MANAGED_ID`),
 * else the owner at their own terminal.
 */
import type { DeliveryReply, DeliveryService } from './service'

/** What `agentop flow --help` prints about the delivery verbs (they live here, not in the engine, so the engine's help never lists them). */
export const DELIVERY_FLOW_HELP = `agentop flow — the DELIVERY verbs (one subtask walks fila → executando → qa → (ajuste ⇄ qa) → revisao_lider → pr_merge → ci → publicado; any skipped phase is refused)

  agentop flow gate <predispatch|vaga|salvo|qa-modelo|cabeca|delecoes|mergeado|release> --subtask S
  agentop flow phase <to> --subtask S [--verdict APROVADO|REPROVADO] [--findings …] [--reviewed-sha …] [--detail …]
  agentop flow entrega [--subtask S]                  read one delivery, or list them
  agentop flow stage run --subtask S                  predispatch + vaga, start the staged session → executando
  agentop flow qa open --subtask S --harness H --model M [--account A] [--prompt …]
  agentop flow ajustes open --subtask S
  agentop flow wait qa-verdict --subtask S            prints APROVADO|REPROVADO (exit 3 = none yet; never waits)
  agentop flow merge --subtask S [--batch <version>]  deletions gate, squash merge, then ci (the merge is verified on the host)
  agentop flow block --subtask S --reason R --text …  |  agentop flow unblock --subtask S [--detail …]   (unblock: the leader; an owner decision: the owner)
  agentop flow dequeue --subtask S --reason …          withdraw a queued piece, with an audit reason (leader only)
  agentop flow approve --subtask S --phase P --decision approve|reject [--note …]   (the owner only — the answer to a human gate)
  agentop flow release --version <x.y.z> --merge-sha <main sha> [--repo <owner/name>] --subtask S1 --subtask S2 …   declare what the release contains (→ ci, → publicado when release.yml is green and the tag exists)
  agentop flow tick                                   the minute watch (blocks, ci → publicado)
  agentop flow calendario [--task T] [--subtask S] [--version V] [--stage a,b] [--harness H] [--priority P] [--from d] [--to d] [--all] [--confirmed]
                                                      the Delivery calendar as JSON (read-only; same source as the screen and the MCP tool). Dates yyyy-MM-dd are BRT days.
  agentop task stage <subtaskId> --prompt … --harness … --model … --effort … --account … [--cwd …]

Exit codes: 0 passed/moved, 1 refused (the sentence says what is missing), 2 usage, 3 no verdict yet.
Every gate reads the machine (git, gh, the session registry); nothing here accepts a sha, a session id or a "green" from the caller.
`

export const DELIVERY_FLOW_VERBS = ['gate', 'phase', 'entrega', 'stage', 'qa', 'ajustes', 'wait', 'merge', 'block', 'unblock', 'dequeue', 'approve', 'release', 'tick', 'calendario'] as const

/** PURE: is `agentop flow <args>` one of the delivery verbs (handled here, not by the engine)? */
export function isDeliveryFlowVerb(args: readonly string[]): boolean {
  const v = args[0]
  if (v === 'help' || v === '--help' || v === '-h') return args.length === 1
  if (v === 'stage') return args[1] === 'run'
  if (v === 'qa' || v === 'ajustes') return args[1] === 'open'
  if (v === 'wait') return args[1] === 'qa-verdict'
  return (DELIVERY_FLOW_VERBS as readonly string[]).includes(v ?? '')
}

/** PURE: `--key value` pairs (kebab → camel); bare words stay positional. */
export function parseFlags(args: readonly string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [], flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) { pos.push(a); continue }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[key] = 'true'; continue }
    flags[key] = next; i++
  }
  return { pos, flags }
}

type Io = { out(line: string): void; err(line: string): void }
const STD: Io = { out: l => process.stdout.write(`${l}\n`), err: l => process.stderr.write(`${l}\n`) }

function report(r: DeliveryReply, io: Io): number {
  if (r.ok) {
    io.out(JSON.stringify({ ok: true, phase: r.record.phase, revision: r.record.revision, ...(r.gate ? { evidence: r.gate.evidence } : {}), ...(r.skipped ? { skipped: r.skipped } : {}), warnings: r.warnings }, null, 2))
    return 0
  }
  io.err(`${r.code}: ${r.sentence}`)
  if (r.missing.length) io.err(`missing: ${r.missing.join('; ')}`)
  return r.status === 400 ? 2 : 1
}

export async function runDeliveryCli(argv: readonly string[], io: Io = STD, env: Record<string, string | undefined> = process.env, service?: DeliveryService): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { io.out(DELIVERY_FLOW_HELP.trimEnd()); return 0 }
  const svc = service ?? (await import('./host')).deliveryService()
  const actor = env.AGENTOP_MANAGED_ID || 'owner'
  const isTaskStage = argv[0] === 'task-stage'
  const { pos, flags } = parseFlags(isTaskStage ? argv.slice(1) : argv)
  const sub = flags.subtask ?? (isTaskStage ? pos[0] : undefined)
  const needSub = () => { if (!sub) { io.err('--subtask <id> is required'); return false } return true }
  if (isTaskStage) {
    if (!needSub()) return 2
    const draft: Record<string, unknown> = {}
    for (const k of ['prompt', 'harness', 'model', 'effort', 'account', 'cwd']) if (flags[k]) draft[k] = flags[k]
    return report(await svc.stage(sub!, draft, actor, { ...(env.AGENTOP_MANAGED_ID ? { leaderSessionId: env.AGENTOP_MANAGED_ID } : {}), ...(flags.version ? { versionTarget: flags.version } : {}), ...(flags.pedido ? { pedidoId: flags.pedido } : {}) }), io)
  }
  const verb = pos[0]
  switch (verb) {
    case 'gate': if (!needSub() || !pos[1]) { io.err('usage: agentop flow gate <name> --subtask S'); return 2 } return report(await svc.gate(sub!, pos[1], actor), io)
    case 'phase': {
      if (!needSub() || !pos[1]) { io.err('usage: agentop flow phase <to> --subtask S'); return 2 }
      return report(await svc.transition(sub!, pos[1], {
        ...(flags.verdict === 'APROVADO' || flags.verdict === 'REPROVADO' ? { verdict: flags.verdict } : {}),
        ...(flags.findings ? { findings: flags.findings } : {}), ...(flags.reviewedSha ? { reviewedSha: flags.reviewedSha } : {}),
        ...(flags.mergeSha ? { mergeSha: flags.mergeSha } : {}), ...(flags.detail ? { detail: flags.detail } : {}),
      }, actor), io)
    }
    case 'entrega': {
      if (sub) { const r = await svc.get(sub); if (!r) { io.err(`no delivery record for ${sub}`); return 1 } io.out(JSON.stringify(r, null, 2)); return 0 }
      for (const r of await svc.list()) io.out(`${r.subtaskId}\t${r.phase}${r.origin ? `←${r.origin}` : ''}\trev ${r.revision}\t${r.versionTarget ?? ''}${r.block ? `\t${r.block.reason}` : ''}`)
      return 0
    }
    case 'stage': if (!needSub()) return 2; return report(await svc.stageRun(sub!, actor), io)
    case 'qa': {
      if (!needSub()) return 2
      return report(await svc.qaOpen(sub!, {
        harness: flags.harness, model: flags.model, ...(flags.account ? { account: flags.account } : {}), ...(flags.effort ? { effort: flags.effort } : {}),
        prompt: flags.prompt ?? `QA da entrega ${sub}: teste de forma independente o sha entregue em agentop run --rm, com evidência, e dê o veredito com agentistics_task_phase action=phase to=revisao_lider verdict=APROVADO (ou to=ajuste verdict=REPROVADO) e findings.`,
      }, actor), io)
    }
    case 'ajustes': if (!needSub()) return 2; return report(await svc.ajustesOpen(sub!, actor), io)
    case 'wait': {
      if (!needSub()) return 2
      const r = await svc.get(sub!)
      // Non-blocking: the verdict is a fact on the record or it is not there yet. Nobody sleeps here.
      if (!r?.qa || r.phase === 'qa') { io.err('no QA verdict yet'); return 3 }
      io.out(r.qa.verdict); return 0
    }
    case 'merge': {
      if (!needSub()) return 2
      if (flags.batch) await svc.configure(sub!, { versionTarget: flags.batch }, actor)
      return report(await svc.merge(sub!, actor), io)
    }
    case 'block': if (!needSub()) return 2; return report(await svc.block(sub!, flags.reason, flags.text ?? '', actor), io)
    case 'unblock': if (!needSub()) return 2; return report(await svc.unblock(sub!, actor, flags.detail), io)
    case 'dequeue': if (!needSub()) return 2; return report(await svc.dequeue(sub!, flags.reason, actor), io)
    case 'approve': if (!needSub()) return 2; return report(await svc.approve(sub!, flags.phase, flags.decision, flags.note, !env.AGENTOP_MANAGED_ID), io)
    case 'release': {
      const subs = argv.flatMap((a, i) => (a === '--subtask' && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? [argv[i + 1]!] : []))
      const r = await svc.release({ version: flags.version, mergeSha: flags.mergeSha, ...(flags.repo ? { repo: flags.repo } : {}), subtaskIds: subs }, actor)
      if (r.ok) { io.out(JSON.stringify({ ok: true, version: r.version, tag: r.tag, mergeSha: r.mergeSha, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}), pieces: r.pieces, warnings: r.warnings }, null, 2)); return 0 }
      return report(r, io)
    }
    case 'calendario': {
      // The Delivery calendar, filtered — the same read the screen and `agentistics_delivery_calendar` use. Read-only.
      const { deliveryCalendar, answerCalendar, calendarFiltersOf } = await import('./calendar')
      const q = new URLSearchParams()
      for (const [flag, param] of [['task', 'task'], ['subtask', 'subtask'], ['version', 'version'], ['stage', 'stage'], ['harness', 'harness'], ['priority', 'priority'], ['from', 'from'], ['to', 'to']] as const) if (flags[flag]) q.set(param, flags[flag]!)
      if (flags.all === 'true') q.set('all', '1')
      if (flags.confirmed === 'true') q.set('confirmed', '1')
      io.out(JSON.stringify(answerCalendar(await deliveryCalendar(), calendarFiltersOf(q)), null, 2)); return 0
    }
    case 'tick': io.out(JSON.stringify(await svc.tick(), null, 2)); return 0
    default: io.err('unknown delivery verb'); return 2
  }
}
