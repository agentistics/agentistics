# The official build — `release.yml` and the engine

The public repository builds two kinds of binary from the same source (engine-interface spec §8):

| Build | Where | Engine slot |
|---|---|---|
| **community** | a clone of this repository, `ci.yml`, forks, any branch but `main` | `null` (or, during the migration, the in-tree engine) |
| **official** | `release.yml` on `main` (push or dispatch) or a tag, in `agentistics/agentistics` only | the private `agentistics/agentistics-engine`, checked out at `engine.pin` |

`ci.yml` never touches the engine. `release.yml` has no `pull_request` trigger and must never gain a
`pull_request_target` one.

## `engine.pin`

```json
{ "ref": "<full commit SHA or v<x.y.z> tag of agentistics-engine>", "api": "^1.2.0" }
```

`ref` is the engine commit the official binaries carry; `api` is the contract range the engine must
speak. A SHA reveals nothing about the engine's contents. Bump `ref` in the same change that needs the
newer engine; bump `api` only when the host's `@agentistics/engine-api` makes a breaking change.

## What the release does

1. type check + tests on the public tree alone (the engine's own CI proves the pair);
2. reads `engine.pin` and **fails if `ENGINE_DEPLOY_KEY` is not set**;
3. checks the engine out at `ref` into `.engine/` (gitignored, not a workspace) with that key,
   `persist-credentials: false`;
4. `bun install` in `.engine/` with `AGENTISTICS_PUBLIC_DIR=..`, which links the engine against this
   checkout's `@agentistics/core` / `@agentistics/engine-api`;
5. `build:assets` with `AGENTISTICS_ENGINE_DIR=.engine` regenerates the slot; the step fails unless the
   slot is `dir`. Both Linux binaries carry the engine;
6. **smoke**: `packages/server/scripts/assert-official-engine.ts` runs `agentop --version` and fails
   the release unless it prints `engine <v> (api <x.y.z>)` with `<v>` equal to the checked-out
   engine's own version (this is what rejects the transitional in-tree engine, which reports the
   host's version) and `<x.y.z>` inside `engine.pin`'s range. The musl binary is checked for an engine
   line as well;
7. **no readable engine source**: every binary is compiled `--minify` (whitespace, syntax and
   identifiers) and never `--sourcemap`, because every official binary is public. The same script greps
   the built bytes for three markers an unminified engine bundle carries — Bun's per-module header
   comment (`// …engine/src/cli-provider.ts`; Bun drops ordinary comments even without minify), the
   internal function name `dropModelCaches`, and the module path `engine/src/integrations/` (which a
   source map's `sources` would also carry) — and fails the release if any is present. Measured on
   engine `cd7550cb`: all three present unminified, none minified. Obfuscation beyond minify is not
   done; it is a later, optional decision.

An official run without the engine is a **failed release**, never a community binary under an
official name.

## Release pipeline

`release.yml` serializes releases, computes and checks the version, commits the bump, pushes the tag,
and creates the GitHub Release with the Linux `agentop` and `agentop-musl` assets. Because it uses
`GITHUB_TOKEN`, it explicitly dispatches the downstream workflows after creating the release.

`publish-npm.yml` publishes `@agentistics/agentop` and `@agentistics/mcp` as independent jobs.
`publish-tauri.yml` builds and attaches the Windows installer. Both workflows also listen for
`release: published` and accept a tag through `workflow_dispatch`, so one failed publisher can be
re-run alone without rebuilding or retagging the release:

```bash
gh workflow run publish-npm.yml --ref main -f tag=v2.108.0
gh workflow run publish-tauri.yml --ref main -f tag=v2.108.0
```

## The one secret — `ENGINE_DEPLOY_KEY`

| | |
|---|---|
| **Name** | `ENGINE_DEPLOY_KEY` (repository secret on `agentistics/agentistics`) |
| **Value** | the PRIVATE half of an SSH key pair |
| **Scope** | the PUBLIC half registered as a **deploy key on `agentistics/agentistics-engine` only**, with **"Allow write access" unchecked** (read-only) |

```bash
ssh-keygen -t ed25519 -N '' -C 'agentistics release → agentistics-engine (read-only)' -f engine_deploy_key
gh repo deploy-key add engine_deploy_key.pub --repo agentistics/agentistics-engine --title 'agentistics release.yml (read-only)'
gh secret set ENGINE_DEPLOY_KEY --repo agentistics/agentistics < engine_deploy_key
shred -u engine_deploy_key engine_deploy_key.pub
```

A deploy key grants nothing beyond reading that one repository and survives this repository changing
owner. Until it exists, every release on `main` fails at "Read engine.pin" — merge the workflow change
only after the secret is in place.

Building the official binary by hand: see `docs/build-official.md` in the engine repository.
