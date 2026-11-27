# Docker as the worker environment (S1: decide and suggest)

Everything here is behind the experimental `docker-env` flag (`AGENTISTICS_DOCKER_ENV=1`, or `agentop experimental
enable`). With the flag off nothing changes and nothing is offered. **S1 runs nothing in a container**: it decides which
backend a worker's environment *would* use, records the person's choice, and says how to install Docker. The container
lifecycle, cleanup and the screen come in later slices.

## The decision (`decideEnvBackend`, `@agentistics/core` `dockerEnv.ts`)

Pure. Inputs: the flag, what `docker-detectar` reports (present / running / version / **Engine API version**), whether the
platform's Docker is validated, the stored choice for the asking session, and whether the project's profile resolves to a
catalogue image carrying the tools it needs. Output: `docker` or `namespace` (today's `agentop run --rm`), a reason code,
one plain-language line and an optional suggestion (`use-docker` / `install-docker`). It never answers `docker` unless the
flag is on, the Engine is running, the platform is validated, API >= 1.45, a catalogue image fits and the choice is `docker`.
A suggestion never blocks, and a refusal (`namespace`) holds until Docker's state changes (`envOfferKey`).

## The choice has a scope

`only this session` > `this project` > `all sessions` — the most specific wins. Stored in `preferences.json`
(`envBackend: { all?, projects?, sessions? }`). Only the **proven** person (the connection's own identity read from the socket, never the absence of a `session` field; no proof = `person_unproven`, 403) or a **verified leader** may write it; a worker is refused
(`leader_only`). `agentop env use docker|namespace [--session [id] | --project [key] | --all]`.

## Installing Docker (hint only)

`agentop env install-hint [--os …]` (HTTP `GET /api/env/install-hint`, MCP `agentistics_env_install_hint`) prints, per system, what to
install, the cost, numbered steps and the official page. Linux: Docker Engine of the distribution. WSL2: Engine inside WSL.
macOS / Windows: Docker Desktop, cost marked as an estimate, and "stays off until validated" (not measured yet). agentop
never installs anything and never runs `sudo`; the later UI button only calls this and opens the page.
(Installing the *project's dependencies* in a container is a later slice and will not reuse this verb.)

## Surfaces

| | |
|---|---|
| CLI | `agentop env status [--json]`, `use`, `install-hint` |
| HTTP | `GET /api/env/status`, `GET /api/env/install-hint`, `POST /api/env/use`, `POST /api/env/grant` (role gate only) |
| MCP | `agentistics_env_status`, `agentistics_env_use`, `agentistics_env_install_hint` |

`/api/env` is a `localShell` prefix in `capability-guard.ts`.

## The image catalogue

`ENV_IMAGES`: a fixed list, pulled **only by digest**, each entry with `source` and `verifiedAt` (an entry without them
fails `catalogProblems`, the `MODEL_PRICING` rule). No build ever runs on a user's machine. A repo's `env.yml` may only
choose a **key**; a digest or `FROM` of its own is refused.

## S2: one disposable container per command (`packages/server/server/docker-env/`)

Still behind `docker-env`, and only when `decideEnvBackend` answers `docker` (a person or leader ran
`agentop env use docker`). `agentop run --rm -- <cmd>` then runs `<cmd>` in a container created for it alone:

- **create → inspect → start.** `docker create` (never started) with `--network none`,
  `--entrypoint /opt/agentistics/exec-wrap` (the image's ENTRYPOINT never runs), `--user <uid>:<gid>`, `--read-only`,
  `--cap-drop ALL`, `no-new-privileges`, `--memory M --memory-swap M`, no port, no Docker socket, env from a positive
  list via `--env-file` (deleted after create). `docker inspect` is then checked against the plan
  (`inspect-check.ts`); any difference ⇒ removed by id, refused. `argvRefusal` (`docker-argv.ts`) guards EVERY docker
  call: no `build`/`buildx`, no prune, no `network`, no published port, no socket.
- **Images** only from `ENV_IMAGES`, by digest; `image inspect` must carry the catalogue digest and an empty ONBUILD.
  `.agentistics/env.yml` may only pick a key (`env-profile.ts`); a digest, tag, `FROM`, `build:` ⇒ namespace + sentence.
- **State outside the worktree** lives in two volumes mounted by sub-path only: `scratch` (HOME, `/tmp`,
  `node_modules/.cache`, `.vite`) and `nm-g<gen>` (each `node_modules`, read-only except in `agentop env install`).
  `/tmp` therefore survives `--rm`, a killed launcher and an OOM.
- **Identity** (`session-proof.ts`): a session's volumes are used only when the launcher DESCENDS from the session's
  root pid (tmux pane, or `structured/<id>/relay.pid`); otherwise the run gets throwaway volumes, removed after.
- **Volumes** are proven ours (`volume-identity.ts`): no such name before, our labels + fresh `CreatedAt` after, a
  marker at the root read back. A pre-existing name ⇒ `volume_preexistente`; foreign labels ⇒ `volume_nao_nosso`.
- **Kill**: `docker kill --signal TERM`, 10 s, `docker kill`. The TTL is also applied inside (`timeout`), so a dead
  launcher still ends the command. A disk watchdog (15 s) stops a command over its ceiling and says the overshoot.
- **`agentop env install`** (`env-install.ts`): download with `--ignore-scripts` through the egress proxy
  (`egress-proxy.ts`, CONNECT :443 to allowed registries, every resolved address public and not the host's), worktree
  read-only, then the lifecycle scripts offline. Ledger: `<dataDir>/docker/ledger.json`.
- Not in this slice: `--serve` in a container (stays on the namespace), install grants, the git view (needs an image
  with git, S1b), cleanup (S3).
