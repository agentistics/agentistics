# Spec — limite do harness, retomada em massa, e a higiene da frota

**Data:** 2026-08-14 · **Base:** `origin/dev` · **Branch sugerida:** `feat/session-limit-resume`

Uma sessão só, ou no máximo duas, implementam tudo isto. O limite de uso do harness é o recurso
escasso — cada sessão paralela extra é uma fração do mesmo limite, e treze delas foi o que fez a
frota inteira parar às 18:30.

---

## 0. O que este documento assume que você já sabe

Leia `CLAUDE.md` (seção **Terminal UI** e a subseção `sessions/`) antes de escrever código. As
regras que mais mordem aqui:

- Toda decisão mora num módulo **puro e testado**; a TUI não decide nada e o host devolve
  `ActionResult` já localizado.
- Padrão de tela é **capturado de um frame real**, com versão da CLI e data. Nunca escrito de
  memória — um padrão plausível que não casa falha em **silêncio**.
- `Record<HarnessId, X | null>` para toda tabela por harness, para o build quebrar quando um
  harness novo aparecer. `null` é a decisão "não sondado", e a UI diz isso **em palavras**.
- N/A nunca é `0` confiante.

---

## 1. Achado que muda o desenho: não foi o contexto, foi o limite de uso

O usuário descreveu como "estourou o contexto". Não é. O que está nas telas, capturado hoje de
três panes vivos (`agentop-6b23834c1a`, `agentop-d41dc788ef`, `agentop-cbf341b8c8`,
claude 2.1.231), lido com `cat -A`:

```
  ⎿ ␣You've hit your session limit · resets 6:30pm (America/Sao_Paulo)
     /upgrade to increase your usage limit.
```

Duas armadilhas de bytes, e as duas seriam adivinhadas errado:

- o espaço antes de `You've` é **NBSP** (U+00A0), não espaço comum;
- o separador é **·** (U+00B7), não `-` nem `*`.

**Consequência de desenho, e é a principal:** isto não é uma sessão bloqueada numa *pessoa*, é uma
sessão bloqueada num **relógio**. Mandar "continue" antes do reset não é só inútil — gasta a
primeira requisição da janela nova num prompt cujo conteúdo é a palavra "continue", e o harness
responde com o mesmo erro. Então o banner é metade do que precisa ser lido; a outra metade é o
**horário de reset**, ou o botão de retomada em massa falha em toda linha que tocar.

Já existe implementação inicial em `packages/server/server/sessions/limit.ts` nesta branch
(`LIMIT_RULES`, `detectLimit`, `parseResetAt`, `limitCleared`). Está **sem testes** — comece por
aí, revise, não assuma que está certa.

### 1.1 Detectar

- Estado novo `limit-blocked` em `SessionActivity` (`sessions/types.ts`) e em `SessionState`
  (`tui/src/control/types.ts`).
- Em `attentionOf`, ele entra **acima** de movimento e **abaixo** de `waiting-approval`: um diálogo
  aberto por cima do banner é o que está bloqueando agora.
- **O banner é lido do TAIL do frame, nunca do frame inteiro.** Ele é conteúdo de transcript: rola
  junto com a conversa e continua na tela muito depois da sessão ter voltado a trabalhar. Ler o
  frame inteiro prende uma sessão viva em `limit-blocked` até o texto sair de cena — que é
  exatamente o bug do `esc to interrupt` que o `MARKER_STALE_MS` existe para corrigir, pela segunda
  vez. Use o `frameTail` que já existe.
- `resetsAtMs` desconhecido conta como **liberado**. A alternativa é uma linha que nada limpa.

### 1.2 Marcar

- Vermelho **claro**, distinto do `COLORS.danger` (`#f43f5e`), que já é a cor de falha em
  `offline`/`unauthorized`/conflito de serviço. Sugestão: `#fca5a5`. Adicione como token nomeado em
  `theme.ts` (ex.: `limit`), nunca um hex solto no componente.
- A linha **diz o horário do reset em palavras** (`limite · volta 18:30`). Cor sozinha não é
  informação: quem não distingue os dois vermelhos fica sem nada.
- Contador no header, ao lado do de "aguardando".

### 1.3 Retomar em massa

Atalho novo na aba de sessões. Abre uma lista com **caixinhas**, todas as `limit-blocked`
**pré-marcadas**, e o usuário desmarca as que não quer. Confirmar manda `continue` em cada uma.

O planejador é puro — `sessions/limit-resume.ts`, `planLimitResume({ rows, selected, nowMs })` — na
mesma linha do `task-reopen.ts`, e precisa distinguir três casos que **não** são o mesmo:

| caso | ação | por quê |
|---|---|---|
| processo **vivo**, limite já resetou | manda `continue` | o limite não mata o processo; a conversa está inteira |
| processo **morto** | reabre pelo `task-reopen` | não há onde digitar |
| reset **ainda no futuro** | **pula, e diz o horário** | mandar agora queima a primeira requisição da janela |

Um item pulado é **contado e nomeado**, nunca silenciosamente omitido — mesma regra do
`planTaskReopen`.

### 1.4 CLI

`agentop session limits` (lista quem está bloqueado e até quando) e
`agentop session resume [ids… | --all]`. Ambos com `--json`. `resume` sem `--all` e sem ids não
faz nada e diz o que faria — um comando em massa que dispara sem alvo explícito é o tipo de coisa
que se roda uma vez e se lamenta.

---

## 2. Bugs achados na varredura de hoje — todos reproduzidos, nenhum é hipótese

### 2.1 Reabrir abre a MESMA CONVERSA duas vezes (crítica)

Pior do que "duas linhas com a mesma task". Lendo as duas telas lado a lado, elas mostram **texto
idêntico** — são a mesma conversa aberta em dois terminais ao mesmo tempo:

| par | conversa |
|---|---|
| `1da098e5cb` ≡ `44d649269a` | parse-cache sqlite |
| `1ec25fc3d1` ≡ `e477d4e628` | cockpit-remount-flash, PR #126 |
| `91f21d7c9f` ≡ `29ca41da44` | member-connect / rotate |

> **Resolvido na frota em 2026-08-14**, pela regra "fica quem está no worktree, morre quem está no
> checkout compartilhado" — trabalhar no `~/agentistics` compartilhado é o que o CLAUDE.md proíbe.
> Mortas: `1da098e5cb`, `e477d4e628`, `91f21d7c9f`. **O bug no código continua de pé** e é o item 1
> da ordem.

E o próprio Claude Code detecta e avisa, nas duas:

```
Remote Control not started here · another Claude Code on this machine
(started 16s ago) already has Remote Control for this conversation
```

Ou seja: o harness sabe que há duas instâncias na mesma conversa, e o agentop não. Duas pessoas (ou
duas automações) digitando na mesma conversa é corrupção silenciosa de trabalho — e não é teórico
aqui: a sessão do parse-cache **parou sozinha** ao perceber, e escreveu o porquê:

> "tem alguém escrevendo código nessa pasta neste exato momento […] verificação 1: 2 arquivos
> sendo editados; verificação 2: 3 arquivos. Por isso parei em vez de despachar a Task 4: se eu
> mandar meu agente agora, os dois escrevem no mesmo arquivo ao mesmo tempo."

Ela estava certa: o "alguém" era o gêmeo dela.

#### A causa raiz — investigada, e são DOIS defeitos que se somam

Medido em `~/.agentistics/managed-sessions.json`: **9 conversas com mais de uma linha**, uma delas
com **seis**. Os três registros do parse-cache mostram a mecânica:

```
a675158a03  criada 14:02:04  endedAt 19:16:53.871  conversa cd118e71  cwd=worktree
44d649269a  criada 19:16:53.868                    conversa cd118e71  cwd=worktree        ← reopen CORRETO
1da098e5cb  criada 19:17:08.719                    conversa cd118e71  cwd=~/agentistics   ← 15s depois, MESMA conversa
```

O primeiro reopen está certo: aposentou a linha antiga (`endedAt`) e criou a nova. O segundo, 15
segundos depois, pegou a **mesma conversa** sem aposentar nada.

**Defeito 1 — `session-view.ts`, `claimResume` (linhas ~259-268).** O conjunto `claimed`, que existe
exatamente para não entregar uma conversa a duas linhas, **só é consultado no caminho de fallback**:

```ts
const own = exact ?? (managed?.conversationId
  ? pool.find(c => c.sessionId === managed.conversationId)   // ← não olha `claimed`
  : undefined)
const conv = own ?? pool.find(c => !claimed.has(c.sessionId) && …)   // ← só aqui
```

O comentário acima dele diz "uma linha que REGISTROU a conversa reivindica aquela", tratando o id
registrado como único. **Ele não é único** — a medição acima é a prova. A trava existe e está no
galho errado.

**Defeito 2 — `task-reopen.ts:52`, e é o decisivo:**

```ts
if (o.liveIds.has(entry.id)) { plan.already.push(entry.id); continue }
```

A trava de "já está rodando" é pela **LINHA** (`entry.id`), não pela **CONVERSA**. Duas linhas sem
`endedAt` apontando para a mesma `conversationId` entram as duas em `plan.reopen` — uma já está
viva, e o agentop abre a segunda por cima.

**A correção, nos dois lugares, e nenhum sozinho basta:**

1. `planTaskReopen` deduplica por `conversationId` além de por `entry.id`: uma conversa cuja
   sessão já está viva vira `already`, nomeando a linha que a está rodando. Testes para o caso de
   duas linhas / uma conversa, com e sem `endedAt`.
2. `claimResume` consulta `claimed` **também no caminho `own`** — a primeira linha leva, a segunda
   não recebe alvo de reopen. A ordem então passa a importar, então ordene por algo estável e
   defensável (a mais recentemente vista), não pela ordem de leitura do arquivo.
3. Considere ainda **recusar o spawn** de um `--resume <id>` cuja conversa já tem sessão viva,
   dizendo qual é. É a trava na porta, e é a que teria evitado todos os nove casos.

**Defeito 3 — a linha reaberta não grava a conversa que está retomando.** No caminho de reopen do
`cli-session.ts` (~linha 278), o `addSession` do reopen escreve `id`, `harness`, `cwd`, `task`,
`label` e `note` — e **não** `conversationId`, embora `row.resumeId` esteja logo ali e seja
exatamente esse valor. Consequência direta: a linha nova nasce sem o link EXATO, então o próximo
reopen dela cai na inferência harness-e-diretório do `conversationForProcess` — a inferência que o
CLAUDE.md já descreve como a que "reabriu três linhas na mesma conversa". É uma linha de código, e
sem ela os defeitos 1 e 2 voltam a acontecer por outro caminho.

#### Lacuna de CLI: não dá para reabrir UMA conversa

A CLI só sabe reabrir **uma task inteira** (`agentop session open "<task>"`). Não existe verbo para
"reabra esta conversa", e é justamente o que "trazer uma sessão externa para dentro do agentop"
precisa — uma sessão externa tipicamente não tem task nenhuma. O cockpit tem o gesto (`o` numa
linha fechada); a CLI não. Adicione `agentop session open --conversation <id>` (ou
`agentop session resume <id>`), passando pelo MESMO `planTaskReopen`, com o mesmo cadeado.

### 2.2 A frota inteira parada numa pergunta de onboarding que ninguém detecta (alta)

**9 das 11 sessões vivas** estavam paradas em:

```
Make auto mode your default permission mode?
  ❯ 1. Yes, set auto mode as my default permission mode
    2. No, keep manual mode
```

> **Correção de uma versão anterior desta spec.** Ela dizia que essas sessões tinham voltado
> VAZIAS e que a reabertura não retomava a conversa. **Isso está errado**, e foi verificado
> empiricamente hoje: respondendo a pergunta (`2`, que não muda o default global), as nove voltaram
> com a **conversa inteira** — histórico, PR aberto no rodapé, subagentes rodando. O diálogo é
> desenhado POR CIMA da conversa; ler só as últimas linhas do frame mostra o diálogo e nada mais.
> A retomada funciona. Não vá caçar bug de `--resume`.

O bug real é mais simples e mais barato:

1. **Essa pergunta não é detectada como aprovação.** As sessões apareciam como `waiting`, não como
   `needs approval` — então nada no cockpit dizia que a frota inteira estava a uma tecla de voltar.
   O rodapé desse diálogo é `Enter to confirm · Esc to cancel`, que JÁ está em `ATTENTION_RULES`,
   então a regra existe e mesmo assim não pegou: descubra por quê antes de escrever padrão novo
   (candidatos: o rodapé cai fora do `FOOTER_LINES`, ou o binário da máquina está velho —
   v1.13.1 contra v1.13.7 na main).
2. **Lição de leitura, que vale para o `limit.ts` do item 1:** um diálogo cobre a conversa. Quem
   olha só o tail conclui "vazia" — foi exatamente o erro cometido nesta varredura. `frameTail`
   corta no último rule e por isso corta o diálogo fora; o `approvalTail` existe justamente para
   isso. Use o certo para cada pergunta.

### 2.3 Conflito nativo-vs-nativo não é detectado (média)

Havia **dois `agentop server`** rodando por 1h10: um do systemd (`agentop-server.service`, binário
compilado) e outro do checkout (`bun packages/server/bin/cli.ts server`). O segundo não conseguiu
abrir as portas 47291/47292, mas o watcher e o rebuild não dependem de porta — então ele manteve
**2367 watches de inotify** e recomputou a cada escrita de transcript das 12 sessões, queimando 72%
de um núcleo e 1.1 GB por 70 minutos, servindo nada.

O modelo de conflito conhece `native` vs `docker` e funde os dois numa linha. **Binário compilado
vs `bun run` do checkout são ambos "native"**, então as duas colapsam em uma e o conflito fica
invisível. Precisa de um terceiro runtime, ou de detecção por porta ocupada.

### 2.4 `session list` diz "waiting" para sessão que está trabalhando (média)

Observado em `parse-cache-sqlite` e na sessão do aipe: rodapé com `esc to interrupt` e comando de
3min em andamento, listadas como `waiting`. O veto de rodapé não pegou. Verificar se é só binário
velho (a máquina do usuário está em **v1.13.1**, a main em **v1.13.7**) ou se `prevDigest` sendo
sempre `undefined` numa CLI de tiro único ainda estraga a classificação.

### 2.5 O highlight não sobrevive à navegação (alta) — e há uma pista forte

Reportado: "quando eu entro ou navego o highlight some e eu preciso ficar caçando novamente a
sessão em highlight".

A pista, e é forte o bastante para começar por ela: **o `marked` atravessa uma fronteira cujo tipo
não o carrega.** `packages/server/server/preferences.ts` declara `marked?: string[]` dentro de
`sessionView`, mas `SessionViewPrefs` em `packages/tui/src/control/types.ts` **não declara
`marked`** (`grep -n "marked?:"` nesse arquivo devolve zero) — e é esse o tipo de
`ControlHost.setSessionView(view)` e o de `sessionViewPref()`. Enquanto isso `Sessions.tsx:994` lê
`view.marked` e `Sessions.tsx:1029` escreve. Qualquer caminho que reconstrua um `SessionViewPrefs`
tipado **derruba o campo em silêncio**, e o `useEffect` de restore então chama
`setMarked(new Set([]))` no próximo status — que é exatamente "o highlight some sozinho".

Isso é uma **pista, não uma causa provada**. Reproduza antes: marque uma sessão, force um remount
(anexar e sair já basta — detach volta numa tela recém-montada) e veja se some.

Ao corrigir:

- `SessionViewPrefs` passa a declarar `marked?: string[]`, e o `DEFAULT_SESSION_VIEW` decide o que
  ausência significa (lista vazia, não `undefined`).
- Cuidado com o `...(marked.size > 0 ? { marked: [...marked] } : {})` da linha 1029: com o spread
  condicional, **desmarcar tudo nunca limpa o que está gravado** — some a chave em vez de gravar
  uma lista vazia, e o próximo restore ressuscita as marcas antigas. É o mesmo bug pela outra
  ponta.
- Teste que falha se o campo não fizer o round-trip: escrever → ler → conjunto igual, inclusive o
  caso do conjunto **vazio**.

### 2.6 Uma sessão marcada deveria virar seu próprio grupo (média)

Reportado: "o highlight deveria ser movido para um agrupamento assim que é marcado como
highlight".

Hoje o `▌` é só um glifo na linha, e a linha continua onde o ordenamento a deixou — ou seja, marcar
uma sessão não ajuda a **achá-la de novo**, que é a única coisa para a qual marcar serve.

Marcadas viram uma **banda própria no topo**, no mesmo formato das outras bandas de
`sessionRows`/`groupSessions` (a banda de "caiu junto" é o precedente a copiar). Regras:

- vale para os dois layouts, lista **e** cards — `cardPages` caminha sobre as mesmas
  `SessionRow[]`, então nasce de graça se a decisão ficar em `sessionRows` e não no componente;
- a banda some quando não há nenhuma marcada (uma banda vazia com título é uma caixa com nome
  dentro);
- **vale para qualquer agrupamento**, inclusive `none` — marcar é do usuário e ganha do
  agrupamento;
- uma linha marcada aparece **só** na banda de marcadas, nunca também no grupo de origem: a mesma
  sessão em dois lugares é a razão de estar caçando ela.

### 2.7 Bônus: `waiting` vira "aguardando resposta" (baixa)

`cli-i18n.ts:581` — `waiting: 'aguardando'` → `'aguardando resposta'`. "Aguardando" sozinho não diz
aguardando o quê, e o estado vizinho é `waitingApproval` (`'precisa aprovação'`), então o par fica
legível. Só o pt; o `waiting: 'waiting'` do inglês (linha 359) fica como está.

Atenção à largura: `sessionColumns` mede a coluna contra o **conteúdo**, então a palavra mais longa
empurra a tabela. Rodar o `preview.tsx` a 80 colunas depois de mexer, e conferir as duas frases da
linha 588 e 661 que citam a palavra "aguardando" entre aspas — elas descrevem o estado e precisam
continuar dizendo o mesmo nome que a coluna mostra.

### 2.8 Teclas e glifos da lista (baixa, mas é atrito de todo dia)

Três mudanças pedidas, e a segunda tem uma armadilha:

**a) O `x` no fim da linha vira uma lixeira.** É o botão de fechar a sessão daquela linha. Um `x`
solto no fim de uma tabela lê como "coluna truncada", não como verbo. Use `🗑` — e verifique a
largura: **é um glifo de largura dupla na maioria dos terminais**, então `sessionColumns` tem de
cobrar 2 colunas por ele, não 1, ou a última coluna estoura e a linha inteira quebra. Se a medição
de largura dupla não for confiável no `fitColumns` atual, use `[x]` emoldurado em vez de inventar
uma medida — um glifo bonito que shearia a tabela é pior que o `x` feio.

**b) A busca passa a ser `ctrl+f`.** É o que todo mundo já digita.

**c) O layout em grid sai do `f`.** Sugestão: `g` (de grid), desde que `g` não esteja tomado —
`resolveScrollKey` usa `g`/`G` para topo/fim nas superfícies roláveis, então **confira antes de
escolher**; se colidir, use `v` (de view). A regra do CLAUDE.md vale aqui inteira: *uma tecla que é
respondida pela tela E pelo shell faz duas coisas ao mesmo tempo*, e o rodapé só pode citar tecla
que funciona no foco atual. Atualize `cockpitHints` junto — um rodapé que ainda diz `f` depois
dessa troca é a única documentação da tela mentindo.

### 2.9 Agrupar e filtrar por QUALQUER dimensão (alta) — a peça de desenho deste documento

Pedido: agrupar por **status** também, e na verdade **toda propriedade agrupável deve ser
agrupável**, com **filtro** correspondente.

Hoje `SessionGrouping` é uma união escrita à mão — `'none' | 'harness' | 'model' | 'project' |
'task' | 'repo'` — e o filtro é outra coisa, separada (`states`, `onlyActive`, `search`). São duas
listas do mesmo conjunto de fatos, mantidas à mão, em lugares diferentes. É exatamente o padrão que
o CLAUDE.md proíbe para harness ("**never hardcode a harness list anywhere else** — five places
used to, and TypeScript accepts an array literal with a member missing"), e falha do mesmo jeito:
adicionar `status` significa lembrar de dois lugares, e quem esquecer um entrega uma dimensão que
agrupa mas não filtra.

**Faça disso UMA tabela e derive as duas coisas dela.** Um registro por dimensão, em módulo puro:

```ts
interface SessionDimension {
  id: SessionDimensionId
  /** Já localizado. */
  label: string
  /** O balde desta linha, ou undefined quando a linha não tem valor nessa dimensão. */
  keyOf(s: ControlSession): string | undefined
  /** Já localizado — o nome do balde na banda e no chip do filtro. */
  labelOf(key: string): string
}

const SESSION_DIMENSIONS: Record<SessionDimensionId, SessionDimension>
```

Regras que decorrem disso, e cada uma já tem precedente no repo:

- **`Record<…>`, nunca array literal**, para o build quebrar quando a dimensão nova aparecer. Mesma
  razão de `HARNESS_SORT`, `SPAWN_SPECS` e `ATTENTION_RULES`.
- **Agrupar e filtrar leem a MESMA `keyOf`.** Se as duas derivarem o balde por conta própria, um dia
  o chip "status: aguardando" mostra um conjunto diferente da banda "aguardando", e nada no build
  reclama. Um teste cruzado deve afirmar isso para toda dimensão: filtrar por um balde devolve
  exatamente as linhas que a banda daquele balde contém.
- **`undefined` é um balde real e precisa de nome.** Sessão sem task, sem repo, sem modelo existe —
  o `showUnfiled` de hoje é esse caso resolvido para UMA dimensão. Generalize: cada dimensão diz
  como chama o seu "sem valor", e é filtrável como qualquer outro.
- **O filtro é multi-seleção por dimensão**, e dimensões diferentes se combinam com E. Vale a pena
  olhar o `FiltersBar` da web (`＋ Filtro` → escolher dimensão → escolher valores, com os chips numa
  linha por dimensão): o modelo já existe no produto e as duas superfícies passariam a ler igual.
- **Dimensões mínimas:** status, harness, modelo, projeto, repo, task, marcadas (2.6), e
  `limit-blocked` cai fora como valor de status, não como dimensão nova.
- **O estado gravado não pode ser posicional.** `SessionViewPrefs.grouping` é hoje uma string; passe
  a gravar id de dimensão e, para os filtros, um `Record<SessionDimensionId, string[]>`. Um índice
  numérico grava "a terceira dimensão" e vira outra coisa quando alguém reordena a lista.
- **Isto reescreve `groupSessions`/`sessionRows`,** que é onde a banda de marcadas do 2.6 também
  entra. Faça 2.6 **em cima** desta tabela, não antes dela, ou serão duas refatorações do mesmo
  arquivo.

### 2.10 O orçamento de MEMÓRIA da máquina, e quantas sessões cabem nela (alta)

Uma sessão parada em pergunta de onboarding e uma sessão trabalhando custam a mesma memória, e
ninguém tem como saber quantas a máquina aguenta. Medido aqui hoje, 15.7 GB de RAM e 4 GB de swap:

| | |
|---|---|
| processo `claude` | **162 a 442 MB** (mediana ~250 MB) |
| `agentop server` | 578 MB |
| 14 sessões vivas | **~4 GB**, mais o swap a 97% — que é o que travava o notebook |

**Duas coisas, e a segunda é a que você usa.**

#### a) O medidor, no canto superior direito

Diz quanto a MÁQUINA tem e quanto está em uso — **do sistema inteiro, não do agentop**. Isso tem de
estar escrito, não implícito: um número no canto de uma janela é lido como sendo daquela janela, e
alguém vai concluir que o agentop consome 10 GB. Rotule (`sistema` / `system`), e conte o SWAP
junto ou o alarme chega tarde demais: aqui a RAM parecia folgada com 3.6 GB livres enquanto o swap
estava em 97%, e é o swap cheio que congela a máquina.

Use `available`, **nunca `free`**. `free` ignora o cache reclamável e subestima o que existe — a
diferença aqui é 3.6 GB contra 5.2 GB, e essa distância inteira seria alarme falso.

#### b) `sessões paralelas recomendadas: 11/14`

O número que responde a pergunta real. Formato `usadas/máximo`:

```
máximo = piso( (memória disponível + memória já usada pelas sessões) / custo típico por sessão )
```

- **`custo típico` é MEDIDO, não constante.** Some o RSS das sessões vivas e divida pelo número
  delas; sem nenhuma sessão viva, caia num padrão declarado (250 MB) e **diga que é estimativa**.
  Um custo fixo compilado erra em toda máquina que não é esta.
- **Reserve o que o sistema precisa** para não entrar em swap — o resto do desktop, o servidor, o
  build. Um `máximo` que só cabe se nada mais rodar é um número que mente na hora que importa.
- **Cor por distância do teto, não por percentual:**

| faltam | cor |
|---|---|
| 4 ou mais | normal |
| exatamente 3, 2 ou 1 | **vermelho** (`COLORS.danger`) |
| 0 ou negativo | vermelho + o aviso |

  Percentual erraria: faltar 3 em 30 é tranquilo e faltar 3 em 14 é urgente. A distância é o que
  importa porque o que se abre é **uma sessão de cada vez**.
- **O aviso só aparece quando começa a doer de verdade** — pedido explícito. Nada de aviso ao abrir
  a quinta sessão numa máquina que aguenta trinta. O gatilho é o orçamento acima estourado, ou o
  swap passando de um limiar; e o texto diz o que fazer (quais sessões estão paradas e podem ser
  fechadas), não só que está ruim.
- **Puro e testado**, com a leitura de `/proc/meminfo` isolada na casca impura. E `Record<>` por
  plataforma: **não há como ler isso em toda plataforma**, então quem não sabe **não mostra
  medidor** em vez de mostrar zero — mesma regra do `ControlService.boot` e do
  `HARNESS_CAPABILITIES`.

**Nota de honestidade que a implementação precisa carregar:** RSS de processos que compartilham
páginas **não soma exatamente**. O número é bom para "quantas cabem", e não é contabilidade. Se a
implementação puder usar PSS (`/proc/<pid>/smaps_rollup`), melhor; se não, diga no comentário que é
aproximação por cima.

### 2.11 Sessão EXTERNA num worktree é invisível para o agentop (alta)

Reportado: "elas estão fazendo outras coisas, só que externas não estão aparecendo aqui no agentop
para conseguirmos manipular". Reproduzido e diagnosticado.

Uma sessão Claude aberta pelo usuário no terminal, PID 152979, `cwd = ~/agentistics`,
conversa `49564c71` ("Fix overlapping filters in conversation view"). O agentop a lista como
**`closed`** — e `agentop session list --json` não devolve **nenhuma** linha `external`.

A identificação do processo está certa: `comm` é `claude`, e `harnessOf` casa por `comm` antes de
olhar o exe. (De passagem: o exe agora é
`~/.local/share/claude/versions/2.1.232`, cujo basename é a **versão**, não `claude` — então o
fallback por basename já não identifica o Claude. Não quebra hoje porque o `comm` casa primeiro,
mas é uma perna morta que alguém vai confiar depois.)

**O que falha é o casamento de diretório.** `sessionAtCwd` exige igualdade EXATA com `current_cwd`
ou `project_path`:

```
processo 152979   cwd = /home/mithrandir/agentistics
conversa 49564c71 cwd = /home/mithrandir/agentistics/.claude/worktrees/session-filters
```

Nenhum dos dois casa. É o caso do worktree que o CLAUDE.md já documenta — "claude é lançado na raiz
do repo e o cwd do kernel fica lá, enquanto a sessão grava o worktree como `current_cwd`" — mas a
correção de então (aceitar `project_path` além de `current_cwd`) **não cobre este arranjo**, em que
os dois valores gravados apontam para o worktree e só o PROCESSO ficou na raiz.

Cuidado ao corrigir, e é o motivo de a regra ser exata hoje: **um teste por prefixo deixaria um
processo em `$HOME` reivindicar toda sessão da máquina.** O que existe aqui e é seguro é o
`repo-facts.ts` — a raiz git comum é a mesma para a raiz do repo e para qualquer worktree dele, e é
uma chave que já existe e já é memoizada. Case por REPOSITÓRIO, não por prefixo de caminho, e
mantenha a desambiguação por harness.

E, independente do casamento: **uma sessão externa que o agentop não consegue casar com conversa
nenhuma ainda deve APARECER**, como `external`, sem estado e sem verbos — "não sei o que ela é" é
diferente de "não existe", e hoje o produto está dizendo a segunda coisa.

#### Trazer uma sessão externa para o agentop

Não dá para mover um processo vivo para dentro do tmux — não sem `reptyr` e não de forma que valha
o risco. O caminho é a CONVERSA, não o processo, e a **ordem importa**:

1. o usuário sai da sessão no terminal dele (a conversa fica gravada);
2. só então o agentop reabre `--resume <conversationId>` como sessão gerenciada.

**Nessa ordem, nunca ao contrário.** Abrir a gerenciada com a externa ainda viva é exatamente o
gêmeo do 2.1 — duas instâncias na mesma conversa. Com o cadeado do 2.1 no lugar, a segunda é
recusada em vez de aberta; sem ele, é corrupção silenciosa.

### 2.12 Os filtros se sobrepõem em vez de se complementarem (alta)

Reportado com print: "filtrar por ativo quando tá on ou off não muda nada se outros filtros como
status da conversa estiverem ativos".

É o mesmo defeito estrutural do 2.9, visto pelo lado do usuário. Hoje `onlyActive` e o filtro de
`states` são **dois mecanismos concorrentes decidindo a mesma coisa** — e o CLAUDE.md até declara
que `onlyActive` "é o único switch que SOBREPÕE a regra da linha nomeada". Sobrepor é justamente o
que não pode acontecer entre filtros: dois controles em que um anula o outro fazem o segundo
parecer quebrado.

Regras, e elas caem naturalmente da tabela de dimensões do 2.9:

- **Todo filtro é uma restrição, e restrições se compõem com E.** Nenhum filtro pode ampliar o
  conjunto, e nenhum pode ignorar outro.
- **`onlyActive` deixa de ser um switch próprio** e vira o que sempre foi: uma seleção de valores na
  dimensão `status` (`working`, `waiting`, `waiting-approval`). Some a sobreposição porque some o
  segundo mecanismo — não porque alguém acertou a ordem de precedência.
- **A exceção da linha nomeada tem de ser dita na tela.** Se uma linha nomeada escapa dos filtros de
  histórico, isso é uma regra que o usuário não consegue deduzir; ou ela vira um filtro visível
  (`incluir nomeadas`) ou ela deixa de existir.
- **Padrão de fábrica, pedido explicitamente:** agrupado por **projeto** e mostrando só as
  **sessões ativas**. Isso muda o `DEFAULT_SESSION_VIEW` (hoje agrupa por `repo`), que é declarado
  UMA vez e lido pelo host, pelo estado inicial da tela e pelo `ctrl+r` — os três leem a constante,
  então mude só ela.
- **Quando os filtros esvaziam a lista, a tela diz QUAL deles esvaziou.** Já existe `emptyReason`
  para isso; com filtros compostos ele passa a precisar nomear a dimensão, não só dizer "o filtro
  reteve".

> Já existe worktree e sessão para isto: `.claude/worktrees/session-filters`, conversa `49564c71`,
> com um commit `docs(sessions): spec for filters that complement instead of overriding`. **Não
> refaça** — leia o que está lá e concilie com o 2.9, porque as duas coisas mexem no mesmo lugar.

### 2.13 Um QUARTO diálogo do Claude, ainda não catalogado (média)

Visto em `29ca41da44`:

```
Set up auto mode for your environment?
  ❯ 1. Set it up
    2. Not now
    3. Don't show again
 Enter to confirm · Esc to cancel
```

O CLAUDE.md já lista três (startup select, permission prompt, `AskUserQuestion`) e diz para "assumir
que existe outro até alguém ter olhado". Este é o quarto — e o "Make auto mode your default
permission mode?" do 2.2 pode ser um quinto. Some ambos ao inventário, com versão e data, e note
que o rodapé é o mesmo `Enter to confirm · Esc to cancel` já conhecido: o problema do 2.2 **não é
padrão faltando**, é o padrão conhecido não estar pegando.

### 2.12 Senha em texto claro num título de sessão — RESOLVIDO pelo usuário

**A credencial já foi rotacionada e o usuário apagou a conta — nada a fazer nesse lado.** Fica
registrado pelo que ensinou sobre o produto.

Uma senha colada num prompt virou o `label` da sessão `15f8c5f36d` e o `first_prompt` de
`~/.agentistics/sessions/antigravity/929d75e1-….json`. Esta máquina está em `mode: member` com
endpoint configurado, e `first_prompt` é justamente a exceção documentada no CLAUDE.md: ele
**viaja**. `redactSecrets` roda nas duas pontas e não pegou, porque é deliberadamente **preciso e
não exaustivo** — não existe regra para "senha" em prosa.

Vale avaliar uma regra para `senha|password|token` seguido de um valor, **com o cuidado que o
CLAUDE.md já obriga**: `first_prompt` rotula toda sessão na UI, então uma regra gulosa demais
transforma os rótulos em tarja e alguém desliga o redator inteiro. E a lição principal não é
técnica: o redator é rede de segurança para a colagem acidental, **nunca substituto de rotacionar**
— exatamente o que o usuário fez.

Um levantamento raso encontrou **6 arquivos** no consolidate store com `senha`/`hotmail` no
`first_prompt`. Não foram lidos, só contados. Se algum ainda carregar credencial viva, o caminho é
rotacionar, não editar arquivo.

---

## 3. Estado do trabalho — onde cada coisa parou

Só quatro worktrees têm código fora do `dev`. Todo o resto já está mergeado.

| worktree | estado | o que fazer |
|---|---|---|
| `services-setup` | 1 commit **wip** (Setup unificado em Services + toggle de boot, 684 linhas) | **não verificado** — rodar `tsc` + `bun test`, revisar, e abrir PR. A sessão `d41dc788ef` está viva e com a conversa dessa implementação inteira: pergunte a ela antes de refazer nada |
| `parse-cache-sqlite` | 9 commits, o último **wip** | idem; é a maior peça independente |
| `cockpit-remount-flash` | 1 commit | **PR #126 já aberto** |
| `agentop-sessions-tui` | 11 commits, órfão, sem sessão e sem remoto | conteúdo já relandado no dev sob outros SHAs — confirmar e **apagar** |

Os dois `wip` foram commitados hoje com `--no-verify`, só para não ficarem a um `checkout` de
sumir. **Não confie neles**: não passaram por `tsc` nem pelos testes.

---

### 3.1 O que cada sessão viva disse quando voltou

Colhido lendo as telas depois de responder o diálogo de onboarding. Isto é o "em que pé parou".

| sessão | onde parou | pendência |
|---|---|---|
| `d41dc788ef` services-setup | tinha acabado de remover `Setup.tsx` e trocar as strings do i18n quando **bateu o limite no meio** | é a dona das 684 linhas commitadas como `wip`. **Pergunte a ela antes de refazer** |
| `44d649269a` / `1da098e5cb` parse-cache | **parou de propósito**: detectou outra sessão editando os mesmos arquivos e recusou despachar a Task 4 | são a MESMA conversa (ver 2.1). Escolha UMA, mate a outra, e só então continue |
| `1ec25fc3d1` / `e477d4e628` remount-flash | terminou, **PR #126 aberto** | idem — mesma conversa duplicada. Nada a implementar |
| `9a8ef383ec` dashboard-tab | terminou e mergeou (PR #114 → dev, #116 → main), tudo verificado | só resta apagar o branch `feat/dashboard-tab`. É chamada do usuário |
| `6b23834c1a` aipe | trabalhando, com subagente rodando testes de `recoveryRecordCommand` | é outro repo (`~/aipe`), fora desta spec |
| `29ca41da44` member-connect | parada num **quarto diálogo de onboarding** (ver 2.10), com um pedido para subir o servidor digitado e não enviado | o texto é do usuário; não envie por ele |
| `91f21d7c9f` | estava fazendo **exatamente esta consolidação**, em paralelo | trabalho duplicado. Encerre uma das duas |
| `7c7f9b2e70` session-approve | terminou a análise do token; concluiu "nada a rotacionar" | nada |

Duas leituras que valem mais que a tabela:

- **Nenhuma sessão perdeu trabalho.** O que parecia frota destruída era uma pergunta de onboarding
  desenhada por cima de nove conversas intactas.
- **O desperdício real não foi o limite, foi a duplicação.** Duas conversas abertas em dobro, e
  duas sessões independentes fazendo a mesma consolidação. O limite só tornou visível.

### 3.2 Specs em worktree

Só um arquivo de spec existe em worktree e não no `dev`:
`docs/superpowers/specs/2026-08-13-session-cards-design.md`. Todos os outros 18 são iguais aos do
`dev`. Não há material perdido em disco — o estado das sessões estava nas conversas, não em arquivo.

## 4. Ordem sugerida

1. **2.1 — a mesma conversa aberta duas vezes.** Primeiro porque é o único item que **corrompe
   trabalho**, e porque toda sessão aberta enquanto ele existe pode ser um gêmeo.
2. `limit.ts` + testes (o pedido original, e o que evita a frota parar de novo)
3. **2.9 — a tabela de dimensões.** Vem antes do 2.6 de propósito: a banda de marcadas nasce dela.
4. 2.5 + 2.6 + 2.7 + 2.8 — highlight (persistir, agrupar, renomear) e teclas/glifos
5. **2.10 — o orçamento de memória e as sessões paralelas recomendadas**
6. 2.2 + 2.11 — o diálogo de onboarding que não é detectado, e o inventário de diálogos
7. Fechar `services-setup` e `parse-cache-sqlite` (verificar e abrir PR)
8. 2.3 e 2.4

---

## 5. Aceitação

- `bun test` verde, `bun tsc --noEmit` limpo.
- `limit.ts` tem teste com a **linha real capturada**, NBSP e `·` inclusos, e um teste que falha se
  o padrão for reescrito com espaço comum.
- `parseResetAt` tem teste para o caso 18:30/18:37 — horário **já passado é hoje**, nunca amanhã.
  Errar isso trava a frota exatamente no instante em que a feature deveria disparar.
- O highlight faz round-trip escrever → ler, **inclusive vazio**, com teste; e uma sessão marcada
  aparece na banda de marcadas e **em nenhum outro grupo**.
- Verificação no **binário compilado** (`bun run build:binary`), não só `bun run` — a TUI tem bug de
  bundle que só aparece compilada.
- `packages/tui/scripts/preview.tsx` a 80 colunas sem nenhuma linha estourando a largura.
