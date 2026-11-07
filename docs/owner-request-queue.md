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
