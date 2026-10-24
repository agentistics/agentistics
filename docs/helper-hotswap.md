# MCP and structured relay upgrades

`agentop mcp` and `agentop __structured-relay` retain a small IO forwarder for the lifetime of the
connection. Their request handlers run in replaceable processes launched from the installed binary.
Every five seconds the forwarder compares the executable's device, inode, size and nanosecond mtime.
An upgrade prepares a new worker, then changes workers at an idle boundary. Preparation errors are
logged to stderr and retried; the current worker continues serving requests.

The MCP forwarder owns stdin/stdout framing and tracks requests in both directions. The candidate
receives the original `initialize` parameters and `notifications/initialized` privately. The host sees
one handshake. All outstanding requests must complete and their replies must be queued/flushed
before the old worker is retired. Partial input lines stay with the forwarder.

The relay forwarder owns the harness child, its process group and pipes, the Unix listener and live
socket, and the durable journal writes. The worker interprets hello cursors and validates input
replay against those journals. Decisions run serially through their effects, so replacing a worker
cannot duplicate an input write. During hello replay the forwarder snapshots the journal and buffers
subsequent output until replay completes. Neither the live connection nor the child is restarted.

This avoids transferring Bun/Node stream internals, sockets, buffered bytes and child exit ownership
through `execve`. The small forwarder may retain the old executable mapping; its protocol logic runs
from the new binary. The resource inventory therefore excludes these two helper families (including
their internal workers) from stale-binary notices. Other stale processes still raise notices; memory,
CPU and orphan checks continue to apply.

In a checkout workers launch the checkout's CLI source. Installed helpers launch `process.execPath`
from disk. Helpers already running code from before this mechanism was introduced cannot acquire
it retroactively; hot-swap applies to helpers started with this implementation.

Validation is in `helper-hotswap.test.ts`, `helper-hotswap.integration.test.ts` (compiled fixtures,
executable replacement with live connections), and the relay/governor regression tests. No ports or
running production services are needed.
