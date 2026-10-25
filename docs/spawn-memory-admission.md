# Session spawn memory admission

All spawn paths use `admitSpawn` with the shared `memoryBudget` measurement.
New-session capacity is `floor((MemAvailable - safety floor - remaining heavy-job headroom) / session cost)`,
clamped to zero. Total capacity is the running session count plus that remainder.
Running sessions are already excluded from `MemAvailable`; their memory is used only to measure
per-session cost, not subtracted again. Cost is RSS plus swap per measured session, with a
450 MiB fallback when no running session can be measured.

The safety floor remains 2 GiB. `AGENTISTICS_ADMISSION_RESERVE_MB` overrides it (minimum 256 MiB).
For running heavy jobs, reserve only `max(0, HEAVY_JOB_BYTES - current heavy-job RSS)`.
The configured heavy-job allowance is currently 1.8 GiB. A lock holder that has not grown yet
keeps the full allowance; without a running job there is no heavy-job headroom to reserve.
Swapped-out bytes do not count as resident memory already deducted from `MemAvailable`.

Heavy RSS is measured afresh over each holder's process tree, including descendants started
by other threads. Each PID is counted once. Holders are discovered from the kernel lock table,
even after `flock -F` execs the command. Inherited FD locks (`flock 9`) whose acquiring process
has exited are found through locked file descriptions in `/proc/<pid>/fdinfo`.
Some kernels omit these inherited locks from `/proc/locks`. For a slot without a known holder,
a non-blocking `flock -n -E 254 <path> true` probe distinguishes a free lock from a busy one.
Free locks skip descriptor scanning; busy locks and probe errors retain the `fdinfo` fallback.
Persisted `usedBytes` readings are never reused for admission.

For example, with 3.5 GiB available and a heavy tsc already at 2.7 GiB RSS, the remaining heavy
reservation is zero: seven additional 215 MiB sessions fit above the 2 GiB floor.
With a 1.7 GiB heavy RSS reading, only 0.1 GiB of headroom remains and six sessions fit.
With 1.4 GiB available and 1 GiB of remaining heavy headroom, no session fits.
A genuinely unused 1.7 GiB heavy allowance plus the 2 GiB floor still refuses at 3.5 GiB available.

A refusal reports available RAM, remaining heavy-job headroom when nonzero, safety floor,
session cost, and session counts used by the decision. Older refusal payloads without a floor
remain renderable. CPU saturation still refuses first. Swap percentage colours the meter but
never independently refuses a spawn. Unmeasurable machines admit with an explicit flag;
force overrides retain the refusal details.
