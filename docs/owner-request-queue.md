# Owner requests and the delivery queue

The delivery vacancy gate reads the session backend, the same process evidence used by the fleet.
Registry rows whose processes are lost, exited or ended reserve no worker or top-model capacity.
Working sessions, idle sessions waiting for input and sessions waiting for approval still reserve slots.
`agentistics_task_phase action=gate name=vaga` and `agentop flow gate vaga --subtask S` use the same gate.

The minute tick withdraws a queued piece when its board status becomes `in_review`, `done` or
`abandoned`. It preserves its delivery history and staged draft, records why it left in a board
comment, and never rewrites the board status. Live honors the board immediately, even before the tick.
The task leader or owner can withdraw a piece explicitly:

```sh
agentop flow dequeue --subtask S --reason 'Already delivered by the replacement session'
```

Agents use `agentistics_task_phase action=dequeue subtaskId=S reason=...`. `action=tick` runs the
same reconciliation as the server timer. `action=get` exposes the withdrawal reason. A withdrawn
piece cannot start until explicitly restaged with `agentistics_task_stage`.

Confirmed composer sends are captured in the shared fleet send path, including TUI sends and
late confirmations. Rejected sends create no request. Trusted handoff readers register the
original owner text, conversation and timestamp; ordinary agent messages remain excluded. A
retired target follows its handoff/reopened row, and the spawn-time leader flag fills in only
when no saved role exists.

Request registration is best effort: a flow or engine failure never prevents the handoff relay
from forwarding owner text to the successor. The relay cursor tracks delivered conversation,
including the spawn briefing, independently of request registration. Failed registration does
not rewind that cursor or replay turns already included in the briefing; failed sends still
leave their cursor unchanged for a later delivery attempt.

The general flows flag and the individual engine switches are separate: `pedido-do-dono` and
`encaixe-do-pedido` were off by default in the engine. The mandatory request path and delivery
tick enable them through the existing official `flow enable` command. The autonomous-mode boot
rule is preserved, including an explicit `AGENTISTICS_FLOWS=0` opt-out. No engine source is copied
or changed, and the engine's `pedidos` remains the single request registry.

The delivery tick reads those canonical requests. Ten minutes after the request, an open request
or a linked piece without complete staging wakes the current live task leader, even during its
turn. Failed wakes retry; successful wakes repeat after 30 minutes. A changed leader is notified
immediately once due. Only reminder cadence is kept in the delivery store, so restarting does not
reset it. This path never notifies or waits for the owner, in either mode.

Staging reports an `encaixe` warning for another queued piece of the same task sharing an exact
file, an explicit `area:`/`surface:` tag, or the same named UI surface. The leader can extend that
brief or group the pieces through `agentistics_task_subtask`. Joining an already staged member
copies its brief into the group's pre-dispatch once and withdraws its former queue record with a
comment; the minute tick retries a missed fold. Group members never produce their own card.

### FLUXO.AVISOS — fewer, truer notices (2.202.1 / 2.203.0)

- **Only work is chased.** A pedido whose text the host rule calls a question (`intent: question`, see
  `docs/experimental-flows.md`) is never reminded and creates no subtask; the leader answers it in its reply.
- **The reminder is re-judged at send time.** The tick reserves a reminder, then re-reads the request, the subtask facts and the
  leader right before typing; a request that was staged in between, closed, or whose leader died is dropped and the reservation
  released (`request-wake-skipped` in the tick actions). The cadence is ONE per pedido (30 min), not one per leader: a newer leader
  hears the reminder at once only when the one that already got it is gone. The engine's `demanda` flow must not send its own
  second reminder; the host's is the only sender.
- **The reminder is short:** the pedido id and its first ~80 characters (no attachment paths); the full text is in the leader's
  PEDIDOS ABERTOS DO DONO section.
- **Pre-dispatch asks only for what the harness uses.** `effort` only where the harness has an effort concept; `account` only where
  it can keep a second login apart (otherwise the account is `default` and the slot gate reads that budget row).
- **`agentop session` start / batch / reopen honour the owner's top-tier cap** exactly like the `vaga` gate (`topTierFull`): a full
  provider tier refuses with a sentence, `--force` overrides it out loud. Leaders and hand-offs are never refused.
- **Plan limits never recommend a stale or missing reading.** `agentistics_plan_limits` / `GET /api/plan-limits` routing ignores
  rows not read in the last 10 minutes; `recommendation.unknown` names the harnesses it could not judge (`stale` / `no-reading`) and
  `recommendation.confidence` is `fresh` or `none`.
- **Queued messages can be sent or interrupted from their own caption** (web): the existing send-now verb (claude, mid-turn, no
  dialog) and interrupt verb (any harness whose stop is enabled); hidden otherwise.
- `agentistics_task_create` takes `priority` and `type`; the subtask tool no longer freezes a status list.

Read-only checks on macOS after installing the reviewed build:

```sh
agentop session ls --json
agentop flow ls
agentop flow entrega
```

For queue selection, use records with `phase === 'fila' && !dequeued`. The withdrawal reason and
history are still available through `agentistics_task_phase action=get`. Sorting these records
by priority remains a separate concern.

Operational verification: during the live board check on 2026-11-07 the eight F0/F1 ids all read
`todo` on the live board. They cannot be inferred finished from that status; the leader must
explicitly dequeue them after rollout. This branch does not restart or replace the running service.

Tracked in #1349 (Agentask s-8741931b62).
