# Utility shell startup and provisioning

The session's **Shell** runs in tmux on its own socket. It does not use node-pty.
The four utility shell paths (creation, capture, input and resize) use the same executable
resolver. PATH wins; on macOS a service with a minimal PATH also searches executable tmux at
`/opt/homebrew/bin/tmux` and `/usr/local/bin/tmux`. A missing binary remains an explicit refusal.
On macOS, the selected `$SHELL` runs with `-il` (login and interactive); absent or empty SHELL
falls back to `/bin/zsh`. Linux keeps its existing shell selection and flags.

The terminal center shows **Provisionando terminal…** / **Provisioning terminal…** while
listing existing shells, creating one, and waiting for its first frame. The HTTP attempt times
out after 20 seconds with a message and retry. A stream without a frame reports failure after
10 seconds and offers reconnect. Existing frames survive a transient connection failure.
Abandoning the HTTP attempt aborts the browser requests; the next attempt lists existing shells
before creating another, including when a server completed creation after a client disconnected.

Opening uses the session's authoritative registry record, falling back to the engine's recorded
cwd for a native session. It avoids `host.sessions()` and its metric/repository/pane work.
Unknown sessions remain refused, and the client cannot supply a working directory. Checking the
directory, tmux availability and existing shells now happens concurrently.

## Measuring

`POST /api/shell/open` returns `Server-Timing` stages: `target`, `list`, `cwd`, `tmux`, `spawn`,
`persist`, `total`. `list`, `cwd` and `tmux` overlap. Browser User Timing entries are
`terminal:list`, `terminal:open` (cumulative since the attempt began), and
`terminal:first-frame` (total until the first frame). These measurements carry no paths or input.

Reproduce checks in a disposable environment:

```sh
agentop run --rm -- bun packages/server/qa/shell-lifecycle.ts
agentop run --rm -- bun packages/web/qa/terminal-provisioning.ts
```

The lifecycle check exercises real tmux open, command, capture, close and reopen. Its route
comparison injects **200 ms of simulated fleet latency**; that difference is not a benchmark of
the owner's machine. On the author’s Linux throwaway run, two real shell cycles measured
spawn at 5.8–12.0 ms and command/capture at 6.4–6.9 ms. The route comparison measured
213.5 ms with simulated fleet work versus 13.1 ms with direct records (`target`: 202.6 ms
versus 0.3 ms). The browser check mounts the real ShellBand with delayed mocked endpoints
at 1280 px and 390 px, checks progress through first-frame waiting and timeout/retry, and writes
screenshots plus JSON to `docs/media/terminal-provisioning/`. Set `QA_CHROMIUM` to a local
Chromium executable when the disposable HOME has no Playwright browser installation.

## Real Mac acceptance checklist

Linux unit tests cover both Homebrew locations and macOS shell selection; they cannot establish
that the owner's Mac works. Independent QA must check the following on macOS:

- Start Agentistics as its usual background service, with tmux installed through Homebrew.
- Open Shell in a session; confirm the center loader, then a zsh prompt in the recorded cwd.
- Run `pwd`, `printf 'shell-ok\n'`, and `command -v bun`; check login PATH and visible output.
- Resize, send Ctrl+C to a running command, then type `exit`; open a new shell and run a command.
- Repeat with both an existing shell and a fresh service whose PATH omits Homebrew.
- Check explicit missing-tmux and removed-working-directory errors, with no endless spinner.
- Inspect `Server-Timing` and User Timing if startup is slow; retain the stage durations.

Author UI evidence: [desktop](media/terminal-provisioning/terminal-provisioning-1280.png),
[390 px](media/terminal-provisioning/terminal-provisioning-390.png).
