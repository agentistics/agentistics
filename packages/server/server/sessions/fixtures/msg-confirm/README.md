`claude-busy-queued.txt` reuses the live Claude 2.1.285 probe captured on 2026-09-29,
already preserved as `QUEUED_STREAMING` in `packages/core/src/sendNow.test.ts`.
It is not a new live run. Codex busy captures are reused from `../codex-0.161.0/busy-*.txt`.

These frames reject H1 for the reported structured-session failure: busy Claude's focused input
is not an overlay/dialog, and queued Codex text above its cleared composer already means delivered.
Do not turn an arbitrary unconfirmed TUI write into a success simply because a turn is busy.
The regression reproducing H2 is `prompt-structured-host.test.ts`; the real relay recovery after
an already-completed boot is exercised in `structured-durable.test.ts` for both harnesses.
