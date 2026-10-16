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
