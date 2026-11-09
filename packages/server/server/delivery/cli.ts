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
  agentop flow fila [--task T] [--json]                the queue in leaving order (priority, then arrival), with holds and open questions
  agentop flow fila responder --subtask S "sim" | "nao <motivo>" | "agendar <ISO> <motivo>"   answer the queue's question (leader or owner)
  agentop flow fila proximo                            run the queue flow now (a worker ended)
  agentop flow approve --subtask S --phase P --decision approve|reject [--note …]   (the owner only — the answer to a human gate)
  agentop flow release --version <x.y.z> --merge-sha <main sha> [--repo <owner/name>] --subtask S1 --subtask S2 …   declare what the release contains (→ ci, → publicado when release.yml is green and the tag exists)
  agentop flow reconcile --release [--apply] [--json]  backfill: every piece in revisao_lider/pr_merge/ci matched to its merged PR and the first release tag containing it (dry-run unless --apply)
  agentop flow antigas publish|archive (--subtask S[,S…] | --all [--expect N]) [--version x.y.z] [--reason …]   the "Antigas sem registro" group: mark published / archive (abandoned) — never deletes; --expect refuses if the group is not that size
  agentop flow tick                                   the minute watch (blocks, merged PR → ci, ci → publicado, reminders to the leader)
  agentop task stage <subtaskId> --prompt … --harness … --model … --effort … --account … [--cwd …]

Exit codes: 0 passed/moved, 1 refused (the sentence says what is missing), 2 usage, 3 no verdict yet.
Every gate reads the machine (git, gh, the session registry); nothing here accepts a sha, a session id or a "green" from the caller.
`

export const DELIVERY_FLOW_VERBS = ['gate', 'phase', 'entrega', 'stage', 'qa', 'ajustes', 'wait', 'merge', 'block', 'unblock', 'dequeue', 'fila', 'approve', 'release', 'reconcile', 'antigas', 'tick'] as const

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
    case 'fila': {
      // FILA.PRIORIDADE — `fila` reads the queue in leaving order; `fila responder` answers the leader's question; `fila proximo` runs the flow now.
      const sub2 = pos[1]
      if (sub2 === 'responder') {
        if (!needSub()) return 2
        const answer = pos.slice(2).join(' ').trim()
        if (!answer) { io.err('usage: agentop flow fila responder --subtask S "sim" | "nao <motivo>" | "agendar <ISO> <motivo>"'); return 2 }
        return report(await svc.answerQueue(sub!, answer, actor), io)
      }
      if (sub2 === 'proximo') { io.out(JSON.stringify(await svc.queueNext(), null, 2)); return 0 }
      if (sub2 !== undefined) { io.err('usage: agentop flow fila [--task T] | fila responder --subtask S "<resposta>" | fila proximo'); return 2 }
      const view = await svc.queueView(flags.task)
      if (flags.json === 'true') { io.out(JSON.stringify(view, null, 2)); return 0 }
      for (const i of view.items) {
        const state = i.ask ? (i.ask.approved ? 'aprovada' : 'pergunta aberta') : i.hold?.active ? (i.hold.kind === 'nao' ? `não: ${i.hold.reason}` : `agendada ${i.hold.until}`) : 'na fila'
        io.out(`${i.position}\t${i.priority}\t${i.subtaskId}\t${i.title}\t${[i.predispatch.harness, i.predispatch.model, i.predispatch.effort].filter(Boolean).join('/')}\t${state}`)
      }
      if (view.items.length === 0) io.out('a fila está vazia')
      return 0
    }
    case 'reconcile': {
      // FLUXO.CICLO-COMPLETO backfill: `--release` is the only reconciliation there is; dry-run unless `--apply`.
      if (flags.release !== 'true') { io.err('usage: agentop flow reconcile --release [--apply] [--json]'); return 2 }
      const r = await svc.reconcile({ apply: flags.apply === 'true' }, actor)
      if (!r.ok) return report(r, io)
      if (flags.json === 'true') { io.out(JSON.stringify(r, null, 2)); return 0 }
      const { reconcileLine } = await import('./ciclo')
      const s = r.summary
      io.out(`${r.apply ? 'reconciliação aplicada' : 'simulação (nada foi escrito — use --apply)'}: → publicado ${s.published} · → ci ${s.toCi} · → ci (release vermelha) ${s.ciRed} · release ilegível ${s.unknown} · → antigas ${s.antigas} · ficam em revisão ${s.stay} · chamadas gh ${r.gh}${r.stopped ? ` · parou: ${r.stopped}, a próxima rodada continua` : ''}`)
      for (const e of r.entries) io.out(reconcileLine(e))
      return 0
    }
    case 'antigas': {
      // `agentop flow antigas publish|archive [--subtask S[,S…]|--all [--expect N]] [--version X] [--reason text]`
      const action = flags.action ?? pos[1]
      if (action !== 'publish' && action !== 'archive' && action !== 'conclude') { io.err('usage: agentop flow antigas publish|archive|conclude (--subtask S[,S…] | --all [--expect N]) [--version 2.203.0] [--reason text]'); return 2 }
      const r = await svc.antigas({ action, ...(flags.preview === 'true' ? { preview: true } : {}), ids: flags.subtask, all: flags.all === 'true', ...(flags.expect ? { expect: flags.expect } : {}), version: flags.version, reason: flags.reason }, actor)
      if (!r.ok) return report(r, io)
      if (flags.json === 'true') { io.out(JSON.stringify(r, null, 2)); return 0 }
      if (r.preview) io.out(`${r.preview.conclude} concluídas, ${r.preview.archive} arquivadas`)
      for (const x of r.done) io.out(`${x.subtaskId}\t${x.ok ? `ok${x.how ? ` (${x.how})` : ''}` : `recusada: ${x.reason ?? '?'}`}`)
      return 0
    }
    case 'tick': io.out(JSON.stringify(await svc.tick(), null, 2)); return 0
    default: io.err('unknown delivery verb'); return 2
  }
}
