# agentistics-engine (private)

The engine the official `agentop` binary carries: the native runtime (`runtime/`, was
`packages/runtime`), the harness integrations and the provider verb (`engine/src/`, was
`packages/server/server/{integrations,provider,cli-provider*,provider-web}`), and their proofs (the
seven parity differentials and the parity matrix). The host loads it through
`@agentistics/engine-api` — see `docs/superpowers/specs/2026-09-29-engine-interface.md`.

```
engine/src/index.ts          createEngine(host) — the one export
engine/src/host.ts           the installed EngineHostServices; every machine fact comes from here
engine/src/reuse.ts          the reuse surface (spec §6) as live bindings: host.readers, else the bridge
engine/src/public-bridge.ts  TRANSITIONAL — the one production file importing the public tree
engine/src/conformance/      the conformance kit (to move into engine-api) + its test
engine/src/integrations/     the seven replays; registry = createIntegrations(), total over HarnessId
engine/src/projections/      differentials + parity matrix (proofs against the public legacy adapters)
runtime/                     @agentistics/runtime
public.pin                   the public commit this engine targets
```

Setup: `AGENTISTICS_PUBLIC_DIR=<public checkout> bun install`, then `bun run typecheck`,
`bun run test`, `bun run parity`. Building the official binary: [docs/build-official.md](docs/build-official.md).
