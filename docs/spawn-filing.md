# Spawn filing

CLI start, CLI batch and the web/TUI/VS Code host share the filing planner and
`spawnRole` derivation. A parent implies worker; an explicit role wins over that
inference and a leader title prefix. A hand-off is always a leader. Without any
of these signals, the caller is a person with no inferred role.

Workers fail before spawn if the planned subtask cannot accept a session.
People and hand-offs start first and then attempt the board attach. A blocked
subtask therefore still reaches the web wizard's blocker resolution flow.
Group members resolve to their group before the attach check.

Every entry point reports a failed attach after a successful spawn. The host
renders that note and its refusal reason in the selected language. A refused
attach clears the registry row's task title, taskId and subtaskId, including when
the task no longer exists or the subtask belongs to a different task. The running
session remains available; callers must not retry the spawn to repair filing.
