# Leadership check-in messages

Scheduled and manual leadership check-in prompts start with
`[from agentistics · check-in]` on its own line for every harness. The checklist and
any appended away instructions remain in the prompt body.

The chat renders these user-role transcript turns with the existing collapsed
system event row, labeled “Leadership check-in · system” (or “Check-in da liderança
· sistema”). Expanding the row reveals the prompt. “Open check-in” dispatches the
existing `agentistics:open-checkin` event with the current session ID, opening the
session information block and its existing larger check-in view. The action has a
44px minimum height.

Legacy prompts beginning with “Faça o check-in da liderança agora.” or “Run the
leadership check-in now.” also render as check-in system events. Ordinary messages
that merely mention check-in keep their usual rendering.

Scheduled rounds first compare deterministic inputs with the last successfully
delivered round: live session identities and states, task activity and new
handbacks/blocks/questions addressed to the leader, limit decision bands
(`ok`/`tight`/`over`, no raw percentages), installed version, MCP target config
digests and the latest commit touching the detected handoff file. Unchanged
inputs record `skipped: no change` with zero tokens; live workers do not override
this gate with an idle heartbeat. Manual “run now” remains an explicit request
and runs even with unchanged inputs.

A changed scheduled round carries only the delta (added/removed array entries
and changed object fields). MCP credentials and config contents never enter the
prompt or stored input snapshot. Only successful delivery commits the baseline;
a failed delivery retries against the same baseline on the next interval. The
baseline persists across server restarts and is omitted from public/SSE state.

Live acceptance (delivery owner): observe two unchanged scheduled intervals,
then change one worker state and verify one prompt containing only the delta.
Change one MCP target and commit the handoff file; each must trigger once.
