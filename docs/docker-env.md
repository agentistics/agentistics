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
(`envBackend: { all?, projects?, sessions? }`). Only the person or a **verified leader** may write it; a worker is refused
(`leader_only`). `agentop env use docker|namespace [--session [id] | --project [key] | --all]`.

## Installing Docker (hint only)

`agentop env install [--os …]` (HTTP `GET /api/env/install`, MCP `agentistics_env_install`) prints, per system, what to
install, the cost, numbered steps and the official page. Linux: Docker Engine of the distribution. WSL2: Engine inside WSL.
macOS / Windows: Docker Desktop, cost marked as an estimate, and "stays off until validated" (not measured yet). agentop
never installs anything and never runs `sudo`; the later UI button only calls this and opens the page.
(Installing the *project's dependencies* in a container is a later slice and will not reuse this verb.)

## Surfaces

| | |
|---|---|
| CLI | `agentop env status [--json]`, `use`, `install` |
| HTTP | `GET /api/env/status`, `GET /api/env/install`, `POST /api/env/use`, `POST /api/env/grant` (role gate only) |
| MCP | `agentistics_env_status`, `agentistics_env_use`, `agentistics_env_install` |

`/api/env` is a `localShell` prefix in `capability-guard.ts`.

## The image catalogue

`ENV_IMAGES`: a fixed list, pulled **only by digest**, each entry with `source` and `verifiedAt` (an entry without them
fails `catalogProblems`, the `MODEL_PRICING` rule). No build ever runs on a user's machine. A repo's `env.yml` may only
choose a **key**; a digest or `FROM` of its own is refused.
