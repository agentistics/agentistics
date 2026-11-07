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

Tracked in #1349 (Agentask s-8741931b62).
