# Delivery store guard (rule A)

**Rule OFF is the base, locks included (S2a r3, QA N2).** Every write first peeks rule A. With A `off` (the default,
and every machine that never turned it on) a board write takes only the tasks file lock through `withFileLock` — it
proceeds after its wait and re-runs once, exactly as before S2a — and a delivery write takes only what the base took
(`withFileLock`, or the evidence path's own locks). It never waits on deliveries/guards, never fails closed after 5 s
and never loses a write. A pending, sealed delivery journal is an already committed write: even OFF must roll it
forward under deliveries → guards before applying another mutation. With no journal, OFF retains the base locks.
With A `shadow`/`on` the envelope below applies unchanged.

The switch itself is safe: `activation.ts` `setState` takes the full tasks → deliveries → guards envelope, so a rule
move cannot land while a writer genuinely holds its file lock. A writer that peeked `off` and then finds that its
write raises a piece re-reads the rule under its lock; a board writer that finds it moved retakes the full envelope and
is judged, a delivery writer fails closed with `guard_busy` (its callback is not re-run). From `off` the only reachable
state is `shadow` (`on` needs 24 h of shadow), and shadow refuses nothing, so a write that ran unlocked after a
contended wait can at worst miss one checkpoint — never bypass a refusal.

With A shadow/on the task store acquires tasks → deliveries → guards before reading a mutation's inputs. The delivery
store acquires deliveries → guards. Activation is authenticated inside that lock set, including the
integrity witness and process generation latch; absence of the two JSON documents and key is not
proof of a new machine. A genuinely new machine remains OFF and creates no guarantee/checkpoint files.

Operations that also apply board effects use `withGuardTransaction` (rule-aware: OFF runs the operation with no
envelope at all; `withGuardEnvelope` is the unconditional one). Its async context records the exact
three paths and an active lease, so the stores can reuse locks during the operation without recursive acquisition or
waiting behind a queued writer that is itself waiting for the transaction. Ordinary `withGuardLocks`
still rejects reentrance and reversed order. Escaped async continuations lose both leases when the
operation exits and must acquire fresh locks. Each acquisition times out after five seconds, failing closed.
Release probes run before the critical section; the final CAS, guarded write and board effects run
together under the complete set. Concurrent external probes therefore cannot deadlock each other.

The guard detects rank increases, newly exposed pieces after group/child removal, advanced adoption,
and protected binding changes (task/subtask, revision, HEAD and evidence ids/hashes). The `evidence`
update option selects strict parsing; it never suppresses detection. An advanced adoption needs the
same current evidence as another protected write. Backup restore cannot reconstruct authorizations:
while A is ON it refuses the WHOLE restore when the archive would replace tasks.json or deliveries.json, decided
before a single file is written, under the full lock set, with one sentence in EN and PT (`GUARD_RESTORE_REFUSAL`) that
the CLI and the web job both print through `restoreReason`.

Grandfathered checkpoints preserve the state migrated at activation. They authorize no new progress;
the next protected write classifies the checkout and validates evidence again. Such a write replaces
the inherited authorization with the evidence that actually passed.

Evidence belongs to a capture round. Every phase transition increments the delivery revision, but only
an entry into `ajuste` starts a new round. Its durable history revision is the minimum evidence revision
accepted by the guard and `evidencia` gate. Earlier items stay visible/auditable and remain in the reuse
history, but cannot authorize another review at the same HEAD. Fresh captures can be reused throughout
normal phase advances within the round.

That floor cannot be erased (r3, QA N1): `deliveryTamper` makes the history, the evidence history and every existing
evidence item APPEND-ONLY for every writer at every rank, and a revision never goes back. Adding or removing evidence,
or removing a record that carries any, needs a guard context (the service doors always carry one). With A on such a
write is refused (`evidence_binding_protected`, EN/PT); shadow reports it; off writes it as the base did.

The delivery floor and the serialized pending ledger are sealed together before the ledger rename. Readers use the
pending bytes; the next writer materializes them and clears the journal after the rename. Every authenticated rule
move resolves the journal before changing the rule, including moves to OFF. Unreadable guards only warn on delivery
reads, which fall back to the ledger; guarded writers still fail closed. OFF reads cache the rule by the policy file's
inode/size/mtime/ctime, invalidated by `setState`; after warmup they read only ledger bytes. The metadata stamp also
detects another process's policy replacement without reading the policy file on every OFF read.

Floors judge records changed by this write against its persisted before image. An unchanged record or a phase
retreat cannot freeze unrelated writes. On OFF → shadow, the present ledger becomes the new sealed floor; the rule
audit records which floors dropped and why. This permits the documented OFF → restore → shadow → ON recovery. ON
still requires a fresh shadow period and new progress still needs evidence.

The supplementary inventories parse executable TypeScript/JavaScript ASTs. Context must occupy the
writer's actual context argument; words in comments, titles and callbacks do not count. The historical
call identities and raw writer identities from `1b1c8a941` live in `guard-inventory.fixture.json` and have
an independently pinned SHA-256 in `guard-inventory.testing.ts`. Current sites must be a multiset subset:
removing sites is allowed, adding/replacing sites or raising a live count is not. Raw writer inventory
covers all packages and root scripts, JS/TS/TSX, workers, aliases, namespace calls, Bun.write and computed destinations.
Add guarded store calls with contexts instead of growing the fixture. S2c removes the remaining
historical context exemptions and makes the context parameter required.

r3 (QA N3) closes the inventory by DENY-BY-DEFAULT rather than by chasing syntax. (1) The writer detector also sees
destructuring renames from `require`/`import()`, element access, the Bun global however reached (`globalThis.Bun`, an
alias), `Bun.file().write`, `Bun.$`, child processes (`cp`/`mv`/`install` via `execFile`/`spawn`/`Bun.spawn`) and
`link`/`symlink`; the sites of those forms that already existed are pinned in `guard-inventory-r3.fixture.json`
(own SHA-256), shrink-only. (2) Every reference that can REACH the books — their file names, the data directory, the env
overrides and the path helpers — is pinned per module, shrink-only: retargeting an inherited call at a book, or handing
a book path to a new module, grows it and fails, whatever the call looks like. (3) No production module may import a
`*.testing` / `*.fixture` / `*.test` module, by any route, so moving a writer into a helper hides nothing. Stated limit:
a book name assembled at runtime from fragments (`'tas' + 'ks.json'`) in a module that already reaches the data dir is
not seen by a text scan; such a module is in the pinned reach list and is reviewed as such.

The module and helper ceilings also follow transitive re-exports to a fixed point. Runtime code generation is
forbidden: any `eval` identifier reference, `Function` calls, `vm`/`node:vm`, `process.binding`, and computed members
on `global`, `globalThis`, `self` or `Bun`, including TypeScript wrappers. Module loaders include `import.meta.require`,
`module.require` and `process.getBuiltinModule`. A directory named `e2e` grants no production exemption. One existing,
unshipped Playwright driver is exempted by exact path and source digest; changes to it undergo the normal check.
Deliberately obfuscated constructs such as `Reflect.get` with assembled names remain outside this lint's threat model.
