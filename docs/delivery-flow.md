# The delivery flow (FLUXO.ENTREGA-DSL)

Every delivery — one subtask — walks ONE fixed table, kept by the server:

```
fila → executando → qa → { APROVADO: revisao_lider | REPROVADO: ajuste }
ajuste → qa                                  (never straight to the review)
revisao_lider → { ok: pr_merge | change requested: ajuste }
pr_merge → { merged: ci | failed (checks, conflict, deletion): revisao_lider }
ci → { release.yml green + tag: publicado | release failed: revisao_lider }
bloqueado ← any phase but publicado, and back to the STORED origin only
```

A transition outside the table is refused with HTTP 422 `fase_pulada` and a sentence naming what
is missing. `server/delivery/machine.ts` is the table (pure); `gates.ts` checks evidence;
`service.ts` is the one door every surface uses; `store.ts` keeps one record per subtask in
`<dataDir>/deliveries.json` under the cross-process file lock.

## Gates — the evidence each edge needs (checked by the host, never passed by the caller)

| edge | gates / evidence |
|---|---|
| fila → executando | `predispatch` (staged session with prompt, harness, model, effort, account) + `vaga` (fresh plan_limits: 5 h < 85 %, week < 95 %; < 4 workers on the machine; the provider's top-tier cap; ≥ 3 GB free) |
| executando → qa, ajuste → qa | `salvo`: the author's HEAD is on origin (`git ls-remote`), clean tree, feature branch, no failing check run |
| qa → revisao_lider | verdict APROVADO + findings, and `qa-modelo`: QA model ≠ author model from the session registry, never Sonnet over Sonnet |
| qa → ajuste | verdict REPROVADO + findings (handed to the author) |
| revisao_lider → pr_merge | the leader reviewed the very sha QA approved (`reviewedSha == qaSha`) and HEAD did not move since |
| pr_merge → ci | `delecoes`: the PR deletes no file outright (unless the leader allowed those paths, with a reason) + the merge sha |
| ci → publicado | `release`: release.yml for the merge sha finished `success` AND the version tag exists |

Every transition runs its own gates, so a caller never brings proof. Each result is stored on the
record with the revision it was checked at; an older result does not count.

## The Live is a projection

The record's phase decides the Live stage (`task-live.ts` `PHASE_STAGE`); the board status is also
moved (QA, Ajuste, PR · merge and CI · publicando statuses are created when missing). The CI signal
(`{mergedMain, releaseGreen, tagPublished, tag, pr}`) is written onto the subtask, and `step` events
feed the per-phase percentage. Every change emits `entrega.etapa` on the engine bus.

## Non-blocking

Nothing waits. Each transition wakes whoever owns the next step: ready for QA → the leader; QA
approved → the leader; QA failed / change requested → the author with the findings; merge or
release failed → the leader with the reason. The engine's default-on `entrega-vigiar` timer (one
minute) moves `ci → publicado` on the release signal and keeps blocks moving.

## Blocks

Closed reasons: `dependencia` (lifts itself when its sibling finishes), `pedido_de_bloqueio`,
`limite`, `maquina`, `externo`, `fora_das_autorizacoes`. Everything but a dependency is the
leader's to lift; the leader is woken on entry and every 30 minutes, and past two hours the piece is
DEFERRED to the next batch (recorded, wakes stop; it stays blocked until lifted). With autonomous
mode on, reason 6 is deferred at once — the leader does not perform the action and nobody calls the
owner. Only with autonomous mode OFF does it become `decisao_do_dono`, sent to the owner.

## Human gates

A delivery may name phases the owner must approve before it enters them (`humanGates`, off by
default). Autonomous mode ON: skipped and recorded `pulado: modo autônomo`. OFF: the transition is
refused with 409 `aguardando_dono` until the owner approves (only a request with no session proof
can approve). The engine's flows apply the same rule to their own owner steps (`ownerOrLeader`).

## Doors

- HTTP: `GET /api/deliveries[/<subtaskId>]`, `POST /api/deliveries/<subtaskId>` (`action`),
  `POST /api/deliveries/tick` — `localShell`.
- MCP: `agentistics_task_phase`, `agentistics_task_stage`.
- CLI: `agentop flow gate|phase|entrega|stage run|qa open|ajustes open|wait qa-verdict|merge|block|unblock|approve|tick`,
  `agentop task stage <subtaskId> …` (exit 0 = passed).
- Engine flows: `entrega`, `entrega-portao`, `bloqueio`, `desbloqueio`, `entrega-vigiar`.
