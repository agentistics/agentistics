# MCP and structured relay upgrades

`agentop mcp` and `agentop __structured-relay` retain a small IO forwarder for the lifetime of the
connection. Their request handlers run in replaceable processes launched from the installed binary.
Every five seconds the forwarder compares the executable's device, inode, size and nanosecond mtime.
An upgrade prepares a new worker, then changes workers at an idle boundary. Preparation errors are
logged to stderr and retried with exponential backoff (5 seconds up to 10 minutes). A new executable
identity resets that backoff; the current worker continues serving requests.

The MCP forwarder owns stdin/stdout framing and tracks requests in both directions. The candidate
receives the original `initialize` parameters and `notifications/initialized` privately. The host sees
one handshake. Outstanding requests hold the idle barrier until their replies are queued/flushed,
they are cancelled, or their five-minute lease expires. Expiry releases only that request; other active work
still holds the barrier. Partial input lines stay with the forwarder.

The relay forwarder owns the harness child, its process group and pipes, the Unix listener and live
socket, and the durable journal writes. The worker interprets hello cursors and validates input
replay against those journals. Decisions run serially through their effects, so replacing a worker
cannot duplicate an input write. Malformed worker input is rejected without exiting. If a worker
crashes, the keeper starts a replacement from the current binary and retries the pending pure
decision before applying its effects. The harness child and client socket stay alive. During hello
replay the forwarder snapshots the journal and buffers subsequent output until replay completes. Neither the live connection nor the child is restarted.

This avoids transferring Bun/Node stream internals, sockets, buffered bytes and child exit ownership
through `execve`. The small forwarder may retain the old executable mapping; its protocol logic runs
from the new binary. The resource inventory suppresses stale-binary notices for these helpers only
when their process card explicitly declares hot-swap support. Cards are checked against kernel
process start time; legacy helpers without that marker retain their stale notice. Memory, CPU and
orphan checks continue to apply.

If an MCP worker crashes, the forwarder keeps the host connection, privately restores initialization
on a replacement, and resumes new requests. Outstanding host requests receive an internal error
stating that their outcome is unknown: tool calls can have effects and are never replayed.

In a checkout workers launch the checkout's CLI source. Installed helpers launch `process.execPath`
from disk. Helpers already running code from before this mechanism was introduced cannot acquire
it retroactively; hot-swap applies to helpers started with this implementation.

Validation is in `helper-hotswap.test.ts`, `helper-hotswap.integration.test.ts` (compiled fixtures,
executable replacement with live connections), and the relay/governor regression tests. No ports or
running production services are needed.
