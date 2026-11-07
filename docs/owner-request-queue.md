# Owner requests and the delivery queue

The delivery vacancy gate reads the session backend, the same process evidence used by the fleet.
Registry rows whose processes are lost, exited or ended reserve no worker or top-model capacity.
Working sessions, idle sessions waiting for input and sessions waiting for approval still reserve slots.
`agentistics_task_phase action=gate name=vaga` and `agentop flow gate vaga --subtask S` use the same gate.

Tracked in #1349 (Agentask s-8741931b62).
