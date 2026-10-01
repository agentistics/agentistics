# Building the official binary with the engine · Construindo o binário oficial com o engine

## EN

The public repository builds the **community** binary on its own (the engine slot is `null`). The
**official** binary is the same build with this engine in the slot. The host decides which engine it
carries at bundle time, through `packages/server/server/engine-slot.generated.ts` (spec §8), so the
whole procedure is: point the slot at an engine checkout, then build as usual.

```bash
# 1. Two checkouts side by side
git clone git@github.com:agentistics/agentistics.git
git clone git@github.com:agentistics/agentistics-engine.git      # private
cd agentistics && git checkout "$(jq -r .ref ../agentistics-engine/public.pin)"   # the public ref this engine targets
bun install

# 2. Install the engine and link it against that public checkout
cd ../agentistics-engine
AGENTISTICS_PUBLIC_DIR=../agentistics bun install    # postinstall runs scripts/link-public.ts

# 3. Build the binary with the engine in the slot
cd ../agentistics
export AGENTISTICS_ENGINE_DIR=../agentistics-engine  # build:assets regenerates the slot from this
bun run build:binary                                 # → release/agentop

# 4. Check it carries the engine — an official build without one is a defect
./release/agentop --version     # second line: "engine <version> (api <x.y.z>)"
```

Without `AGENTISTICS_ENGINE_DIR` (and with no `packages/engine/`), step 3 produces the community
binary: `--version` then says `engine: none — community build`.

**Dev with the engine:** `AGENTISTICS_ENGINE_DIR=../agentistics-engine bun run dev` (the slot is
regenerated from the variable; `bun run engine:slot:null` puts the community slot back).

**Before a release:** run the engine's own CI locally — `bun run typecheck && bun run test && bun run
parity` in this repository — and the public suite with the slot pointed here
(`cd packages/server && bun test`). `.github/workflows/engine-ci.yml` does all of it.

**Not done here (public repository, migration steps 4–5):** `release.yml` does not yet check this
repository out (deploy key `ENGINE_DEPLOY_KEY`, `engine.pin`, the `--version` smoke assertion). Until
it does, the official binary is built by hand as above.

## PT

O repositório público gera sozinho o binário **community** (slot do engine = `null`). O binário
**oficial** é o mesmo build com este engine no slot. O host decide qual engine carrega no momento do
bundle, por `packages/server/server/engine-slot.generated.ts` (spec §8), então o procedimento é:
apontar o slot para um checkout do engine e buildar normalmente.

```bash
# 1. Dois checkouts lado a lado
git clone git@github.com:agentistics/agentistics.git
git clone git@github.com:agentistics/agentistics-engine.git      # privado
cd agentistics && git checkout "$(jq -r .ref ../agentistics-engine/public.pin)"   # o ref público que este engine mira
bun install

# 2. Instalar o engine e linká-lo a esse checkout público
cd ../agentistics-engine
AGENTISTICS_PUBLIC_DIR=../agentistics bun install    # o postinstall roda scripts/link-public.ts

# 3. Buildar o binário com o engine no slot
cd ../agentistics
export AGENTISTICS_ENGINE_DIR=../agentistics-engine  # o build:assets regenera o slot a partir disso
bun run build:binary                                 # → release/agentop

# 4. Conferir que ele carrega o engine — um build oficial sem engine é defeito
./release/agentop --version     # segunda linha: "engine <versão> (api <x.y.z>)"
```

Sem `AGENTISTICS_ENGINE_DIR` (e sem `packages/engine/`), o passo 3 gera o binário community:
`--version` diz `engine: none — community build`.

**Desenvolver com o engine:** `AGENTISTICS_ENGINE_DIR=../agentistics-engine bun run dev` (o slot é
regenerado pela variável; `bun run engine:slot:null` volta ao slot community).

**Antes de um release:** rode a CI do engine localmente — `bun run typecheck && bun run test && bun
run parity` neste repositório — e a suíte pública com o slot apontando para cá
(`cd packages/server && bun test`). O `.github/workflows/engine-ci.yml` faz tudo isso.

**Não feito aqui (repositório público, passos 4–5 da migração):** o `release.yml` ainda não faz
checkout deste repositório (deploy key `ENGINE_DEPLOY_KEY`, `engine.pin`, a asserção de smoke do
`--version`). Até lá, o binário oficial é buildado à mão como acima.
