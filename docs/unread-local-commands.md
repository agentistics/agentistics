# Local command delivery in chat

The unread bubble is reconciled against confirmed user turns from the harness chat channel.
A successful write alone cannot confirm that the harness handled a command, and an idle session
cannot confirm that it read a queued prompt.

A driver that handles a command without a user echo must publish its user turn when the protocol
confirms completion. Claude's existing `/rename` classification uses its zero-turn result for this;
the accompanying engine patch retains the command text and send timestamp until that result.
It does not start or end a model turn, clear live output, or consume queued model prompts.
Other drivers continue to publish their existing user turns through the same channel.

`pendingEchoes` is shared by the server queue and browser. Slash invocations require their own
text match and cannot prove that earlier model prompts were consumed: a local command can complete
while those prompts still wait. This conservative rule applies to all slash invocations because the
driver, rather than the browser, knows which commands are local. Ordinary prompt reconciliation
keeps its existing ordering and containment rules.

The engine change is supplied as `patches/unread-local-engine.patch`, against engine pin
`dea9b9186e6a6fc892d0bc4c2a8dc49fbbf13c7c`. Apply it to the engine repository and update `engine.pin`
to the resulting reviewed commit before releasing this fix. The patch is a hand-off artifact and
should be removed from the public change after engine integration.
