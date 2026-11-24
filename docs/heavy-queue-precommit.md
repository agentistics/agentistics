# Heavy queue admission

The head of the agentop heavy queue first probes every currently allowed slot without waiting.
If all probes find busy slots, it waits with blocking `flock` on slot zero. This joins the kernel's
lock waiters instead of repeatedly losing admission to manual blocking `flock` commands. A higher
slot becoming free during that wait does not move the job: progress on the shared slot takes priority.
Followers continue polling the on-disk agentop queue. Manual waiters are counted separately and
do not determine which agentop job may join the kernel queue. Linux lock holders and manual waiters
are discovered from `/proc`; status includes the holder command and manual waiter count.

Every flock attempt runs in its own process group, including its wrapped command. SIGTERM, SIGINT
and SIGHUP cancel that group, synchronously remove the job's queue files and exit with 128 plus the
signal number. Normal completion removes all lifecycle handlers. Process exit also cancels the
group; a small watchdog checks reparenting every 100 ms to cancel it after abrupt parent death
(including SIGKILL). Dead queue entries from an abrupt death are ignored by readers as before.
Cancellation tests use private temporary lock directories and never acquire the shared host locks.
