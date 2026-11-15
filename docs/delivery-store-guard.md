# Delivery store guard (rule A)

The task store acquires tasks → deliveries → guards before reading a mutation's inputs. The delivery
store acquires deliveries → guards. Activation is authenticated inside that lock set, including the
integrity witness and process generation latch; absence of the two JSON documents and key is not
proof of a new machine. A genuinely new machine remains OFF and creates no guarantee/checkpoint files.

Operations that also apply board effects use `withGuardTransaction`. Its async context records the exact
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
it refuses replacement of tasks.json or deliveries.json while A is ON, under the full lock set.

Grandfathered checkpoints preserve the state migrated at activation. They authorize no new progress;
the next protected write classifies the checkout and validates evidence again. Such a write replaces
the inherited authorization with the evidence that actually passed.

Evidence belongs to a capture round. Every phase transition increments the delivery revision, but only
an entry into `ajuste` starts a new round. Its durable history revision is the minimum evidence revision
accepted by the guard and `evidencia` gate. Earlier items stay visible/auditable and remain in the reuse
history, but cannot authorize another review at the same HEAD. Fresh captures can be reused throughout
normal phase advances within the round.

The supplementary inventories parse executable TypeScript/JavaScript ASTs. Context must occupy the
writer's actual context argument; words in comments, titles and callbacks do not count. The historical
call identities and raw writer identities from `1b1c8a941` live in `guard-inventory.fixture.json` and have
an independently pinned SHA-256 in `guard-inventory.testing.ts`. Current sites must be a multiset subset:
removing sites is allowed, adding/replacing sites or raising a live count is not. Raw writer inventory
covers all packages and root scripts, JS/TS/TSX, workers, aliases, namespace calls, Bun.write and computed destinations.
Add guarded store calls with contexts instead of growing the fixture. S2c removes the remaining
historical context exemptions and makes the context parameter required.
