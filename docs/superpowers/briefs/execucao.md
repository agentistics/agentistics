# Agentistics — Execution, ALM, Spec Workflow & Performance Rules

## Objetivo

Definir as regras operacionais para executar o projeto de evolução do Agentistics Runtime, Adapter Architecture, Native Harness, Browser Runtime, ALM e demais componentes definidos no Master Architecture & Specification Plan.

Este documento **não substitui a especificação arquitetural**. Ele define **como o trabalho deve ser organizado, registrado, preparado, despachado e executado**.

---

# 1. ALM como fonte oficial de tarefas

Todo trabalho deve ser registrado no **@agentistics MCP ALM**.

Não criar tarefas relevantes apenas em:

- arquivos Markdown soltos;
- TODOs;
- issues locais;
- mensagens de chat;
- listas pessoais;
- comentários no código.

O ALM deve ser a fonte oficial para:

- Épicos;
- tarefas;
- subtasks;
- acceptance criteria;
- dependências;
- evidências;
- sessões de execução;
- status;
- resultados;
- bloqueios;
- decisões relevantes.

A hierarquia deve refletir o plano arquitetural:

```text
Epic
 ├── Phase
 │    ├── Task
 │    │    ├── Subtask
 │    │    ├── Acceptance Criteria
 │    │    ├── Dependencies
 │    │    └── Session
 │    │         └── Run / Execution
```

Toda subtask suficientemente concreta para ser executada por um agente deve possuir uma sessão associada antes do dispatch.

---

# 2. Uso obrigatório do @agentistics MCP ALM

Os agentes devem utilizar o **@agentistics MCP ALM** para:

1. criar tarefas;
2. consultar tarefas;
3. atualizar status;
4. registrar progresso;
5. registrar decisões;
6. registrar blockers;
7. anexar evidências;
8. associar sessões;
9. registrar resultados;
10. finalizar acceptance criteria.

O agente não deve manter uma "segunda fonte de verdade" sobre o estado da tarefa fora do ALM.

Quando uma decisão alterar significativamente a implementação ou arquitetura, ela deve ser registrada no ALM.

---

# 3. Investigação antes da implementação

Tarefas arquiteturalmente relevantes devem seguir:

```text
ALM Task
   ↓
Investigation
   ↓
Findings
   ↓
Specification
   ↓
Implementation Plan
   ↓
Implementation
   ↓
Validation
   ↓
Evidence
   ↓
ALM Completion
```

Não iniciar implementação relevante simplesmente porque "parece óbvio".

Durante a investigação, o agente deve descobrir:

- estado atual;
- código existente;
- dependências;
- comportamento atual;
- contratos;
- métricas existentes;
- riscos;
- incompatibilidades;
- impacto retroativo;
- impacto em dados;
- impacto em performance;
- oportunidades de reutilização;
- riscos de regressão.

---

# 4. Superpowers para transformar investigação em Spec

Após a investigação estar concluída, utilizar **Superpowers** para transformar os findings em uma especificação de implementação suficientemente detalhada.

A Spec deve responder:

- o que será alterado;
- por que será alterado;
- onde será alterado;
- quais contratos serão criados/modificados;
- quais componentes serão afetados;
- quais dados serão migrados;
- como preservar compatibilidade;
- como testar;
- como validar parity;
- como medir performance;
- como fazer rollback.

A Spec deve ser anexada à tarefa correspondente no ALM.

A implementação deve partir da Spec aprovada, e não diretamente das conclusões informais da investigação.

---

# 5. Sessões devem ser pré-criadas

Sempre que uma subtask for delegada a um agente, a sessão deve ser **pré-criada no ALM**.

A sessão deve conter, antes do dispatch:

- Harness;
- modelo;
- objetivo;
- prompt completo;
- contexto;
- arquivos relevantes;
- documentos/specs relevantes;
- acceptance criteria;
- restrições;
- dependências;
- ferramentas permitidas;
- resultado esperado.

Conceitualmente:

```text
ALM Subtask
     │
     └── Session preparada
           ├── Model
           ├── Prompt
           ├── Context
           ├── Attachments
           ├── Acceptance Criteria
           └── Constraints
                    │
                    ↓
                 DISPATCH
                    │
                    ↓
               Agent Run
```

O agente não deve precisar reconstruir o contexto da tarefa depois que a sessão for criada.

---

# 6. Dispatch

O ALM deverá permitir:

```text
Subtask
   ↓
Attach existing Session
   ↓
Review Session
   ↓
DISPATCH
   ↓
Session Run
```

O botão/ação **Dispatch** deve disparar exatamente a sessão preparada.

O dispatch não deve alterar silenciosamente:

- prompt;
- modelo;
- attachments;
- acceptance criteria;
- contexto;
- escopo.

Qualquer alteração significativa após a preparação deve gerar uma nova versão da sessão ou exigir atualização explícita antes do dispatch.

---

# 7. Seleção de modelo

O modelo deve ser escolhido de acordo com a complexidade da tarefa.

### Haiku

Preferencialmente para:

- tarefas simples;
- investigação localizada;
- leitura/análise de arquivos específicos;
- pequenas correções;
- tarefas mecânicas;
- documentação simples;
- testes simples;
- pequenas refatorações de baixo risco.

### Sonnet

Preferencialmente para:

- tarefas médias;
- implementação baseada em Spec;
- refatorações;
- integração entre componentes;
- criação de testes;
- análise arquitetural localizada;
- debugging complexo;
- tarefas onde seja necessário raciocínio consistente sobre múltiplos arquivos.

### Opus

**Nunca utilizar automaticamente.**

Opus exige **aprovação explícita**.

Só utilizar quando houver justificativa concreta, por exemplo:

- decisão arquitetural crítica;
- investigação extremamente complexa;
- debugging difícil;
- migração de alto risco;
- problema onde Sonnet demonstrou insuficiência;
- tarefa com alto impacto sistêmico.

O ALM deve registrar:

```text
model
modelSelectionReason
approvalRequired
approvedBy
approvalTimestamp
```

Não usar Opus simplesmente porque "é melhor".

---

# 8. Paralelismo

O sistema deve permitir execução paralela de múltiplas sessões.

Porém, paralelismo não significa carregar tudo em memória.

Deve existir controle explícito de:

- concorrência máxima;
- limite de RAM;
- limite de CPU;
- quantidade de sessões ativas;
- quantidade de agentes ativos;
- tamanho de contexto;
- buffers de eventos;
- filas de execução;
- backpressure.

Conceitualmente:

```text
              Scheduler
                  │
       ┌──────────┼──────────┐
       ↓          ↓          ↓
    Session A  Session B  Session C
       │          │          │
       └──────────┼──────────┘
                  ↓
          Resource Manager
                  │
        ┌─────────┴─────────┐
        ↓                   ↓
       CPU                 RAM
```

O Scheduler deve impedir que a execução de N sessões consuma N × todo o estado disponível.

---

# 9. Regra crítica de memória

A implementação atual não deve assumir que:

```text
carregar todo o chat
+
carregar todo o histórico
+
carregar todos os eventos
+
carregar todos os attachments
+
carregar todas as sessões
```

seja aceitável.

Isso deve ser tratado como **problema arquitetural de performance**.

Chats, eventos, transcripts e resultados grandes devem utilizar, sempre que possível:

- streaming;
- paginação;
- lazy loading;
- iterators;
- async iterators;
- processamento incremental;
- leitura por chunks;
- backpressure;
- buffers limitados;
- cache com eviction;
- índices;
- armazenamento persistente;
- snapshots;
- event journal;
- materialização sob demanda.

Evitar estruturas que mantenham desnecessariamente todo o conteúdo na RAM.

---

# 10. Streaming

Sempre que o domínio permitir, preferir:

```text
Storage
   ↓
Stream
   ↓
Parser
   ↓
Event
   ↓
Projection
```

em vez de:

```text
Storage
   ↓
read everything
   ↓
RAM
   ↓
parse everything
   ↓
events
```

Isso deve ser aplicado especialmente a:

- transcripts;
- chats;
- eventos;
- logs;
- attachments grandes;
- histórico de sessões;
- resultados de ferramentas;
- outputs de agentes;
- arquivos de observabilidade.

O frontend também deve evitar carregar o histórico completo de uma sessão quando apenas uma janela dele está sendo visualizada.

---

# 11. Chats

A abertura de um chat não deve significar:

```text
GET entire conversation
→ deserialize entire conversation
→ store entire conversation in RAM
→ render entire conversation
```

Preferir:

```text
Open session
   ↓
Load metadata
   ↓
Load recent/visible window
   ↓
Stream additional messages
   ↓
Virtualized rendering
   ↓
Load older messages on demand
```

A UI deve suportar sessões muito grandes sem degradação proporcional ao tamanho total do histórico.

---

# 12. Execução de múltiplas sessões

Uma sessão deve possuir lifecycle independente:

```text
created
prepared
queued
dispatched
running
paused
completed
failed
cancelled
```

O runtime deve conseguir manter várias sessões em estados diferentes simultaneamente.

Exemplo:

```text
Session A → running
Session B → waiting
Session C → running
Session D → paused
Session E → completed
```

Não assumir que todas as sessões precisam estar integralmente residentes na memória.

---

# 13. Resource-aware scheduling

O Scheduler deve considerar recursos antes de iniciar uma execução.

Exemplo conceitual:

```text
if availableMemory < requiredMemory:
    queue()

if activeSessions >= concurrencyLimit:
    queue()

if cpuPressure > threshold:
    queue()

otherwise:
    dispatch()
```

A capacidade deve ser dinâmica quando possível.

O sistema deve conseguir:

- iniciar sessões;
- pausar sessões;
- colocar sessões em fila;
- retomar sessões;
- limitar concorrência;
- aplicar backpressure.

---

# 14. Context Management

Não enviar para o modelo todo o histórico simplesmente porque ele existe.

Utilizar estratégias como:

- contexto incremental;
- sumarização;
- snapshots;
- compactação;
- recuperação seletiva;
- busca semântica quando apropriado;
- carregamento de contexto sob demanda;
- separação entre estado persistido e contexto enviado ao modelo.

Importante:

**Persistência completa ≠ contexto completo enviado ao modelo.**

Uma sessão pode possuir milhões de eventos persistidos sem precisar enviar milhões de eventos ao modelo.

---

# 15. Attachments

Attachments devem ser tratados como referências persistentes sempre que possível.

Não duplicar grandes arquivos na memória ou dentro do objeto da sessão.

Preferir:

```text
Session
 └── Attachment Reference
       ├── storageId
       ├── mimeType
       ├── size
       ├── checksum
       └── metadata
```

O conteúdo deve ser carregado apenas quando necessário.

---

# 16. Eventos

Eventos devem ser processados incrementalmente.

Evitar:

```text
events = await getAllEvents()
```

quando a quantidade puder crescer significativamente.

Preferir mecanismos equivalentes a:

```text
for await (const event of eventStream) {
    process(event)
}
```

com processamento incremental e controle de memória.

O Event Journal deve funcionar como fonte persistente para:

- replay;
- recuperação;
- analytics;
- auditoria;
- reconstrução de estado;
- debugging;
- observabilidade.

---

# 17. Performance como Acceptance Criteria

Performance não deve ser considerada apenas uma otimização futura.

Para componentes que lidam com sessões, eventos ou histórico, a tarefa deve possuir critérios mensuráveis.

Exemplos:

- memória máxima;
- tempo de abertura de sessão;
- throughput de eventos;
- latência de streaming;
- número máximo de sessões concorrentes;
- tamanho máximo de transcript;
- tempo de recuperação;
- tempo de dispatch;
- tempo de carregamento inicial.

Sempre que possível, adicionar benchmark/regression test.

---

# 18. Documentação no ALM

Ao finalizar uma tarefa, registrar:

### O que foi feito

Resumo objetivo da implementação.

### O que mudou

Arquivos/componentes/contratos afetados.

### Evidências

- testes;
- benchmarks;
- screenshots quando relevantes;
- logs;
- métricas;
- fixtures;
- parity reports.

### Decisões

Decisões arquiteturais relevantes tomadas durante a execução.

### Limitações

Tudo que ficou deliberadamente fora do escopo.

### Próximos passos

Tasks/subtasks que surgiram como consequência.

---

# 19. Status nunca deve ser inferido

O ALM deve refletir o estado real.

Exemplo:

```text
TODO
→ INVESTIGATING
→ SPEC_READY
→ READY
→ DISPATCHED
→ RUNNING
→ VALIDATING
→ COMPLETED
```

Em caso de falha:

```text
RUNNING
   ↓
BLOCKED / FAILED
```

Não marcar como completed apenas porque o agente terminou a sessão.

A tarefa só pode ser concluída quando os acceptance criteria forem validados.

---

# 20. Regra de ouro

O fluxo oficial de trabalho será:

```text
                    ┌──────────────┐
                    │      ALM     │
                    └──────┬───────┘
                           │
                     Create Task
                           │
                           ↓
                    Investigation
                           │
                           ↓
                    Findings stored
                           │
                           ↓
                      Superpowers
                           │
                           ↓
                     Detailed Spec
                           │
                           ↓
                    Create Session
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
           Prompt       Attachments    Model
              │            │            │
              └────────────┼────────────┘
                           ↓
                      Review Session
                           │
                           ↓
                        DISPATCH
                           │
                           ↓
                       Agent Run
                           │
                           ↓
                    Streamed Events
                           │
                           ↓
                 Validation / Tests
                           │
                           ↓
                       Evidence
                           │
                           ↓
                    Update ALM
                           │
                           ↓
                      COMPLETED
```

---

# 21. Princípios obrigatórios

1. **ALM é a fonte oficial das tarefas.**
2. **Investigação precede implementação quando a tarefa exigir investigação.**
3. **Superpowers transforma investigação em Spec executável.**
4. **Sessões são preparadas antes do dispatch.**
5. **Prompt, contexto e attachments pertencem à sessão.**
6. **Modelo é escolhido pela complexidade, não por preferência.**
7. **Opus exige aprovação explícita.**
8. **Sessões devem ser executáveis em paralelo.**
9. **Paralelismo não pode significar carregar tudo na RAM.**
10. **Streaming deve ser preferido para dados potencialmente grandes.**
11. **Chats devem utilizar lazy loading/paginação/virtualização quando necessário.**
12. **Eventos devem ser processados incrementalmente.**
13. **Attachments devem ser referenciados, não duplicados em memória.**
14. **Persistência completa não significa contexto completo.**
15. **Resource-aware scheduling e backpressure são requisitos do Runtime.**
16. **Performance deve possuir métricas e acceptance criteria.**
17. **Toda execução deve produzir evidências.**
18. **Uma tarefa só termina após validação dos acceptance criteria.**
19. **Decisões arquiteturais relevantes devem ser registradas no ALM.**
20. **Nenhuma informação relevante deve existir exclusivamente no chat entre agente e usuário.**

## Resultado esperado

Ao final, o Agentistics deverá permitir um fluxo em que o trabalho é:

**planejado no ALM → investigado → especificado com Superpowers → preparado em sessões → associado às subtasks → despachado → executado em paralelo com controle de recursos → transmitido por streams → validado → documentado no ALM.**

O sistema deve ser projetado desde o início para suportar **dezenas de sessões e agentes concorrentes sem exigir que todo o histórico de cada sessão permaneça residente na memória**.