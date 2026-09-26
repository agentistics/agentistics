
# Agentistics — Runtime, Adapter Architecture & Native Harness
## Discovery, Specification, Compatibility, Parity e Plano de Implementação

## 0. Instrução principal

Você está trabalhando no repositório atual do **Agentistics**.

Antes de propor ou modificar qualquer código, faça uma investigação profunda do estado atual do repositório, arquitetura, dados, parsers, adapters existentes, métricas, superfícies, persistência, MCP, chat, TUI, CLI, OTel, Team Mode, skills/hooks e demais componentes relacionados.

### REGRA ABSOLUTA

Esta fase é de **discovery + especificação arquitetural**.

**NÃO implementar código.**

Não modificar arquivos.

Não criar migrations.

Não alterar schemas.

Não executar refactors.

Não remover funcionalidades.

Não alterar comportamento.

Não fazer `git add`, `git commit` ou `git push`.

O objetivo desta fase é produzir uma especificação suficientemente precisa para que a implementação posterior possa ser feita incrementalmente, com paridade verificável e rollback.

---

# 1. Objetivo estratégico

O Agentistics atualmente funciona principalmente como uma plataforma de observabilidade/analytics para múltiplos AI coding harnesses.

Precisamos evoluir sua arquitetura para suportar três capacidades simultaneamente:

### A. External Harnesses

Continuar suportando harnesses externos como:

- Claude Code
- Codex
- Gemini CLI
- GitHub Copilot CLI
- Antigravity
- Kimi Code
- outros harnesses futuros

através de adapters/instrumentação.

### B. Native Agentistics Harness

Criar futuramente um Harness nativo do Agentistics, baseado no próprio Runtime do Agentistics, capaz de:

- executar agentes;
- chamar providers/modelos;
- executar tools;
- executar subagents;
- utilizar ALM;
- utilizar browser;
- executar shell/filesystem/git/MCP;
- aplicar policies;
- produzir telemetria nativa;
- operar via CLI/TUI;
- operar via Web;
- operar via API;
- compartilhar a mesma Session entre diferentes superfícies.

### C. Agentistics Runtime

O futuro Harness não deve ser um produto separado ou um segundo sistema paralelo.

Deve existir um Runtime central:

```text
Agentistics Runtime
│
├── Native Agent Harness
├── Web Chat
├── CLI
├── TUI
├── API
├── MCP
└── External Harness Adapters
```

Todas essas superfícies devem compartilhar os mesmos conceitos fundamentais:

- Session
- Run
- Agent
- Subagent
- Task
- Model Invocation
- Tool Execution
- Browser Execution
- ALM
- Events
- Metrics
- Provider
- Repository
- Project

---

# 2. Princípio arquitetural fundamental

A arquitetura deve separar claramente:

```text
Provider
Harness
Runtime
Adapter
Gateway
UI
Analytics
ALM
```

### Provider

Fonte de inteligência/modelo:

- Anthropic
- OpenAI
- Google
- OpenRouter
- LiteLLM
- Ollama
- outros

### Harness

Orquestrador do agente:

- Claude Code
- Codex
- Gemini CLI
- OpenCode
- Agentistics Harness
- outros

### Runtime

Ambiente operacional:

- filesystem
- shell
- git
- browser
- MCP
- processes
- network
- tools

### Adapter

Integração entre um Harness externo e o domínio/eventos do Agentistics.

### Provider Gateway

Camada opcional para intermediar chamadas de modelos e capturar:

- request
- response
- model
- provider
- tokens
- latency
- usage
- cost
- errors
- correlation IDs

O Gateway **não substitui** a telemetria do Harness.

### UI

Superfície de interação com o mesmo Runtime:

- Web
- CLI
- TUI
- API consumers

### Analytics

Consumidor dos eventos/projeções.

### ALM

Camada operacional de Tasks, critérios, evidências, estado e relacionamento com Sessions/Runs/Agents.

---

# 3. Princípio de compatibilidade

A arquitetura deve permitir adicionar um novo Harness no futuro sem precisar alterar o núcleo do Agentistics.

O objetivo deve ser:

```text
Novo Harness
     │
     ▼
Harness Adapter / Integration
     │
     ▼
Canonical Events
     │
     ▼
Agentistics Runtime Domain
     │
     ├── Analytics
     ├── ALM
     ├── Costs
     ├── Sessions
     ├── Compare
     └── demais superfícies
```

Adicionar um novo Harness deve exigir preferencialmente:

1. implementar o contrato do Adapter;
2. declarar capabilities;
3. mapear eventos/entidades;
4. fornecer fixtures;
5. validar paridade;
6. registrar o Harness no catálogo.

Não deve exigir reescrever:

- dashboard;
- analytics;
- cost engine;
- ALM;
- session system;
- event store;
- métricas;
- comparações.

---

# 4. Regra de ouro: normalizar sem perder granularidade

O objetivo do Adapter Architecture NÃO é transformar todos os Harnesses em uma entidade genérica.

Devemos:

> **Normalizar a semântica e o contrato sem perder identidade, granularidade, hierarquia, proveniência ou contexto da fonte original.**

Nunca colapsar:

- Harness
- Provider
- Model
- Session
- Run
- Agent
- Subagent
- Task
- Tool
- Tool Execution
- Model Invocation
- Repository
- Project
- Browser Session

em uma única dimensão quando a fonte original fornece essa informação.

---

# 5. Inventário obrigatório do estado atual

Investigar completamente:

## 5.1 Harnesses suportados atualmente

Para cada Harness:

- nome;
- versão;
- fonte de dados;
- formato dos dados;
- localização dos dados;
- mecanismo de descoberta;
- parser;
- adapter atual;
- métricas disponíveis;
- limitações;
- capabilities;
- dependências;
- hooks;
- plugins;
- APIs;
- logs;
- transcripts;
- arquivos temporários;
- persistência;
- subagents;
- tools;
- MCP;
- tokens;
- custos;
- modelos;
- sessões;
- duração;
- repositories;
- tasks;
- demais dimensões.

---

# 6. Inventário completo de métricas atuais

Identificar TODAS as métricas atualmente apresentadas pelo Agentistics.

Não assumir que apenas custos e tokens importam.

Catalogar:

- custo;
- input tokens;
- output tokens;
- cached tokens;
- total tokens;
- requests;
- model invocations;
- latency;
- session duration;
- agent duration;
- subagent duration;
- number of agents;
- number of subagents;
- tool calls;
- tool types;
- MCP calls;
- shell executions;
- file operations;
- git operations;
- browser activity;
- repositories;
- projects;
- sessions;
- tasks;
- tags;
- models;
- providers;
- harness;
- dates;
- timelines;
- etc.

Mapear cada métrica para:

```text
source
parser
field
transformation
aggregation
projection
UI
```

---

# 7. Preservação obrigatória da granularidade atual

O novo sistema deve continuar permitindo filtros e breakdowns como:

```text
Harness
Provider
Model
Repository
Project
Session
Run
Agent
Subagent
Task
Tool
Tool Type
Date
Tag
```

Exemplo:

```text
Total Cost
├── Claude Code
│   ├── Sonnet
│   ├── Opus
│   └── Subagents
│
├── Codex
│   ├── GPT
│   └── Subagents
│
├── Antigravity
│
└── Agentistics
```

Também deve permitir:

```text
Provider = Anthropic
```

independentemente do Harness.

E:

```text
Harness = Claude Code
```

independentemente do Provider.

E:

```text
Task = X
```

agregando Claude Code + Codex + Agentistics.

---

# 8. Canonical Domain Model

Definir formalmente as entidades:

```text
Task
Project
Repository
Session
Run
Harness
Agent
Subagent
Provider
ProviderConnection
Model
ModelDeployment
ModelInvocation
Tool
ToolExecution
BrowserSession
BrowserTab
ALM Evidence
Event
Metric
Artifact
```

Definir:

- IDs;
- lifecycle;
- parent/child;
- ownership;
- timestamps;
- relationships;
- cardinalidade;
- correlation;
- provenance.

---

# 9. Hierarquia obrigatória

Definir uma hierarquia semelhante a:

```text
Task
 │
 └── Session
      │
      ├── Run
      │    │
      │    ├── Agent
      │    │    │
      │    │    ├── Model Invocation
      │    │    ├── Tool Execution
      │    │    └── Subagent
      │    │
      │    └── ...
      │
      └── ...
```

A arquitetura deve suportar uma Session contendo múltiplos Harness Runs:

```text
Session #123
│
├── Claude Code Run
│   ├── Main Agent
│   ├── Subagent A
│   └── Subagent B
│
├── Codex Run
│   └── Main Agent
│
└── Agentistics Run
    ├── Main Agent
    └── Subagent
```

Isso deve ser uma capacidade explícita.

---

# 10. Event Architecture

Definir um Event Model canônico.

Exemplo:

```ts
interface AgentisticsEvent {
  id: string;
  type: string;
  timestamp: string;

  sessionId: string;
  runId?: string;
  taskId?: string;
  agentId?: string;
  parentAgentId?: string;

  source: {
    kind: "harness" | "provider" | "runtime" | "alm" | "adapter";
    id: string;
    version?: string;
  };

  provenance: {
    mode:
      | "native"
      | "instrumented"
      | "observed"
      | "inferred"
      | "replayed";

    adapterVersion?: string;
    sourceRecordId?: string;
  };

  data: unknown;
}
```

Não assumir esse contrato literalmente.

Investigar e propor a melhor versão.

---

# 11. Event Types

Mapear eventos atuais e futuros:

```text
session.started
session.completed

run.started
run.completed

agent.started
agent.completed

subagent.started
subagent.completed

model.requested
model.started
model.delta
model.completed
model.failed

tool.requested
tool.approved
tool.started
tool.progress
tool.completed
tool.failed

mcp.requested
mcp.completed

browser.session.started
browser.tab.created
browser.tab.focused
browser.navigation
browser.click
browser.input
browser.scroll
browser.screenshot
browser.download
browser.tab.closed

alm.task.created
alm.task.started
alm.task.updated
alm.task.completed

policy.requested
policy.approved
policy.denied
```

Determinar quais são obrigatórios, opcionais e específicos de cada Harness.

---

# 12. Live Ingestion

Este é um requisito crítico.

A arquitetura NÃO deve depender exclusivamente da leitura posterior de arquivos locais.

Quando possível, o Adapter deve suportar:

```text
Harness
  │
  ├── hooks
  ├── plugin
  ├── API
  ├── event stream
  ├── process telemetry
  └── outros mecanismos
        │
        ▼
Agentistics Collector
```

O Agentistics deve capturar eventos durante a execução.

---

# 13. Durable Event Journal

Projetar um Event Journal append-only/durável.

Objetivo:

> Se os arquivos locais do Harness forem apagados depois, o Agentistics ainda deve conseguir reconstruir a sessão a partir dos eventos já ingeridos.

Fluxo:

```text
Harness
   │
   ▼
Collector
   │
   ▼
Event Journal
   │
   ├── Raw Events
   ├── Canonical Events
   └── Metadata
          │
          ▼
     Projections
          │
          ▼
       Analytics
```

O Event Journal deve suportar:

- idempotência;
- deduplicação;
- ordenação;
- replay;
- recovery;
- auditoria;
- reprocessamento;
- versionamento.

---

# 14. Source Artifacts

Arquivos locais/transcripts/logs dos Harnesses continuam importantes.

Porém, devem ser tratados como:

- source evidence;
- replay;
- recovery;
- auditoria;
- validação;
- backfill.

Não devem ser a única fonte da contabilidade futura quando live ingestion for possível.

Definir estratégia para:

```text
Live Event
+
Source Artifact
=
Reconciliation
```

---

# 15. Replay

Cada Adapter deve idealmente suportar dois modos:

```text
Live Adapter
    ↓
eventos durante execução
```

e:

```text
Replay Adapter
    ↓
artefatos históricos
```

Ambos devem produzir o mesmo modelo canônico.

---

# 16. Reconciliation

Definir como comparar:

```text
Live Events
     VS
Source Artifacts
```

Detectar:

- missing events;
- duplicate events;
- divergent timestamps;
- divergent token counts;
- divergent costs;
- missing subagents;
- missing tools;
- inconsistências.

Nunca corrigir silenciosamente sem registrar a proveniência.

---

# 17. Capabilities

Cada Harness deve declarar capabilities.

Exemplo:

```text
Claude Code
├── sessions: supported
├── agents: supported
├── subagents: supported
├── tools: supported
├── MCP: supported
├── tokens: exact
├── cost: exact/estimated
├── browser: partial
└── ...
```

Estados devem distinguir:

```text
supported
not_supported
unknown
not_applicable
estimated
derived
observed
inferred
```

Nunca usar `0` para representar ausência de suporte.

---

# 18. Provenance

Toda métrica relevante deve permitir responder:

```text
O que foi medido?
Quem produziu?
De onde veio?
Como foi capturado?
Quando foi capturado?
Qual versão do Adapter?
Qual versão da fonte?
É exato ou estimado?
```

Exemplo conceitual:

```text
metric = llm.cost
value = 1.42
harness = claude-code
provider = anthropic
model = ...
provenance = observed
measurement = provider_usage
confidence = exact
```

---

# 19. Metric Ownership

Separar:

### Harness telemetry

Exemplo:

- subagents;
- tools;
- shell;
- MCP;
- agent lifecycle;
- task execution.

### Provider telemetry

Exemplo:

- model;
- token usage;
- request;
- response;
- provider latency;
- provider cost.

### Runtime telemetry

Exemplo:

- filesystem;
- browser;
- process;
- network.

### Derived telemetry

Exemplo:

- aggregate cost;
- efficiency;
- cost/task;
- tool success rate.

Definir claramente qual componente é autoridade para cada métrica.

---

# 20. Provider Architecture

Criar especificação conceitual para:

```text
Provider
ProviderConnection
ProviderAccount
Credential
Model
ModelDeployment
ModelRoute
ModelInvocation
Usage
Pricing
```

O Native Harness deve poder utilizar diretamente:

```text
Anthropic API
OpenAI API
Google API
OpenRouter
LiteLLM
Ollama
custom providers
```

através de uma abstração comum.

---

# 21. Direct Provider Mode

Suportar:

```text
Agentistics Harness
       │
       ▼
Provider API
       │
       ▼
Model
```

Esse deve ser o caminho principal inicialmente.

---

# 22. Provider Gateway

Especificar um Gateway/Proxy opcional:

```text
Agentistics Harness
       │
       ▼
Agentistics Provider Gateway
       │
       ├── Anthropic
       ├── OpenAI
       ├── Google
       ├── OpenRouter
       └── outros
```

O Gateway deve capturar quando disponível:

- provider;
- model;
- request ID;
- response ID;
- input tokens;
- output tokens;
- cached tokens;
- latency;
- cost;
- errors;
- retries;
- correlation IDs.

O Gateway NÃO deve ser considerado responsável por:

- subagents;
- tools;
- MCP;
- browser;
- shell;
- filesystem;
- ALM;
- agent lifecycle.

Esses pertencem ao Harness/Runtime.

---

# 23. Correlation

Definir IDs capazes de relacionar:

```text
Task
↓
Session
↓
Run
↓
Agent
↓
Model Invocation
↓
Provider Request
```

Exemplo:

```text
taskId
sessionId
runId
agentId
modelInvocationId
providerRequestId
parentInvocationId
```

Garantir que uma chamada ao provider possa ser atribuída ao Harness e Agent corretos.

---

# 24. Native Agentistics Runtime

Especificar contratos para:

```text
Agent Runtime
Context Runtime
Tool Runtime
Provider Runtime
Browser Runtime
Policy Runtime
Event Runtime
ALM Runtime
Persistence Runtime
```

---

# 25. Native Harness

O Native Harness deve:

- executar agents;
- executar subagents;
- chamar providers;
- executar tools;
- executar MCP;
- operar filesystem;
- operar shell;
- operar git;
- operar browser;
- executar ALM;
- aplicar policies;
- emitir eventos;
- persistir eventos;
- suportar streaming;
- permitir resume;
- permitir replay.

---

# 26. Agent Loop

Especificar o agent loop sem amarrar prematuramente a uma implementação:

```text
Session
 ↓
Context
 ↓
Model Invocation
 ↓
Model Response
 ↓
Tool/Agent Actions
 ↓
Policy
 ↓
Execution
 ↓
Tool Result
 ↓
Context Update
 ↓
Next Invocation
```

Subagents devem participar da mesma arquitetura.

---

# 27. Native Telemetry

O Native Harness deve produzir diretamente eventos canônicos.

Não utilizar parser posterior como mecanismo primário.

Exemplo:

```text
Agentistics Harness
       │
       ▼
Native Event Bus
       │
       ▼
Event Journal
```

Isso garante máxima precisão.

---

# 28. Browser Runtime

Browser deve ser primeira classe.

Definir:

```text
BrowserSession
BrowserTab
Navigation
Click
Input
Scroll
Screenshot
Download
TabLifecycle
```

Permitir implementações como:

- browser extension;
- Playwright/Chromium;
- remote browser;
- outra implementação futura.

O mesmo contrato deve ser utilizado pelo Native Harness.

---

# 29. Web Harness

O futuro Harness deve ser plugável na Web atual.

O Web Chat existente deve evoluir para uma superfície do Runtime, não para um segundo agent loop.

Arquitetura:

```text
Web UI
   │
   ▼
Agentistics Runtime
   │
   ▼
Session
```

A Web deve consumir o mesmo Event Stream utilizado por:

- CLI;
- TUI;
- API;
- demais clientes.

---

# 30. Shared Session

Deve ser possível:

```text
CLI
  ↓
Session #123
  ↓
Web
  ↓
Session #123
  ↓
API
  ↓
Session #123
```

A Session não pertence à UI.

Ela pertence ao Runtime.

---

# 31. Streaming

Projetar streaming para:

- model output;
- tool progress;
- agent state;
- subagent state;
- browser events;
- ALM events.

A Web deve conseguir renderizar eventos em tempo real.

---

# 32. External Harnesses

Definir como o Agentistics pode integrar:

```text
Claude Code
Codex
Gemini
Antigravity
Kimi
GitHub Copilot
OpenCode
future harnesses
```

Cada um deve ser tratado como um Harness independente.

---

# 33. External Harness Execution Modes

Investigar e especificar suporte para:

### Spawn

```text
Agentistics
   ↓
spawn Harness
```

### Attach

```text
existing Harness
       ↓
Agentistics attaches
```

### Observe

```text
Harness
   ↓
Agentistics observes
```

### Instrument

```text
Harness
   ↓
hooks/plugins/events
   ↓
Agentistics
```

Definir capabilities de cada método por Harness.

---

# 34. Novo Harness plugável

Definir um SDK/contrato que permita:

```text
packages/harness-sdk
```

ou equivalente.

Um novo Harness deve precisar fornecer algo equivalente a:

```text
Identity
Capabilities
Lifecycle mapping
Event mapping
Session mapping
Agent mapping
Subagent mapping
Tool mapping
Model mapping
Provider mapping
Usage mapping
Source/replay support
Live ingestion support
```

Evitar acoplamento ao dashboard.

---

# 35. Paridade

A nova arquitetura só pode ser considerada pronta se preservar a semântica atual.

Criar matriz:

```text
Metric
Legacy
Adapter
Native
Source
Exactness
Status
```

Exemplo:

```text
Claude cost
Claude tokens
Claude agents
Claude subagents
Claude tools
Claude duration
Codex cost
Codex tokens
...
```

---

# 36. Golden Fixtures

Criar fixtures reais representativas de cada Harness.

Devem cobrir:

- session;
- agents;
- subagents;
- tool calls;
- model calls;
- tokens;
- cost;
- errors;
- concurrency;
- retries;
- nested agents;
- MCP;
- browser quando aplicável.

---

# 37. Invariantes

Definir invariantes como:

```text
sum(agent costs) <= session cost
```

quando semanticamente aplicável.

E:

```text
tool.completed
```

não pode existir sem correspondente:

```text
tool.started
```

salvo casos explicitamente definidos.

Outros invariantes devem ser descobertos durante a investigação.

---

# 38. Idempotência

Processar o mesmo evento duas vezes não pode duplicar:

- custos;
- tokens;
- tools;
- agents;
- sessions;
- model invocations.

Definir event identity e deduplication.

---

# 39. Temporal Semantics

Definir:

- event time;
- ingestion time;
- source time;
- start time;
- end time;
- duration;
- clock skew;
- ordering;
- concurrency.

Nunca assumir que ordem de ingestão = ordem de execução.

---

# 40. Historical Compatibility

Dados históricos existentes não podem ser silenciosamente alterados.

Se uma nova interpretação for necessária:

```text
legacy projection
+
new projection
```

devem poder coexistir durante migração.

---

# 41. Raw / Normalized / Derived

Separar explicitamente:

```text
Raw
 ↓
Adapter
 ↓
Canonical
 ↓
Normalized Domain
 ↓
Derived Metrics
 ↓
Projection/UI
```

Preservar raw provenance.

---

# 42. Não depender de arquivos locais

Critério:

> O Agentistics deve conseguir reconstruir uma sessão já ingerida mesmo que os artefatos locais do Harness original sejam apagados posteriormente.

Quando live ingestion não for possível, declarar explicitamente a limitação.

---

# 43. Security

Investigar:

- credentials;
- API keys;
- provider secrets;
- local data;
- browser data;
- sensitive tool output;
- shell output;
- filesystem content.

Definir o que deve ser armazenado e o que deve ser redacted.

---

# 44. Provider Credentials

Não assumir que credenciais de assinatura de um Harness externo podem ser reutilizadas pelo Agentistics.

Exemplo:

```text
Claude Code subscription
```

não deve ser tratado automaticamente como:

```text
Anthropic API credential
```

O Native Harness deve suportar conexões legítimas através de:

- API keys;
- OAuth quando oficialmente suportado;
- provider integrations;
- local providers;
- gateways.

---

# 45. Native vs External

Definir claramente:

```text
Native Harness
    → native telemetry

External Harness
    → adapter telemetry

Provider
    → provider telemetry

Gateway
    → provider request telemetry
```

Nenhuma camada deve fingir possuir informações que não possui.

---

# 46. Dashboard Compatibility

Preservar os filtros atuais.

No mínimo:

```text
Harness
Provider
Model
Repository
Project
Session
Agent
Subagent
Tool
Task
Date
Tag
```

O usuário deve continuar conseguindo responder:

> Quanto gastei com Claude?

> Quanto gastei no Claude Code?

> Quanto gastei com Claude através do Agentistics?

> Quanto o Codex gastou?

> Quanto uma Task custou?

> Quanto custaram os subagents?

> Quais tools mais consumiram tempo?

---

# 47. Compare

Preservar e expandir comparações:

```text
Claude Code vs Codex
Claude vs GPT
Agentistics Harness vs Claude Code
Task A vs Task B
Repository A vs Repository B
```

Sempre respeitando capabilities.

---

# 48. Cost Model

Definir separadamente:

```text
provider cost
estimated cost
observed cost
subscription usage
internal accounting
```

Não assumir que todos os Harnesses possuem preço calculável.

---

# 49. Subscription-based Harnesses

Definir como representar Harnesses onde:

- o usuário paga assinatura;
- custo marginal da chamada não está disponível;
- tokens podem ser parcialmente observáveis;
- usage pode ter limites proprietários.

Não inventar custo por request.

Permitir:

```text
cost = unknown
```

quando necessário.

---

# 50. External Harness + Native Harness simultâneos

Suportar:

```text
Task
│
├── Claude Code Run
├── Codex Run
└── Agentistics Run
```

Todos devem ser agregáveis, mas permanecer individualmente identificáveis.

---

# 51. ALM

ALM deve deixar de ser apenas uma ferramenta externa utilizada por agents.

Especificar integração nativa:

```text
Task
│
├── Acceptance Criteria
├── Session
├── Runs
├── Agents
├── Tools
├── Browser
├── Evidence
└── Metrics
```

---

# 52. Evidence

Uma Task deve conseguir apontar para evidências produzidas durante:

- tool execution;
- browser;
- tests;
- git;
- model output;
- agent result.

---

# 53. Replay

O Runtime deve permitir replay/auditoria da execução com base nos eventos persistidos.

Não necessariamente executar novamente as ações perigosas.

Definir claramente:

```text
visual replay
event replay
state replay
execution replay
```

---

# 54. Observability

Definir observabilidade interna do próprio Agentistics:

- event ingestion latency;
- dropped events;
- duplicate events;
- adapter errors;
- provider errors;
- reconciliation failures;
- journal failures;
- projection failures.

---

# 55. Versioning

Versionar:

```text
Canonical Event Schema
Adapter
Harness Source Format
Provider Schema
Metric Semantics
```

Uma atualização de parser não pode silenciosamente reinterpretar dados históricos sem rastreabilidade.

---

# 56. Migration Strategy

Propor migração incremental:

```text
Legacy
   │
   ▼
Adapter Layer
   │
   ▼
Canonical Events
   │
   ▼
Parity
   │
   ▼
New Projections
```

Manter fallback para o sistema atual enquanto necessário.

---

# 57. Feature Flags

Definir flags para:

- adapter pipeline;
- live ingestion;
- event journal;
- new projections;
- native runtime;
- provider gateway;
- web runtime;
- native harness.

---

# 58. Rollback

Cada fase deve possuir rollback independente.

Nunca exigir uma migração big-bang.

---

# 59. Native Harness Roadmap

Somente depois da arquitetura canônica e parity estarem estabelecidas, especificar implementação do Native Harness.

Prioridade:

1. Session
2. Agent
3. Context
4. Provider Runtime
5. Model Invocation
6. Tool Runtime
7. Shell
8. Filesystem
9. Git
10. MCP
11. ALM
12. Subagents
13. Browser
14. Policy
15. Web Runtime
16. CLI/TUI
17. API
18. Replay

---

# 60. Web-first compatibility

O Native Harness deve ser consumível pelo Web Chat existente desde a arquitetura inicial.

Não criar uma implementação Web-specific do agent loop.

O fluxo deve ser:

```text
Web
 ↓
Runtime API
 ↓
Session
 ↓
Agent
 ↓
Provider / Tools
 ↓
Events
 ↓
Web stream
```

---

# 61. API

Definir APIs para:

```text
create session
resume session
send message
stream events
cancel run
approve tool
reject tool
list sessions
get session
list agents
get metrics
get events
create task
associate task
```

---

# 62. MCP

Definir como MCP participa do Native Runtime:

```text
Agent
 ↓
MCP Client
 ↓
MCP Server
 ↓
Tool
```

Registrar eventos e métricas sem confundir MCP com o Harness.

---

# 63. Extensibilidade

Projetar plugins/extensões para:

```text
Harness
Provider
Tool
Browser
Policy
Storage
Telemetry
```

Definir quais pontos são estáveis e quais permanecem internos.

---

# 64. Critério para adicionar novo Harness

Definir uma checklist objetiva:

```text
[ ] Identity
[ ] Capabilities
[ ] Source discovery
[ ] Live ingestion
[ ] Replay
[ ] Session mapping
[ ] Run mapping
[ ] Agent mapping
[ ] Subagent mapping
[ ] Tool mapping
[ ] Model mapping
[ ] Provider mapping
[ ] Usage mapping
[ ] Cost mapping
[ ] Provenance
[ ] Fixtures
[ ] Golden tests
[ ] Parity
[ ] Documentation
```

Um Harness que não suporta determinada dimensão deve declarar isso.

---

# 65. Não inventar compatibilidade

Se um Harness não oferece:

```text
subagent data
```

o Adapter não deve fabricar.

Resultado:

```text
subagents = not_supported
```

e não:

```text
subagents = 0
```

---

# 66. Critérios de aceite da arquitetura

A arquitetura será considerada adequada somente se:

### Compatibilidade

- todos os Harnesses atuais continuam funcionando;
- um novo Harness pode ser adicionado sem alterar o core;
- capabilities são explícitas.

### Paridade

- métricas existentes continuam semanticamente equivalentes;
- custos continuam equivalentes;
- tokens continuam equivalentes;
- sessions continuam equivalentes;
- agents/subagents continuam equivalentes;
- tools continuam equivalentes;
- filtros continuam funcionando.

### Granularidade

É possível distinguir:

```text
Harness
Provider
Model
Session
Run
Agent
Subagent
Tool
Task
Repository
```

### Durabilidade

Depois da ingestão:

```text
delete local harness artifacts
```

não deve destruir os dados já capturados.

### Provenance

Toda métrica relevante pode responder de onde veio.

### Native Harness

O Native Harness produz os mesmos eventos canônicos dos adapters.

### Web

Web e CLI utilizam o mesmo Runtime e Session.

### Providers

Native Harness pode usar providers diretamente via API.

### Gateway

Gateway é opcional e complementar.

---

# 67. Questões que precisam de decisão humana

Não assumir decisões sobre:

- storage escolhido;
- event broker;
- retenção;
- segurança;
- credenciais;
- cloud vs local;
- browser implementation;
- provider routing;
- plugin sandbox;
- licensing;
- fork vs clean-room;
- dependências externas;
- compatibilidade com projetos OSS existentes.

Apresentar alternativas e trade-offs.

---

# 68. Avaliação de possíveis bases para o Native Harness

Investigar, sem decidir prematuramente:

- construir do zero;
- reutilizar componentes de um Harness OSS;
- adaptar um runtime OSS;
- utilizar um projeto como referência arquitetural;
- utilizar OpenCode;
- avaliar o projeto conhecido como Open Claude apenas após verificar exatamente sua origem, licença e implicações de propriedade intelectual.

Não assumir que código derivado de source proprietária exposta/leak pode ser incorporado ao Agentistics.

Separar:

```text
architectural inspiration
```

de:

```text
code reuse
```

e realizar avaliação jurídica/licenciamento antes de qualquer reutilização potencialmente problemática.

---

# 69. Estrutura esperada do relatório

O relatório final desta fase deve conter:

1. Resumo executivo
2. Estado atual
3. Escopo
4. Não-escopo
5. Princípios
6. Inventário de Harnesses
7. Inventário de fontes
8. Inventário de parsers
9. Inventário de entidades
10. Inventário completo de métricas
11. Inventário de superfícies
12. Dependências
13. Pontos de acoplamento
14. Problemas atuais
15. Canonical Domain Model
16. Event Model
17. Adapter Architecture
18. Live Ingestion
19. Event Journal
20. Replay
21. Reconciliation
22. Provenance
23. Capabilities
24. Metric Ownership
25. Provider Architecture
26. Provider Gateway
27. Correlation Model
28. Native Runtime Architecture
29. Native Harness Architecture
30. Browser Runtime
31. ALM Runtime
32. Web Runtime
33. CLI/TUI Runtime
34. API Runtime
35. MCP Runtime
36. External Harness Integration
37. Plugin/Extension Architecture
38. Security
39. Data retention
40. Parity Matrix
41. Golden Fixtures
42. Test Strategy
43. Invariants
44. Observability
45. Versioning
46. Migration
47. Feature Flags
48. Rollback
49. Native Harness Roadmap
50. Open Questions
51. Architectural Decisions
52. Alternatives and Trade-offs
53. Acceptance Criteria
54. Recommended Roadmap

---

# 70. Resultado esperado

Ao final desta investigação, deve ser possível responder objetivamente:

### Sobre Harnesses

- Como o Agentistics suporta Claude Code hoje?
- Como passará a suportar?
- Como adicionar Codex?
- Como adicionar um Harness desconhecido daqui a um ano?
- Quanto código novo é necessário?
- O que o novo Harness precisa fornecer?

### Sobre métricas

- De onde vem cada métrica?
- É nativa, instrumentada, observada ou inferida?
- O que acontece se o source artifact for apagado?
- Como preservamos subagents?
- Como preservamos tools?
- Como preservamos executions?
- Como preservamos custos?
- Como preservamos tokens?

### Sobre Native Harness

- Como executar Claude?
- Como executar GPT?
- Como executar Gemini?
- Como usar OpenRouter?
- Como usar modelos locais?
- Como funciona o Provider Gateway?
- Como funciona o Browser?
- Como funciona o ALM?
- Como funciona o Web Chat?
- Como funciona CLI/TUI?
- Como funciona API/MCP?

### Sobre arquitetura

- Qual é o verdadeiro core?
- Qual é o contrato estável?
- O que é adapter?
- O que é runtime?
- O que é harness?
- O que é provider?
- O que é gateway?
- Onde fica a verdade dos eventos?
- Como garantimos paridade?

---

# 71. Regra final

A arquitetura final deve permitir que o Agentistics evolua de:

```text
Analytics platform
       +
Harness log parsers
```

para:

```text
                         AGENTISTICS
                              │
                       Agentistics Runtime
                              │
              ┌───────────────┼────────────────┐
              │               │                │
        Native Harness    Web / CLI / API   External Adapters
              │               │                │
              │               │          ┌─────┼─────┐
              │               │          ▼     ▼     ▼
              │               │       Claude Codex Gemini
              │               │
              └───────────────┼──────────────────────┐
                              │                      │
                         Event Journal               │
                              │                      │
              ┌───────────────┼──────────────┐       │
              ▼               ▼              ▼       │
             ALM          Analytics       Audit      │
              │               │              │       │
              └───────────────┴──────────────┘       │
                                                     │
                         Provider Layer              │
                              │                      │
                 ┌────────────┼────────────┐         │
                 ▼            ▼            ▼         │
             Anthropic      OpenAI      OpenRouter   │
                                                     │
                         Browser Runtime              │
                              │                      │
                       Extension / Playwright        │
                                                     │
                         Canonical Domain ◄───────────┘
```

O objetivo final não é simplesmente "adicionar um Harness".

O objetivo é criar um **Runtime extensível de agentes**, no qual:

- Harnesses externos podem ser conectados;
- novos Harnesses podem ser adicionados com baixo acoplamento;
- o Native Harness é uma implementação de primeira classe;
- Web, CLI, TUI e API utilizam o mesmo Runtime;
- Providers são intercambiáveis;
- Provider Gateway é opcional;
- Browser é runtime de primeira classe;
- ALM é integrado ao ciclo de execução;
- eventos são persistidos de forma durável;
- métricas não dependem exclusivamente de arquivos locais;
- subagents, tools e executions permanecem granulares;
- custos permanecem atribuíveis;
- Harness, Provider e Model permanecem dimensões independentes;
- toda métrica possui proveniência;
- nenhuma informação suportada atualmente é perdida;
- e um novo Harness pode ser integrado sem reescrever o núcleo do Agentistics.

**Não iniciar implementação até que a especificação, matriz de paridade, contratos canônicos, estratégia de ingestão e critérios de aceitação estejam definidos e revisados.**