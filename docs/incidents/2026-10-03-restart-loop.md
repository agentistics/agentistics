# 2026-10-03 — an upgrade started a second server, and the service restart-looped

**Impact.** For about twenty minutes after an upgrade to v2.99.0 on one machine, the dashboard
showed every session as ended. Every reopen failed, because the machine's memory was exhausted.
The coding-assistant processes and their tmux server survived throughout. Nothing was lost from
the session registry, but four sessions were marked ended by reopen attempts made during the
window.

## Timeline (local time, UTC−3)

| time | what happened |
|---|---|
| 00:38:40 | `agentop upgrade` installed v2.99.0 over the running binary. |
| 00:38:41 | The service's server exited with **143** (SIGTERM). systemd did not send it: there is no `Stopping …` line. systemd logged it as a failure, and `Restart=on-failure` scheduled a restart. |
| ~00:38 | An `agentop server` started **outside** the unit (root cgroup, parent `init`) and took the data-directory lock. |
| 00:38:46 → 01:00 | The unit restarted every 5 s, **190 times**. Each start loaded the vault, the watcher daemon and the whole application, and was then refused: first by the lock ("another agentop server is already using …"), later at the port bind (`EADDRINUSE`). |
| 00:43:59 | A second server started outside the unit. |
| 01:00:10 | The detached server was stopped by hand, and the unit was restarted once. Stable since. |

## Root causes

1. **The upgrade restarted the server by pattern, not through the service manager.**
   `restartRunningServices` asked `systemctl --user is-active agentop-server`. When the answer was
   not `active`, it fell through to a fallback meant for a hand-started server:
   `pgrep -f 'agentop.*(server|start)'`, SIGTERM, SIGKILL one second later, and a detached
   `nohup agentop server --bg`. The manager gives no answer when it cannot be reached (no user bus
   from where the upgrade runs), so the fallback killed the unit's own server and started a
   replacement outside it.
2. **A refused start was a "failure" to systemd.** The unit had `Restart=on-failure` and
   `RestartSec=5`, with no start limit. "Another server holds the data dir" exited 1, and a
   port-in-use exited 1 too, because Bun's message never says `EADDRINUSE` and the check read only
   the message. So the unit looped forever. The duplicate check also ran only after the expensive
   parts of startup.
3. **The instance lock misjudged a live holder on WSL.** The lock decided "is the pid in the file
   the writer?" by comparing the process start time (derived through the wall clock) with the
   lock's mtime. WSL steps the wall clock. On this machine `ps` placed the live server's start
   153 s after its own lock was written, so a live holder could read as a recycled pid. That is how
   later restart attempts got past the lock and failed only at the port.
4. **An unreachable tmux read as an empty fleet.** tmux 3.x prints
   `error connecting to <socket> (<reason>)` for every connect failure, and only
   `(No such file or directory)` means "no server". `Permission denied`, `Operation not permitted`
   and `Resource temporarily unavailable` were all read as "zero sessions". So a process that could
   not reach the socket (under memory pressure, or from a restricted environment) showed every live
   session as ended.
5. **A failed session list was read as "nothing is running".** Every spawn/reopen path did
   `backend.list().catch(() => [])`. Reopening one session then retired every live sibling in the
   same directory. The bulk reopens ("reopen what fell", "open the whole task") would have started a
   second assistant inside conversations that were still running.

**Trigger.** A shell start-up file on the machine had an `agentop upgrade` command appended to an
unrelated line, so every new interactive shell ran an upgrade. The product must survive that, and
the fixes below do not depend on it being removed.

**Unrelated, seen in the same logs.** A member connection that a central rejects with 401/403
logged `ingest returned 403; stopping push` every 2–5 s for hours. Each file change started
another full ingest that was refused again.

## Fixes

- **Upgrade → service manager, always** (`server-restart-plan.ts`, `server-restart-io.ts`). An
  installed unit is restarted by `systemctl --user restart` or not at all. An unreachable manager
  becomes a sentence with the command to run, never a kill. A server running outside an installed
  unit is reported, never killed. A detached restart happens only when no unit is installed. It
  matches processes whose argv **is** `agentop server`, and it waits for the old process to exit
  and the data-dir lock to be free before starting exactly one replacement.
- **No restart loop** (`service-exit.ts`, `service-manager.ts`). A refused start exits **75**. The
  unit carries `RestartPreventExitStatus=75`, plus `StartLimitIntervalSec=300` /
  `StartLimitBurst=5` so that any loop ends. Installed units are migrated on the next
  `agentop restart server`. `agentop server` probes the lock before loading anything, and the
  port-in-use check reads `err.code`.
- **Exact lock identity** (`single-instance.ts`). The writer records its boot-clock start ticks
  (`/proc/<pid>/stat` field 22), and identity is ticks equal to ticks. A wall-clock step cannot
  affect that. Old pid-only locks keep the previous check.
- **tmux reachability** (`tmux-cli.ts`). Only ENOENT and `no server running` mean an empty fleet.
  Every other connect failure is a failed poll, which keeps the previous list and says it failed.
- **A failed list decides nothing** (`registry.ts`, `reopen-attempt.ts`, `cli-start.ts`,
  `cli-session.ts`). If the list fails, nothing is retired and nothing is reopened, and the bulk
  reopens refuse with a sentence.
- **`agentop doctor`** names a server holding the data dir from outside the service, and an
  installed unit without the restart guards.
- **Uploader** (`uploader-auth-stop.ts`). The first 401/403 stops that connection's pushes and logs
  one line. A configuration change lifts the stop at once. A `whoami` probe, at most once a minute,
  lifts it when the central accepts the token again.

## Manual check for the owner

All tests ran against throwaway directories and fakes. Nothing here touched the running service.
After installing a build with these fixes:

1. `agentop restart server`. The output should say the unit was updated so that "a refused start
   can no longer turn into a restart loop". Then
   `systemctl --user cat agentop-server | grep -E 'RestartPrevent|StartLimit'` should show the
   three lines.
2. `agentop doctor` should print **"agentop server runs under its service"** and no restart-guard
   warning.
3. `cat ~/.agentistics/server.lock` should show two numbers (pid and start ticks).
4. Optional, refusal path: run `agentop server` in a terminal while the service is up. It should
   exit at once with code 75 (`echo $?`), without loading the app, and the service should be
   unaffected.
5. Remove the stray `agentop upgrade` from the end of the shell start-up file line that carries it.
