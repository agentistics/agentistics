# 2026-10-04 — an `agentop server` outside the `agentop-server` unit, for hours

## What happened

- The `agentop-server` systemd user unit was installed and enabled. After the 09:1x boot the
  machine nonetheless ran an `agentop server` (pid 3204, parent `/init`) that the unit had not
  started. The unit started, found the data directory held, waited its ten minutes and exited 75
  (TEMPFAIL); `RestartPreventExitStatus=75` then left it **failed**, correctly not looping — and
  nothing ever started it again.
- So for two hours the machine served v2.101.2 while v2.103.1 was installed. `agentop upgrade`
  said "agentop server pid 3204 runs OUTSIDE the agentop-server service — it was left alone".
- At 12:22:29 the unit's server got SIGTERM (exit 143) and pid 1317549 took the data dir before
  systemd's restart could; at 12:35 another out-of-unit server (1349650) appeared the same way.

## Who started them

`/proc` answered it: pid 1349650's parent was `/init` 600754, the WSL interop relay of an
interactive `wsl.exe ~` (the Ubuntu terminal, opened 11:29:58), alongside that terminal's `-bash`
and `ssh-agent`. A process started from that terminal and detached is reparented to the relay
when its launcher exits. The launchers that do this are every path that spawned its OWN server
regardless of what was installed:

- the control center's **Restart** (`restartLocalSvc`): it SIGTERMed whatever held the port — the
  unit's own server — and then ran `startBackground` (`nohup agentop server &`), which raced
  systemd's restart for the data dir and won (12:22);
- the control center's **Start**, `agentop server --bg`, and a plain `agentop server` in a terminal.

The Windows side was checked as well: the desktop app spawns its bundled Windows `agentop.exe`, and
the logon entry only runs `sleep infinity`; neither runs a WSL `agentop server`. The desktop app is
still made to go through the unit (below), because it is a launcher too.

## The fix

`server-ownership.ts` (pure) + `server-ownership-io.ts`:

1. **When the unit is installed for the owner's own store, every launcher goes through it.**
   `agentop server` / `--bg` outside the unit start the unit (`reset-failed` + `start`, waiting for
   it to answer) and exit; the cockpit's Start, Restart and Stop use `systemctl --user
   start|restart|stop`. `AGENTISTICS_SERVER_FOREGROUND=1` keeps a foreground server on purpose. With
   no reachable user manager (WSL before the user instance is up) a terminal server still runs —
   nothing else could serve — and rule 2 hands it over when the unit starts.
2. **A stray that is provably ours is taken back.** Provable = it holds THIS data dir's lock, its
   argv is `agentop server`, and it is in no agentop unit. The unit's own start does this before
   waiting (so the unit no longer ends `failed` behind a stray), and so do `agentop restart server`
   (`restartAutostart`) and `agentop upgrade`, which then restart the unit onto the new binary.
   Anything that cannot be proven ours is still only reported.
3. `restartAutostart` clears a `failed` unit (`reset-failed`) before restarting it.
