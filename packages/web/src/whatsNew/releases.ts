/**
 * releases.ts — the curated "what's new" copy, one entry per release worth telling a person about.
 *
 * Source of truth for the modal opened from the "Updated to vX" notification. It is hand-written on
 * purpose: only changes a person can notice belong here (no refactors, tests or internal plumbing),
 * 3–8 short plain-language lines per group, in both languages. A version with no entry announces
 * nothing. EVERY RELEASE ADDS ITS ENTRY IN THE SAME COMMIT (CLAUDE.md release checklist).
 */
export interface Line { pt: string; en: string }
export interface ReleaseNotes { features: Line[]; fixes: Line[] }

export const RELEASES: Record<string, ReleaseNotes> = {
  '2.202.0': {
    features: [
      {
        pt: 'A fila agora sai por prioridade e sozinha: quando uma sessão termina e há vaga, o sistema pega o próximo da fila (maior prioridade primeiro) e pergunta ao líder da tarefa — "sim", "não" com motivo, ou "agendar" para uma hora. O "não" fica no cartão com o motivo e o fluxo passa ao próximo; o agendamento mostra "começa às HH:MM". Sem resposta em 10 minutos, com o modo autônomo ligado a sessão abre sozinha e isso fica registrado; com ele desligado o sistema espera e lembra o líder. Tudo vira comentário na subtarefa e os assistentes enxergam e respondem pelo MCP e pelo terminal (agentop flow fila).',
        en: 'The queue now leaves by priority and by itself: when a session ends and a slot is free, the system takes the next queued piece (highest priority first) and asks the task\'s leader — "yes", "no" with a reason, or "schedule" for a time. A "no" stays on the card with its reason and the flow moves to the next; a schedule shows "starts at HH:MM". With no answer in 10 minutes, autonomous mode on opens the session by itself and records it; off, the system keeps waiting and reminds the leader. Everything is logged as a comment on the subtask, and assistants read and answer it through MCP and the terminal (agentop flow fila).',
      },
      {
        pt: 'A página da tarefa ganhou a aba "Fila": a fila daquela tarefa na ordem de saída, com a prioridade (editável ali mesmo), o pré-dispatch completo, por que a peça espera (vaga, conta, agendamento), as últimas anotações e as ações iniciar agora, agendar, tirar da fila e editar o pré-dispatch. A prioridade também pode ser mudada direto no cartão "Na fila" da Esteira, e o status das subtarefas aparece em português.',
        en: 'The task page gets a "Queue" tab: that task\'s queue in leaving order, with the priority (editable right there), the full pre-dispatch, why the piece waits (slot, account, schedule), the latest notes and the actions start now, schedule, take off the queue and edit the pre-dispatch. The priority can also be changed straight on the Live "Queued" card, and subtask statuses read in Portuguese.',
      },
      {
        pt: 'A Esteira de entregas ao vivo ganhou uma barra de filtros clara (filtros de um lado, visão e ações do outro), “Apenas ativas” e “Exibir itens na fila”, e uma ordenação que mostra primeiro o que tem a prioridade mais alta — cada cartão traz a prioridade da tarefa. As colunas empilham os cartões na vertical, rolam sozinhas e ganham uma busca quando passam de três cartões fora da vista; “Executando” virou “Em desenvolvimento” e “Em QA” virou “QA”. O motivo de um cartão esperar vaga agora vem em palavras simples, e o seletor de tarefas ficou mais largo e sem texto por cima de texto. Os assistentes também enxergam a prioridade e os mesmos filtros pelo MCP.',
        en: 'The Live Delivery line gets a clear filter bar (filters on one side, view and actions on the other), “Only active” and “Show queued items”, and an order that lists the highest priority first — every card shows its task’s priority. Columns stack their cards vertically, scroll on their own and gain a search once more than three cards are out of view; “Running” became “In development” and “In QA” became “QA”. Why a card waits for a slot now reads in plain words, and the task picker is wider with no text on top of text. Assistants see the priority and the same filters through MCP too.',
      },
      {
        pt: 'A Esteira ganhou a coluna Histórico (sempre recolhida, abre num clique) com as publicações de mais de 24 h, e cada cartão tem links para abrir a sessão do autor, do QA e do líder.',
        en: 'The Live line gets a History column (always collapsed, one click to open) with what was published over 24 h ago, and every card links to the author, QA and leader sessions.',
      },
      {
        pt: 'Hardware, Modo autônomo, Cofre, Esteira de entregas e Ligações agora ficam num botão só no topo; ele fica laranja quando há atividade. A janela “Uso dos planos” saiu: contas e APIs estão na página Uso.',
        en: 'Hardware, Autonomous mode, Vault, Live Delivery and Calls now sit behind one button in the top bar, which turns orange when something is going on. The “Plan usage” window is gone: accounts and APIs live on the Usage page.',
      },
      {
        pt: 'Cofre sem aplicativo autenticador: nenhum QR nem código de 6 dígitos em lugar nenhum. Você confirma que é você com o que o computador já tem — Touch ID ou a senha do Mac, Windows Hello, a digital do celular — ou com uma senha própria do cofre.',
        en: 'Vault without an authenticator app: no QR and no 6-digit code anywhere. You confirm it is you with what the computer already has — Touch ID or the Mac password, Windows Hello, your phone\'s fingerprint — or with a vault password of your own.',
      },
      {
        pt: 'No Mac o cofre configura sem instalar nada: o Touch ID (ou a senha do Mac) destrava, sem exigir chave de segurança nem libfido2.',
        en: 'On a Mac the vault sets up with nothing to install: Touch ID (or the Mac password) unlocks it, with no security key or libfido2 required.',
      },
      {
        pt: 'Senha do cofre: pelo menos 9 caracteres, 1 maiúscula, 2 especiais e 1 número, com cada regra marcada enquanto você digita, um botão "Gerar senha aleatória" (mostrada uma vez, com botão de copiar) e um bloco "Como sua senha fica protegida". O servidor confere as mesmas regras e pausa depois de várias tentativas erradas.',
        en: 'Vault password: at least 9 characters, 1 uppercase, 2 special characters and 1 number, each rule ticked as you type, a "Generate a random password" button (shown once, with a copy button) and a "How your password is protected" block. The server checks the same rules and pauses after several wrong tries.',
      },
      {
        pt: 'A chave de segurança (FIDO) virou opção avançada e só aparece quando o computador tem o que ela precisa. As 24 palavras de recuperação continuam iguais.',
        en: 'The security key (FIDO) is now an advanced option, shown only when the computer has what it needs. The 24 recovery words stay the same.',
      },
      {
        pt: 'Novo agentistics_vault_status: uma sessão consegue ler como o cofre está protegido (estado, formas de confirmar em uso e disponíveis, regras da senha) sem nunca ver um segredo.',
        en: 'New agentistics_vault_status: a session can read how the vault is protected (state, ways to confirm in use and available, password rules) without ever seeing a secret.',
      },
    ],
    fixes: [
      {
        pt: 'Peças na fila não somem mais por causa do filtro de agentes: “ativo” agora quer dizer “está numa coluna do fluxo”, não “tem agente rodando”.',
        en: 'Queued pieces no longer vanish behind the agents filter: “active” now means “sits in a flow column”, not “has a running agent”.',
      },
      {
        pt: 'Os cartões da Live agora mostram a porcentagem da etapa (“passo 2 de 5: implementando”), lida de fatos reais: sessão aberta, primeira edição, testes rodando, commit no ramo, entrega da sessão e os portões da QA, revisão e merge. Sem sinal, a linha continua escondida — nada é chutado.',
        en: 'Live cards now show the stage percentage (“step 2 of 5: implementing”), read from real facts: session open, first edit, tests running, a commit on the branch, the session’s handback and the QA, review and merge gates. With no signal the line stays hidden — nothing is guessed.',
      },
      {
        pt: 'Cofres que já usavam o código do autenticador continuam abrindo: o código não é mais pedido, e o registro dele é apagado assim que você escolhe uma nova forma de confirmar.',
        en: 'Vaults that already used the authenticator code keep opening: the code is no longer asked, and its record is deleted as soon as you choose a new way to confirm.',
      },
    ],
  },
  '2.201.2': {
    features: [],
    fixes: [{
      pt: 'Sessões perdidas ou encerradas deixam de ocupar vagas para iniciar as peças da fila.',
      en: 'Lost or ended sessions no longer occupy slots needed to start queued work.',
    }, {
      pt: 'Peças em revisão ou concluídas saem da fila automaticamente; o líder também pode retirá-las com um motivo registrado.',
      en: 'Pieces under review or already finished leave the queue automatically; the leader can also withdraw them with a recorded reason.',
    }, {
      pt: 'Pedidos ao líder chegam à fila também pelo terminal e pelas passagens de sessão. Um pedido sem pré-dispatch cobra o líder após 10 minutos; peças na mesma área sugerem encaixe e grupos mantêm um único cartão.',
      en: 'Requests reach the leader’s queue from the terminal and session handoffs too. A request without pre-dispatch reminds the leader after 10 minutes; work in the same area suggests a fit and groups keep one card.',
    }, {
      pt: 'A Live agora mostra em "Publicado" as peças de uma versão que entrou como um único commit grande: o líder declara o conteúdo do release (agentop flow release) e as peças vão a Publicado quando a versão sai verde, em vez de o app adivinhar pelo git. A prova é a própria tag da versão, no repositório do release, mesmo quando o commit do merge teve uma execução vermelha corrigida depois.',
      en: 'Live now shows in "Published" the pieces of a version that landed as one big commit: the leader declares the release contents (agentop flow release) and the pieces move to Published once the version ships green, instead of the app guessing from git. The proof is the version\'s own tag, in the release\'s repository, even when the merge commit had a red run that a later commit fixed.',
    }],
  },
  '2.201.1': {
    features: [],
    fixes: [
      {
        pt: 'Um cartão bloqueado no quadro não fica mais parado sem ninguém cobrar: o fluxo de entrega cobra o líder e adia a peça depois de 2 h, como as outras.',
        en: 'A card blocked on the board no longer sits there with nobody chasing it: the delivery flow reminds the leader and defers the piece after 2 h, like the others.',
      },
    ],
  },
  '2.201.0': {
    features: [
      {
        pt: 'O agentistics agora vigia o próprio desempenho: se ficar lento por alguns minutos, guarda um retrato do que estava pesando e avisa você uma vez, dizendo o que passou do limite. Não reinicia nada.',
        en: 'agentistics now watches its own performance: if it stays slow for a few minutes, it keeps a snapshot of what was weighing it down and tells you once, naming what went over the limit. It restarts nothing.',
      },
      {
        pt: 'Live redesenhada: cartões no formato novo (título curto, quem é, estado, o que espera, assistente · modelo · esforço, barra de etapas, tempo nessa etapa e total, duas estimativas: próxima etapa e publicação); coluna Bloqueado; títulos das colunas recolhem e abrem animados (Publicado vem recolhido, com cada item numa linha que abre no lugar); sem rolagem vertical no desktop, com "+N" para o que não cabe; filtro de tarefas múltiplo com "Recentes" no topo, já filtrado pela tarefa da sessão de onde você abriu; botão "abrir janela externa"; e nada some em silêncio: quem sai do quadro deixa "saiu: motivo".',
        en: 'Live redesigned: cards in the new shape (short title, who it is, state, what it waits for, assistant · model · effort, stage bar, time in this stage and total, two estimates: next stage and publication); a Blocked column; column headers collapse and open with animation (Published starts collapsed, each item one line that opens in place); no vertical scroll on desktop, with a "+N" for what does not fit; multi-select task filter with "Recent" on top, already filtered by the task of the session you opened it from; an "open in a window" button; and nothing disappears silently: whatever leaves the board leaves a "left: reason" line.',
      },
      {
        pt: 'A faixa LÍDERES vem recolhida em uma linha de resumo; aberta, mostra uma linha por líder e, ao clicar, os workers dele.',
        en: 'The LEADERS band starts closed on one summary line; opened, it shows one row per leader and, on click, its workers.',
      },
      {
        pt: 'Fluxo de entrega obrigatório: toda subtarefa passa por Na fila → Executando → QA → (Ajustes ⇄ QA) → Revisão do líder → PR/merge → CI · publicando → Publicado, e o servidor recusa qualquer salto (por exemplo Executando → Revisão) dizendo o que falta. Cada passagem é checada por evidência — pré-dispatch completo, vaga (limites do plano, até 4 workers, memória), commit enviado, QA em outro modelo (nunca Sonnet sobre Sonnet), PR sem arquivo apagado por engano, release verde com a tag — e a Live mostra exatamente esse estado. Merge ou publicação que falha volta para a revisão do líder. Bloqueios têm motivo fechado, voltam para a etapa de origem e lembram o líder a cada 30 min; passadas 2 h a peça é adiada para o próximo lote. O merge é conferido no GitHub (PR mergeado e commit no main), quem fez o QA e o autor vêm do registro de sessões, e os portões humanos têm botões Aprovar/Reprovar no cartão da Live. Novos: agentistics_task_phase, agentistics_task_stage, agentop flow gate|phase|merge e agentop task stage.',
        en: 'Mandatory delivery flow: every subtask goes Queued → Running → QA → (Adjustments ⇄ QA) → Leader review → PR/merge → CI · publishing → Published, and the server refuses any skip (e.g. Running → Review), saying what is missing. Each step is checked from evidence — complete pre-dispatch, a slot (plan limits, at most 4 workers, memory), the commit pushed, QA by another model (never Sonnet over Sonnet), a PR deleting no file by accident, a green release with its tag — and Live shows exactly that state. A failed merge or release goes back to the leader review. Blocks have a closed reason, return to the stage they came from and remind the leader every 30 min; after 2 h the piece is deferred to the next batch. The merge is checked on GitHub (PR merged, commit on main), the QA and author come from the session registry, and human gates have Approve/Reject buttons on the Live card. New: agentistics_task_phase, agentistics_task_stage, agentop flow gate|phase|merge and agentop task stage.',
      },
      {
        pt: 'Pré-dispatch: o cartão "Na fila" mostra assistente · modelo · esforço · conta e a vaga esperada. Com o modo autônomo ligado nenhum fluxo chama nem espera o dono — passos que pediriam aprovação são pulados e registrados ("pulado: modo autônomo") e o líder decide; com ele desligado, um fluxo pode ter portões humanos (por exemplo aprovar antes do PR/merge), desligados por padrão.',
        en: 'Pre-dispatch: the "Queued" card shows assistant · model · effort · account and the expected slot. With autonomous mode on no flow calls or waits for the owner — steps that would ask for approval are skipped and recorded ("skipped: autonomous mode") and the leader decides; with it off, a flow may have human gates (e.g. approve before PR/merge), off by default.',
      },
      {
        pt: 'O raciocínio do modelo agora é uma linha como as de atividade: um cérebro que pulsa com "Raciocinando… · 12 s" enquanto ele pensa e vira "Raciocinou · 12 s" quando termina — clique para ler o texto. Vale para qualquer assistente que envia o raciocínio.',
        en: 'The model\'s reasoning is now a line like the activity ones: a pulsing brain reading "Reasoning… · 12 s" while it thinks, then "Reasoned · 12 s" when done — click to read the text. It applies to every assistant that sends its reasoning.',
      },
      {
        pt: 'OpenCode: conecte OpenCode Go, Zen ou outro provedor em Uso → Contas com o link do console e a chave colada; a chave vai para o lugar certo do OpenCode sem aparecer em nenhum registro.',
        en: 'OpenCode: connect OpenCode Go, Zen or another provider in Usage → Accounts with the console link and a pasted key; the key goes to the right place in OpenCode and appears in no log.',
      },
      {
        pt: 'OpenCode Go: o plano e o preço aparecem junto das contas, com anéis de 5 horas, semana e mês em dólares por modelo (estimado a partir do custo de cada resposta). Escolha o seu plano se ele não puder ser deduzido.',
        en: 'OpenCode Go: the plan and price show beside your accounts, with 5-hour, week and month rings in dollars per model (estimated from each response\'s cost). Pick your plan if it cannot be inferred.',
      },
      {
        pt: 'OpenCode dentro da sessão como o Claude: cada passo diz o que é (criou um arquivo, editou, executou, buscou, delegou), a lista de tarefas aparece com o progresso ("2/3 · item atual") e os itens marcados, uma edição mostra as alterações em cores, um subagente mostra a resposta — e os arquivos criados entram no painel de arquivos e no Live.',
        en: 'OpenCode inside the session like Claude: every step says what it is (created a file, edited, ran, searched, delegated), the todo list shows its progress ("2/3 · current item") and the checked items, an edit shows its changes in colour, a subagent shows its answer — and the files it creates reach the files panel and Live.',
      },
      {
        pt: 'O modo autônomo ficou simples: um interruptor e "Quando" — "Até eu desligar" ou "Agendado", com os mesmos dias, horários e "Dia inteiro" da agenda de uso por agentes. Fora dos horários as sessões voltam a perguntar; ao abrir e fechar cada janela, as sessões rodando são avisadas. Releases, workers e merges ficam liberados por padrão (até 4 workers, 1 no modelo de topo por provedor) — nada para configurar.',
        en: 'Autonomous mode is simple now: one switch and "When" — "Until I turn it off" or "Scheduled", with the same days, hours and "All day" as the agent-use schedule. Outside the hours sessions ask you again; when each window opens and closes the running sessions are told. Releases, workers and merges are allowed by default (up to 4 workers, 1 on each provider\'s top model) — nothing to configure.',
      },
    ],
    fixes: [
      {
        pt: 'Agentask abre bem mais rápido: as tarefas abertas e recentes chegam primeiro e o histórico fechado carrega por trás, sem a tela mexer.',
        en: 'Agentask opens much faster: open and recent tasks arrive first and the closed history loads behind them, without the screen moving.',
      },
      {
        pt: 'O app deixou de ficar lento: o servidor parou de refazer o tempo todo trabalho que não tinha mudado e, parado, usa uma fração do processador que usava. Navegar entre páginas e abrir listas voltou a ser rápido.',
        en: 'The app is no longer slow: the server stopped redoing, over and over, work that had not changed, and when nothing happens it uses a fraction of the processor it did. Moving between pages and opening lists is quick again.',
      },
      {
        pt: 'Digitar no campo de mensagem não trava mais enquanto as sessões trabalham: as atualizações de fundo esperam você pausar a digitação.',
        en: 'Typing in the message field no longer stalls while sessions work: background updates wait for you to pause typing.',
      },
      {
        pt: 'Live: o "total" do cartão agora é o trabalho real daquela peça (não a idade da tarefa, que chegava a mostrar 52 dias); o Publicado deixa de esvaziar com filtro de tarefa; o resumo do líder não mostra mais JSON cru; workers parados não aparecem mais como "esperando você"; todo cartão mostra assistente · modelo · esforço.',
        en: 'Live: a card\'s "total" is now that piece\'s real work (not the task\'s age, which showed up to 52 days); Published no longer empties with a task filter; the leader summary no longer shows raw JSON; idle workers no longer read "waiting for you"; every card shows assistant · model · effort.',
      },
      {
        pt: 'Mac: o cofre volta a abrir. Antes ele se recusava a abrir porque tentava usar uma função que só existe no Linux para proteger a própria memória.',
        en: 'Mac: the vault opens again. Before, it refused to open because it tried a function that only exists on Linux to protect its own memory.',
      },
      {
        pt: 'A tela do cofre trancado só cita o Windows Hello (ou a chave de segurança) onde essa confirmação existe de verdade; no Mac ela diz apenas "o código".',
        en: 'The locked-vault screen only mentions Windows Hello (or the security key) where that check really exists; on a Mac it says just "your code".',
      },
      {
        pt: 'OpenCode: o anel de contexto e o contador do líder (a coroa com os tokens) voltam a aparecer; antes sumiam quando o último turno da sessão tinha sido interrompido, e para modelos locais ou personalizados sem janela conhecida.',
        en: 'OpenCode: the context ring and the leader\'s token counter (the crown) show up again; before, they vanished when the session\'s last turn had been interrupted, and for local or custom models with no known window.',
      },
      {
        pt: 'OpenCode: a janela de contexto de um modelo local ou personalizado agora é lida do seu próprio opencode.json (limit.context), então o anel aparece também para eles.',
        en: 'OpenCode: the context window of a local or custom model is now read from your own opencode.json (limit.context), so the ring shows for them too.',
      },
      {
        pt: 'OpenCode: as linhas de ferramenta mostram o que está rodando (o comando, o arquivo, a pergunta) e quando falhou, em vez de só "execute" com um círculo girando — e um comando mostra a sua saída, recolhida em "saída", enquanto roda e depois.',
        en: 'OpenCode: tool rows show what is running (the command, the file, the question) and when it failed, instead of just "execute" with a spinner — and a command shows its output, folded under "output", while it runs and after.',
      },
      {
        pt: 'OpenCode: se um turno fica 90 s sem dar sinal, o chat avisa "Sem resposta do OpenCode há N s", diz qual foi o último passo e lembra que dá para parar. O aviso fica no lugar, mesmo quando o comando volta a dar notícia, e responder um formulário recomeça a contagem.',
        en: 'OpenCode: if a turn goes 90 s without a sign, the chat says "No answer from OpenCode for N s", names the last step and reminds you that you can stop it. The notice stays put even when the command speaks again, and answering a form restarts the count.',
      },
      {
        pt: 'Uma nota que chega no meio de um comando (o aviso de silêncio, uma permissão respondida pelo modo) não apaga mais a si mesma nem deixa um passo "Executando…" fantasma duplicado.',
        en: 'A note that arrives in the middle of a command (the silence notice, a permission the mode answered) no longer erases itself or leaves a duplicate ghost "Running…" step.',
      },
      {
        pt: 'No compositor, Cmd+Enter (ou Ctrl+Enter) sempre envia, mesmo numa janela estreita; um Enter que só confirma um acento não envia mais a palavra pela metade; e um envio recusado agora diz por quê em vez de ficar mudo.',
        en: 'In the composer, Cmd+Enter (or Ctrl+Enter) always sends, even in a narrow window; an Enter that only confirms an accent no longer sends a half-written word; and a refused send now says why instead of staying silent.',
      },
      {
        pt: 'Nova sessão do OpenCode: o seletor lista todos os modelos dos provedores conectados (Go, Zen e os seus), agrupados por provedor, e atualiza sozinho quando você conecta uma chave. Modelos que treinam com seus dados vêm marcados.',
        en: 'New OpenCode session: the picker lists every model of the connected providers (Go, Zen and yours), grouped by provider, and refreshes by itself when you connect a key. Models that train on your data are marked.',
      },
      {
        pt: 'Uma conta do Claude que perdeu o login (pasta sem credencial) agora aparece como "sem login" no popup de Uso, com o botão "Refazer login", em vez de anéis 0/0; e o roteador não a recomenda mais para novas sessões.',
        en: 'A Claude account that lost its login (folder with no credential) now shows as "signed out" in the Usage popup, with the "Sign in again" button, instead of 0/0 rings; and the router no longer recommends it for new sessions.',
      },
      {
        pt: 'Refazer login: se o login funcionou mas o app ainda não tinha visto a credencial, a tela não mostra mais "login falhou" — ela segue olhando e conclui sozinha quando a credencial aparece.',
        en: 'Signing in again: if the login worked but the app had not yet seen the credential, the dialog no longer stays on "sign-in failed" — it keeps looking and finishes by itself once the credential appears.',
      },
      {
        pt: 'Na lista de Sessões, o título de cada sessão ocupa no máximo duas linhas e termina em "…", sem quebrar no meio da palavra; o título inteiro aparece ao passar o mouse.',
        en: 'In the Sessions list, each session title takes at most two lines and ends in "…", without breaking in the middle of a word; the full title shows on hover.',
      },
      {
        pt: 'Saiu o aviso "Resumo do modo autônomo — Fiquei ausente há mais de 5 horas. Quer que a Nay prepare um resumo?".',
        en: 'Removed the "Autonomous-mode summary — I\'ve been away for more than 5 hours. Would you like Nay to prepare a summary?" notification.',
      },
      {
        pt: 'No popup de Uso do rodapé, cada anel (Sessão 5 h e Semana) mostra embaixo o horário em que zera, no seu fuso ("zera 18:40", "zera sex 09:00"); some quando o horário não é conhecido.',
        en: 'In the footer Usage popup, each ring (5 h session and week) shows when it resets, in your local time ("resets 6:40 PM", "resets Fri 9:00 AM"); it is left out when the time is unknown.',
      },
      {
        pt: 'Avisos rápidos como "<sessão> encerrada." agora aparecem embaixo da tela, ficam no máximo 2 segundos com uma barrinha que vai esvaziando, e o X ainda fecha antes (passar o mouse por cima pausa). Avisos com detalhes continuam onde estavam até você fechar.',
        en: 'Quick notices like "<session> ended." now appear at the bottom of the screen, stay at most 2 seconds with a bar that empties, and the X still closes them early (hovering pauses). Notices with details stay where they were until you close them.',
      },
      {
        pt: 'O aviso "carregando o resto das sessões / resultados parciais" saiu da página de Sessões: ele aparece só como um aviso rápido (2 s) ao entrar em Encerradas, se ainda estiver carregando. Os avisos de carregamento (projetos, sessões e importação do histórico) não aparecem mais na página de Sessões; seguem nas outras páginas, como Métricas, enquanto carregam.',
        en: 'The "loading the remaining sessions / partial results" warning is gone from the Sessions page: it shows only as a quick (2 s) notice when you enter Ended, if it is still loading. The loading notices (projects, sessions, history import) no longer show on the Sessions page; they stay on the other pages, like Metrics, while they load.',
      },
      {
        pt: 'Na aba Encerradas, os grupos Dormindo, Finalizadas hoje e Antes de hoje agora têm seta para recolher e abrir (com a contagem quando recolhidos) e lembram o estado; "Antes de hoje" começa recolhido.',
        en: 'In the Ended tab, the Sleeping, Finished today and Before today groups now have a chevron to fold and unfold (with the count while folded) and remember their state; "Before today" starts folded.',
      },
      {
        pt: 'Nos cartões de líder das Sessões, a seta de abrir a equipe fica alinhada com a coroa e a primeira linha do título, mesmo quando o título ocupa várias linhas.',
        en: 'On leader cards in Sessions, the team chevron now lines up with the crown and the first title line, even when the title wraps over several lines.',
      },
      {
        pt: 'A janela "Continuar em outra conta" ficou mais estreita e organizada: uma coluna só, botões alinhados à direita e, enquanto a troca acontece, a lista de contas continua visível com um indicador de progresso.',
        en: 'The "Continue on another account" dialog is narrower and tidier: a single column, buttons aligned to the right and, while the switch runs, the account list stays visible with a progress indicator.',
      },
      {
        pt: 'No chat, o aviso "pensando" (e "trabalhando") agora começa na mesma borda esquerda das linhas de comandos executados.',
        en: 'In the chat, the "thinking" (and "working") line now starts at the same left edge as the executed-commands rows.',
      },
      {
        pt: 'OpenCode: o que ele diz antes e depois de uma ferramenta vira dois parágrafos, em vez de uma frase grudada ("juntos.Você"); e uma conversa reaberta mostra cada passo como foi mostrado ao vivo.',
        en: 'OpenCode: what it says before and after a tool becomes two paragraphs instead of one glued sentence ("together.You"); and a reopened conversation shows each step as it was shown live.',
      },
      {
        pt: 'OpenCode: uma edição num arquivo que já existia não aparece mais como arquivo novo, nem contada duas vezes, no painel de arquivos.',
        en: 'OpenCode: an edit to a file that already existed no longer shows up as a new file, nor counted twice, in the files panel.',
      },
    ],
  },
  '2.200.7': {
    features: [],
    fixes: [
      {
        pt: 'Nova sessão do OpenCode: o seletor de modelo volta a listar os modelos (os do seu opencode.json e os do OpenCode), mesmo se a primeira leitura falhar; antes a lista ficava vazia por horas.',
        en: 'New OpenCode session: the model picker lists models again (the ones in your opencode.json and OpenCode\'s own), even if the first read fails; before, the list stayed empty for hours.',
      },
      {
        pt: 'Mac: sessões do OpenCode abertas no terminal (instalado pelo Homebrew ou digitado pelo nome) voltam a aparecer na lista de sessões.',
        en: 'Mac: OpenCode sessions opened in a terminal (Homebrew install, or started by name) show up in the session list again.',
      },
      {
        pt: 'Uma sessão do OpenCode que você já tinha reaberto pelo agentistics e depois abriu no terminal não fica mais escondida atrás da linha antiga.',
        en: 'An OpenCode session you once reopened through agentistics and later opened in a terminal is no longer hidden behind the old row.',
      },
      {
        pt: 'Reabrir uma sessão não pisca mais o aviso "reabrir sessões que caíram" enquanto ela ainda está abrindo.',
        en: 'Reopening a session no longer flashes the "reopen the sessions that fell" offer while it is still starting.',
      },
    ],
  },
  '2.200.6': {
    features: [
      {
        pt: 'Na agenda de uso por agentes, cada dia tem a opção "Dia inteiro", e há um teto da semana: os agentes param quando a semana chega ao % que você definir. O teto do dia agora diz claramente "gastar no máximo X% da semana neste dia".',
        en: 'In the agent-use schedule, each day has an "All day" option, and there is a weekly ceiling: agents stop once the week reaches the % you set. The daily ceiling now reads clearly as "spend at most X% of the week on this day".',
      },
    ],
    fixes: [
      {
        pt: 'Nova sessão volta a mostrar os assistentes como antes; os não instalados aparecem apagados com o botão Instalar.',
        en: 'New session shows the assistants as before again; the ones not installed appear dimmed with an Install button.',
      },
    ],
  },
  '2.200.5': {
    features: [
      {
        pt: 'Atalho da Live Delivery no topo das Sessões: passe o mouse para ver a Live ao vivo num popup grande (no celular, toque para abrir uma folha), clique para ir à Live.',
        en: 'Live Delivery shortcut in the Sessions top bar: hover for a big live preview (on a phone, tap for a sheet), click to open Live.',
      },
      {
        pt: 'A Live agora abre com "só com agentes ativos" ligado, todas as tarefas e todas as etapas; cartões na fila ficam apagados e mostram a posição; modelo e conta em duas etiquetas; colunas maiores com barra de rolagem laranja.',
        en: 'Live now opens with "only active agents" on, all tasks and all steps; queued cards are dimmed and show their place; model and account in two pills; wider columns with an orange scrollbar.',
      },
      {
        pt: 'O menu do Agentask lista cada visão (Métricas, Quadro, Tabela, Live, Atividade) e destaca a ativa; os prazos estimados mostram só o horário aproximado, sem o selo de confiança.',
        en: 'The Agentask menu lists every view (Metrics, Board, Table, Live, Activity) and highlights the active one; estimated deadlines show only the approximate time, with no confidence label.',
      },
    ],
    fixes: [
      {
        pt: 'No Mac, a lista de sessões não trava mais o servidor: a leitura dos processos roda em segundo plano e é compartilhada, então a máquina volta a responder e encerrar ou abrir sessões funciona.',
        en: 'On a Mac the session list no longer stalls the server: the process scan runs in the background and is shared, so the machine answers again and ending or opening sessions works.',
      },
      {
        pt: 'No Mac, sessões abertas fora do agentistics (OpenCode e outras) voltam a aparecer, inclusive as instaladas em ~/.local/bin.',
        en: 'On a Mac, sessions opened outside agentistics (OpenCode and others) show up again, including tools installed in ~/.local/bin.',
      },
      {
        pt: 'OpenCode 2.x: a conversa de sessões novas é encontrada de novo (passagem de liderança, histórico), em vez de "o arquivo da conversa não foi encontrado".',
        en: 'OpenCode 2.x: new sessions\' conversations are found again (leader hand-off, history) instead of "conversation file not found".',
      },
      {
        pt: 'OpenCode 2.x: uma aba de outro terminal no mesmo diretório não troca mais a conversa de uma sessão aberta pelo agentistics.',
        en: 'OpenCode 2.x: a tab from another terminal in the same folder no longer swaps the conversation of a session agentistics opened.',
      },
    ],
  },
  '2.200.4': {
    features: [
      {
        pt: 'Atalho da Live Delivery no topo das Sessões: passe o mouse para ver a Live ao vivo num popup grande (no celular, toque para abrir uma folha), clique para ir à Live.',
        en: 'Live Delivery shortcut in the Sessions top bar: hover for a big live preview (on a phone, tap for a sheet), click to open Live.',
      },
      {
        pt: 'A Live agora abre com "só com agentes ativos" ligado, todas as tarefas e todas as etapas; cartões na fila ficam apagados e mostram a posição; modelo e conta em duas etiquetas; colunas maiores com barra de rolagem laranja.',
        en: 'Live now opens with "only active agents" on, all tasks and all steps; queued cards are dimmed and show their place; model and account in two pills; wider columns with an orange scrollbar.',
      },
      {
        pt: 'O menu do Agentask lista cada visão (Métricas, Quadro, Tabela, Live, Atividade) e destaca a ativa; os prazos estimados mostram só o horário aproximado, sem o selo de confiança.',
        en: 'The Agentask menu lists every view (Metrics, Board, Table, Live, Activity) and highlights the active one; estimated deadlines show only the approximate time, with no confidence label.',
      },
    ],
    fixes: [
      {
        pt: 'Entrega ao vivo abre mais rápido, reaproveitando leituras enquanto nada mudou.',
        en: 'Live Delivery opens faster by reusing reads while nothing has changed.',
      },
      {
        pt: 'A janela de uso dos planos sempre cabe na tela, tem altura limitada e rola por dentro (com barra de rolagem nova), e o "Refazer login" só aparece quando o login da conta expirou.',
        en: 'The plan usage popup always fits the screen, has a capped height and scrolls inside (with a new scrollbar), and "Sign in again" only shows when that account\'s login has expired.',
      },
      {
        pt: 'Na Entrega ao vivo, a linha "↳ na subtarefa" de cada cartão mostra a última ação daquela subtarefa, não a da tarefa inteira.',
        en: 'In Live Delivery, each card\'s "↳ on subtask" line shows that subtask\'s last action, not the whole task\'s.',
      },
      {
        pt: 'Uso → APIs não esvazia mais a lista quando o serviço oscila; no iPhone o áudio da ligação libera no primeiro toque.',
        en: 'Usage → APIs no longer empties the list when the service blips; on iPhone call audio unlocks on the first tap.',
      },
      {
        pt: 'Uso → APIs: a chave da ElevenLabs agora se cadastra, troca e remove direto na linha da ElevenLabs, com o passo a passo, as permissões e o plano necessário.',
        en: 'Usage → APIs: the ElevenLabs key is now added, changed and removed right on the ElevenLabs row, with the steps, permissions and plan it needs.',
      },
      {
        pt: 'Ligações: etiqueta beta oficial, página acompanha o idioma do app e a amostra de voz mostra um carregando de verdade.',
        en: 'Calls: official beta tag, the page follows the app language and the voice sample shows a real loading state.',
      },
      {
        pt: 'Ligações: o globo não mostra mais o traçado pontilhado e tocar nele não interrompe a fala.',
        en: 'Calls: the globe no longer shows the dotted trace, and tapping it does not interrupt the speech.',
      },
      {
        pt: 'Ligações: quando a sessão termina a tarefa, a resposta agora é sempre falada (antes podia ficar presa em "Preparando áudio").',
        en: 'Calls: when the session finishes its task, the answer is now always spoken (it could get stuck on "Preparing audio").',
      },
      {
        pt: 'Ligações: a voz se configura num painel com quatro partes (quem fala, vozes com busca, conta ElevenLabs, voz local), em tela cheia no celular.',
        en: 'Calls: voice settings live in a four-part panel (who speaks, voices with search, ElevenLabs account, local voice), full screen on phones.',
      },
    ],
  },
  '2.200.3': {
    features: [],
    fixes: [
      {
        pt: 'Na janela de uso dos planos, o botão de ligar/desligar e o "Refazer login" aparecem sempre, até na primeira abertura.',
        en: 'In the plan usage popup, the on/off switch and "Sign in again" always show up, even on the very first open.',
      },
      {
        pt: 'Contas sem leitura de plano aparecem na janela de uso, com o botão e a agenda, todas com o mesmo aviso "sem leitura do plano".',
        en: 'Accounts with no plan reading appear in the usage popup, with their switch and schedule, all with the same "no plan reading" note.',
      },
      {
        pt: 'Ligar ou desligar uma conta por um caminho antigo agora respeita a agenda, em vez de ser desfeito no minuto seguinte.',
        en: 'Switching an account on or off through an older route now respects the schedule instead of being undone a minute later.',
      },
      {
        pt: 'Mexer no quadro de tarefas não recarrega mais todos os dados do painel, e uma sequência longa de alterações continua atualizando o quadro e a Entrega ao vivo.',
        en: 'Editing the task board no longer reloads all dashboard data, and a long run of changes keeps the board and Live Delivery up to date.',
      },
      {
        pt: 'Na Entrega ao vivo, o cartão sempre pousa no lugar certo, mesmo se o quadro rolar durante o voo.',
        en: 'In Live Delivery the card always lands on its slot, even if the board scrolls mid-flight.',
      },
    ],
  },
  '2.200.2': {
    features: [],
    fixes: [
      {
        pt: 'Quando a porta do app já está ocupada, o aviso agora diz qual programa está usando ela.',
        en: 'When the app port is already taken, the message now names the program holding it.',
      },
      {
        pt: 'Cancelar uma sessão enquanto ela ainda está começando não deixa mais um processo vivo para trás.',
        en: 'Cancelling a session while it is still starting no longer leaves a process running behind.',
      },
      {
        pt: 'A instalação de teste no Mac usa portas fora da faixa que o macOS reserva, então não falha mais por porta ocupada.',
        en: 'The test install on Mac uses ports outside the range macOS reserves, so it no longer fails on a busy port.',
      },
    ],
  },
  '2.200.1': {
    features: [],
    fixes: [
      {
        pt: 'Entrega ao vivo atualiza na hora quando uma tarefa muda de etapa, sem esperar o próximo ciclo.',
        en: 'Live Delivery updates right away when a task changes stage, without waiting for the next cycle.',
      },
      {
        pt: 'Entrega ao vivo cabe inteira numa tela de computador (as 7 etapas), então a animação de merge aparece sem rolar; em telas menores a coluna de destino entra na vista antes da animação.',
        en: 'Live Delivery fits a desktop screen (all 7 stages), so the merge animation shows without scrolling; on smaller screens the destination column scrolls into view first.',
      },
      {
        pt: 'No celular, a Entrega ao vivo abre na primeira etapa com tarefas, os botões de página ficam maiores e o Esc fecha a folha de visualização.',
        en: 'On phones, Live Delivery opens on the first stage with tasks, the page buttons are larger and Esc closes the view sheet.',
      },
    ],
  },
  '2.200.0': {
    features: [
      {
        pt: 'Formulários do OpenCode funcionam de ponta a ponta: perguntas em várias etapas, seleção múltipla e a opção "Outra" com texto livre chegam certinho ao modelo, e dá para cancelar.',
        en: 'OpenCode forms work end to end: multi-step questions, multiple selection and the "Other" option with free text reach the model correctly, and you can cancel.',
      },
      {
        pt: 'Agentask saiu do beta.',
        en: 'Agentask is out of beta.',
      },
      {
        pt: 'O quadro mostra 10 tarefas por página por coluna, e dá para escolher 10, 25, 50 ou 100. A escolha fica guardada por pessoa.',
        en: 'The board shows 10 tasks per page per column, and you can choose 10, 25, 50 or 100. The choice is saved per person.',
      },
      {
        pt: 'Nova visão Entrega ao vivo no Agentask: cada peça aparece na etapa em que está (fila, execução, QA, revisão, ajuste, publicado), com o agente, o tempo e a estimativa com fonte. Os líderes ficam numa faixa própria. Os cards deslizam entre as colunas, e um merge aprovado se desfaz em cinza e reaparece em verde em Publicado. A Nay também consulta essa visão.',
        en: 'New Live Delivery view in Agentask: each piece appears at the stage it is in (queue, running, QA, review, rework, published), with the agent, the time and a sourced estimate. Leaders sit in their own lane. Cards slide between columns, and an approved merge crumbles to grey and reappears in green under Published. Nay can also look at this view.',
      },
      {
        pt: 'Modo autônomo de ponta a ponta: o líder recebe um aviso quando um worker fica parado há 30 minutos, e a esteira leva cada entrega da sessão à revisão e à limpeza, sem marcar como concluída sozinha.',
        en: 'End-to-end autonomous mode: the leader gets a notice when a worker has been idle for 30 minutes, and the pipeline takes each delivery from the session through review and cleanup, without marking it done on its own.',
      },
      {
        pt: 'Modo ligação em beta para todos: o botão de ligar e a página Ligações aparecem sem precisar ligar o modo experimental. A chave da ElevenLabs pode ser cadastrada direto no cartão Voz.',
        en: 'Call mode is now in beta for everyone: the call button and the Calls page show up without turning on experimental mode. The ElevenLabs key can be added right in the Voice card.',
      },
      {
        pt: 'Escolha a voz da ElevenLabs pelo botão de voz da ligação, com amostra que não gasta crédito; o cartão Voz mostra quanto foi usado, quanto sobra e quando renova.',
        en: 'Pick your ElevenLabs voice from the call voice button, with samples that cost no credits; the Voice card shows how much was used, what is left and when it renews.',
      },
      {
        pt: 'Uso dos planos ganha as seções Contas e APIs: o saldo das chaves de API pagas aparece no painel e na página de uso.',
        en: 'Plan usage now has Accounts and APIs sections: the balance of paid API keys shows in the panel and on the usage page.',
      },
      {
        pt: 'Quadro de tarefas com uma barra só: busca, painel Visualização, filtros e as visões Métricas, Quadro e Tabela no mesmo lugar. Por padrão aparecem os status bloqueado, a fazer, em andamento, em revisão e concluído; os outros podem ser reexibidos.',
        en: 'Task board with a single toolbar: search, the View panel, filters and the Metrics, Board and Table views in one place. By default the blocked, to do, in progress, in review and done statuses are shown; the others can be shown again.',
      },
      {
        pt: 'Agenda das contas: cada conta pode ter dias, horários e um teto diário de uso pelos agentes. Fora da agenda, os agentes deixam a conta de lado; ligar ou desligar à mão continua valendo.',
        en: 'Account schedule: each account can have days, hours and a daily usage ceiling for agents. Outside the schedule, agents leave the account alone; switching it on or off by hand still applies.',
      },
      {
        pt: 'O "modo ausente" agora se chama "modo autônomo": ligado, as sessões trabalham sem pedir permissão e os líderes seguem em frente dentro do que você autorizou.',
        en: 'Away mode is now "Autonomous mode": while it is on, sessions work without asking permission and leaders keep going within what you authorised.',
      },
      {
        pt: 'Com o modo autônomo ligado, toda sessão nova (Nova sessão, linha de comando, MCP, passagem de líder) já nasce no modo "sem perguntas" — a menos que você escolha outro. A Nova sessão mostra de onde veio o modo.',
        en: 'With autonomous mode on, every new session (New session, command line, MCP, leader hand-off) is born in "no questions" mode — unless you pick another. New session shows where the mode came from.',
      },
    ],
    fixes: [
      {
        pt: 'Ligação entende português ou inglês sozinha, mesmo com o app em outro idioma, e responde no idioma falado.',
        en: 'Calls detect whether you speak Portuguese or English on their own, even with the app in another language, and reply in the language spoken.',
      },
      {
        pt: 'Página Ligações com uma ligação em andamento: o cartão mostra o nome da sessão em vez de "Sessão ?", e o botão "Voltar para a ligação" tem o ícone do tamanho certo.',
        en: 'Calls page with a call in progress: the card shows the session name instead of "Session ?", and the "Back to the call" button has a properly sized icon.',
      },
    ],
  },
  '2.199.0': {
    features: [
      {
        pt: 'Todo assistente compatível aparece em Nova sessão e em Uso, a partir de um catálogo único.',
        en: 'Every compatible assistant now shows up in New session and in Usage, from a single catalog.',
      },
      {
        pt: 'Abas do OpenCode abertas fora do app aparecem como sessões que você pode continuar, também no Mac.',
        en: 'OpenCode tabs opened outside the app appear as sessions you can continue, on Mac too.',
      },
      {
        pt: 'O vidro (menus, barras e janelas translúcidos) agora é parte do app: está sempre ligado e saiu das configurações.',
        en: 'Glass (translucent menus, bars and dialogs) is now part of the app: always on, and gone from settings.',
      },
    ],
    fixes: [
      {
        pt: 'Contas: duas contas Claude do mesmo plano não se confundem mais — acabou o falso "login expirado", o mesmo uso nas duas e a conta Principal aparecendo desconectada.',
        en: 'Accounts: two Claude accounts on the same plan are no longer mixed up — no more false "login expired", the same usage on both, or the Principal account shown as disconnected.',
      },
    ],
  },
  '2.198.0': {
    features: [
      {
        pt: 'Agentask: só sessões líderes ficam presas direto na tarefa; os workers vão para as subtarefas. A lista de sessões no fim da tarefa foi redesenhada para dar conta de muitas sessões, com grupos e busca.',
        en: 'Agentask: only leader sessions are attached straight to a task; workers go on subtasks. The session list at the end of a task is redesigned to handle many sessions, with groups and search.',
      },
      {
        pt: 'OpenCode no Uso: tokens, custo, contexto e número de sessões das versões 1 e 2 agora aparecem, e o filtro Codex + OpenCode soma os dois.',
        en: 'OpenCode in Usage: tokens, cost, context and session count from versions 1 and 2 now show up, and the Codex + OpenCode filter adds both.',
      },
      {
        pt: 'Sessões do OpenCode 2 abertas fora do app aparecem na lista, ligadas ao processo e com atividade.',
        en: 'OpenCode 2 sessions opened outside the app show up in the list, linked to their process and with activity.',
      },
    ],
    fixes: [
      {
        pt: 'Contas: refazer o login não trava mais o app — a janela de login parava de responder por pedir o status sem parar.',
        en: 'Accounts: signing in again no longer freezes the app — the sign-in dialog kept polling its status nonstop.',
      },
      {
        pt: 'Quando um líder troca de harness ou de conta, a sessão nova herda os workers do antigo, e as mensagens deles chegam ao líder novo.',
        en: 'When a leader switches harness or account, the new session inherits the old one\'s workers, and their messages reach the new leader.',
      },
      {
        pt: 'Terminal: o Shell volta a abrir no macOS (zsh de login, Homebrew no PATH), com um carregamento central visível do clique até a primeira tela, e abre bem mais rápido.',
        en: 'Terminal: the Shell opens on macOS again (login zsh, Homebrew on PATH), with a central loader from the click to the first frame, and it opens much faster.',
      },
      {
        pt: 'O app abre mais rápido: as sessões recentes e ativas aparecem primeiro e o resto carrega por trás.',
        en: 'The app opens faster: recent and live sessions show first and the rest loads behind.',
      },
      {
        pt: 'Uma pasta criada agora aparece na Nova sessão → Onde.',
        en: 'A newly created folder now shows up in New session → Where.',
      },
      {
        pt: 'Sessões externas do Codex podem ser tocadas e retomadas pelo app.',
        en: 'External Codex sessions can be driven and resumed from the app.',
      },
    ],
  },
  '2.197.4': {
    features: [
      {
        pt: 'OpenCode 2.x: as sessões da versão nova (inclusive as abertas no terminal do OpenCode) voltam a aparecer e abrem com o histórico completo.',
        en: 'OpenCode 2.x: sessions from the new version (including ones opened in the OpenCode terminal) show up again and open with their full history.',
      },
      {
        pt: 'OpenCode 2.x: dá para trocar de modelo no meio da conversa e escolher o nível de esforço.',
        en: 'OpenCode 2.x: you can switch models mid-conversation and pick the effort level.',
      },
    ],
    fixes: [
      {
        pt: 'OpenCode 2.x: quando o provedor fica tentando de novo sem parar, o turno travado é parado e as mensagens na fila voltam a andar.',
        en: 'OpenCode 2.x: when the provider keeps retrying forever, the stuck turn is stopped and queued messages move again.',
      },
      {
        pt: 'Se o OpenCode não puder ser lido, aparece um aviso dizendo o que fazer, em vez de uma lista vazia sem explicação.',
        en: 'If OpenCode cannot be read, a notice says what to do instead of an empty list with no explanation.',
      },
      {
        pt: 'Ligações: o cartão da chamada mostra o nome da sessão e o botão Voltar tem o tamanho certo.',
        en: 'Calls: the live call card shows the session name and the Back button has the right size.',
      },
    ],
  },
  '2.197.3': {
    features: [],
    fixes: [
      {
        pt: 'Blocos de código nas conversas ganham um botão de copiar (sempre visível no celular), que copia só o código, inclusive quando o app é aberto por HTTP.',
        en: 'Code blocks in conversations get a copy button (always visible on touch screens) that copies just the code, also when the app is opened over HTTP.',
      },
      {
        pt: 'No celular e no tablet, tocar nos botões e nas listas não seleciona mais o texto sem querer; o texto das mensagens continua selecionável.',
        en: 'On phones and tablets, tapping buttons and lists no longer selects text by accident; message text can still be selected.',
      },
      {
        pt: 'A gaveta da árvore de áreas abre por cima da barra do topo e do aviso de líder, com o fundo escurecido nas telas de toque.',
        en: 'The area tree drawer opens above the top bar and the leader notice, with a dimmed background on touch screens.',
      },
    ],
  },
  '2.197.2': {
    features: [],
    fixes: [
      {
        pt: 'Uso das contas: o consumo de cada conta Claude agora vai para a conta em que a sessão realmente roda; antes, duas contas podiam aparecer com os números trocados.',
        en: 'Account usage: each Claude account now gets the usage of the sessions that really run on it; before, two accounts could show each other\'s numbers.',
      },
      {
        pt: 'A tela de contas mostra "carregando" até as suas contas chegarem, e um aviso com "tentar de novo" se não carregar, em vez de uma lista genérica sem números.',
        en: 'The accounts screen shows "loading" until your accounts arrive, and a notice with "try again" if they fail to load, instead of a generic list with no numbers.',
      },
    ],
  },
  '2.197.1': {
    features: [],
    fixes: [
      {
        pt: 'A 2.197.0 não chegou a ser publicada por uma falha do GitHub; esta versão traz a mesma correção da tela presa depois de atualizar.',
        en: '2.197.0 was never published because of a GitHub failure; this version carries the same fix for the screen stuck after an update.',
      },
    ],
  },
  '2.197.0': {
    features: [],
    fixes: [
      {
        pt: 'Depois de atualizar, o app abre uns 2 segundos depois de o servidor voltar, na mesma tela em que você estava, sem ficar preso em "acabou de reiniciar… já vai abrir" e sem tela de erro, mesmo com refresh no meio.',
        en: 'After an update the app opens about 2 seconds after the server is back, on the same screen you were on, without getting stuck on "just restarted… opening soon" and without an error screen, even if you refresh in the middle.',
      },
    ],
  },
  '2.196.0': {
    features: [],
    fixes: [
      {
        pt: "Com várias abas do app abertas, ele não trava mais nem mostra 'servidor não responde' à toa: as atualizações ao vivo de cada aba passam por um único canal.",
        en: "With several app tabs open, it no longer freezes or shows 'server not responding' for no reason: each tab's live updates now go through a single channel.",
      },
      {
        pt: "Modo ligação (experimental): a página Ligações mostra 'carregando' em vez de ficar vazia, e quando a ElevenLabs recusa a voz a ligação diz o motivo (por exemplo, plano gratuito não pode usar vozes da biblioteca).",
        en: "Call mode (experimental): the Calls page shows 'loading' instead of staying empty, and when ElevenLabs refuses the voice the call says why (for example, the free plan cannot use library voices).",
      },
    ],
  },
  '2.195.0': {
    features: [],
    fixes: [
      {
        pt: 'O fechamento automático não encerra mais um worker que avisou que está esperando a próxima etapa; ele só fecha depois da entrega final.',
        en: 'Automatic closing no longer ends a worker that said it is waiting for the next step; it only closes after the final delivery.',
      },
      {
        pt: 'A espera por uma entrega pode filtrar pelo assunto, e não dispara mais com qualquer entrega da mesma sessão.',
        en: 'Waiting for a delivery can filter by subject, and no longer fires on any delivery from the same session.',
      },
    ],
  },
  '2.194.0': {
    features: [
      {
        pt: 'Fechar uma sessão agora encerra tudo o que ela abriu (assistente, ferramentas, testes); um coletor automático recolhe sobras de sessões fechadas e mostra quanta memória liberou.',
        en: 'Closing a session now ends everything it opened (assistant, tools, tests); an automatic collector sweeps leftovers of closed sessions and shows how much memory it freed.',
      },
    ],
    fixes: [
      {
        pt: 'Uma sessão encerrada não volta mais a ligar sozinha, e a tela de processos não marca mais como encerrado o que está vivo.',
        en: 'A closed session no longer turns itself back on, and the processes screen no longer marks something alive as ended.',
      },
      {
        pt: 'Avisos dos fluxos aparecem como cartão do sistema (não como mensagem sua), e o fechamento de sessões que já entregaram passou a funcionar.',
        en: 'Flow notices appear as a system card (not as a message from you), and closing sessions that already delivered now works.',
      },
    ],
  },
  '2.193.0': {
    features: [],
    fixes: [
      {
        pt: 'OpenCode: ler um print ou arquivo colado no chat não trava mais a sessão esperando uma permissão escondida; suas regras de permissão continuam valendo.',
        en: 'OpenCode: reading a screenshot or file pasted into the chat no longer freezes the session waiting on a hidden permission; your permission rules still apply.',
      },
      {
        pt: 'Reabrir uma sessão quando o assistente antigo ainda está rodando agora avisa em vez de abrir um segundo assistente na mesma conversa.',
        en: 'Reopening a session while the old assistant is still running now warns you instead of opening a second assistant in the same conversation.',
      },
    ],
  },
  '2.192.0': {
    features: [
      {
        pt: 'Chaves de provedor (OpenRouter, OpenAI, Anthropic, ElevenLabs…) ficam trancadas neste computador e funcionam mesmo com o cofre trancado; nunca aparecem em tela nem em registro.',
        en: 'Provider keys (OpenRouter, OpenAI, Anthropic, ElevenLabs…) stay locked on this computer and work even while the vault is locked; they never show on screen or in logs.',
      },
      {
        pt: 'Ligação por voz: ao sair da aba durante uma ligação, abre uma janelinha flutuante (Chrome/Edge) com mudo, encerrar e voltar; formato compacto ou barra fina.',
        en: 'Voice call: leaving the tab during a call opens a small floating window (Chrome/Edge) with mute, hang up and back; compact or thin bar.',
      },
    ],
    fixes: [],
  },
  '2.191.0': {
    features: [
      {
        pt: 'Fluxos (experimental, desligado por padrão): um ambiente descartável para testar uma versão do código sem mexer nos seus dados nem nas suas configurações de verdade. Ele sobe, você testa, e depois é desmontado.',
        en: 'Flows (experimental, off by default): a throwaway environment to test a version of the code without touching your real data or settings. It starts up, you test, and then it is taken down.',
      },
      {
        pt: 'Fluxos (experimental, desligado por padrão): sessões de trabalho que terminaram e salvaram o que fizeram se fecham sozinhas. Sessões de líder nunca se fecham sozinhas.',
        en: 'Flows (experimental, off by default): worker sessions that finished and saved their work close by themselves. Leader sessions never do.',
      },
      {
        pt: 'Fluxos (experimental): com os fluxos ligados, o resumo do líder lista quem ainda está aberto e quem ainda não salvou o trabalho. O fechamento automático foi testado com sessões simuladas; com um trabalhador real ainda não.',
        en: 'Flows (experimental): with flows on, the leader\'s summary lists who is still open and who has not saved their work yet. Auto-close was tested with simulated sessions, not yet with a real worker.',
      },
      {
        pt: 'Ligação por voz: a barra mostra "Trabalhando" enquanto ela faz o que você pediu.',
        en: 'Voice call: the bar says \'Working\' while she does what you asked.',
      },
    ],
    fixes: [
      {
        pt: 'Reabrir uma sessão encerrada que ficou presa em "já está aberta em…" volta a funcionar.',
        en: 'Reopening an ended session stuck on "already open in…" works again.',
      },
    ],
  },
  '2.190.0': {
    features: [
      {
        pt: 'Fluxos (experimental, desligado por padrão): um novo fluxo confere se o Docker está instalado e ligado neste computador. Ele só olha; não instala nem liga nada.',
        en: 'Flows (experimental, off by default): a new flow checks whether Docker is installed and running on this computer. It only looks; it never installs or starts anything.',
      },
    ],
    fixes: [
      {
        pt: 'Fluxos (experimental): fechar uma sessão entregue agora confere a pasta de trabalho da própria sessão, mesmo quando ela foi aberta numa pasta compartilhada; se não achar essa pasta, recusa e diz por quê. Testado com sessões simuladas; com um trabalhador real ainda não.',
        en: 'Flows (experimental): closing a delivered session now checks the session\'s own work folder, even when it was started in a shared folder; if it cannot find that folder, it refuses and says why. Tested with simulated sessions; not yet with a real worker.',
      },
    ],
  },
  '2.189.0': {
    features: [
      {
        pt: 'Hermes Agent: o app passou a conhecer o Hermes, mas só como declarado. Ele ainda não abre sessões, não mostra chat nem números de uso, e não foi testado com o Hermes rodando de verdade. Nada muda para quem não o tem instalado.',
        en: 'Hermes Agent: the app now knows about Hermes, but only as declared. It cannot start sessions yet, shows no chat or usage figures, and has not been tested with Hermes really running. Nothing changes if you do not have it installed.',
      },
    ],
    fixes: [],
  },
  '2.188.0': {
    features: [
      {
        pt: 'Fluxos (experimental, desligado por padrão): nova limpeza que apaga de verdade a pasta de trabalho de uma sessão encerrada. Antes de apagar, ela confere que a sessão terminou, entregou o trabalho e salvou tudo, guarda uma cópia que dá para restaurar e nunca mexe na pasta compartilhada; na dúvida, recusa. Testada com sessões simuladas; com uma sessão real de ponta a ponta ainda não.',
        en: 'Flows (experimental, off by default): a new cleanup that really deletes the work folder of a finished session. Before deleting, it checks that the session ended, handed its work back and saved everything, keeps a copy that can be restored and never touches the shared folder; when in doubt, it refuses. Tested with simulated sessions; not yet end to end with a real one.',
      },
    ],
    fixes: [
      {
        pt: 'Fluxos (experimental): fechar uma sessão entregue não fica mais esperando para sempre quando o app não responde; ele recusa com um aviso.',
        en: 'Flows (experimental): closing a delivered session no longer waits forever when the app does not answer; it refuses with a notice.',
      },
    ],
  },
  '2.187.0': {
    features: [],
    fixes: [
      {
        pt: 'Histórico e busca do chat (opção experimental): a busca agora encontra a palavra com ou sem acento e procura só no texto que aparece na conversa, sem o raciocínio do modelo nem as ferramentas.',
        en: 'Chat history and search (experimental option): search now finds a word with or without accents and only looks at the text shown in the conversation, not the model\'s reasoning or tools.',
      },
      {
        pt: 'Fluxos (experimental): uma execução que ainda está rodando não aparece mais como interrompida quando outro processo a consulta.',
        en: 'Flows (experimental): a run that is still going no longer shows as interrupted when another process checks on it.',
      },
    ],
  },
  '2.186.0': {
    features: [
      {
        pt: 'Nova opção experimental, desligada por padrão: no Claude Code e no OpenCode, o histórico e a busca do chat passam a ser lidos de um jeito novo, que carrega as mensagens mais antigas aos poucos. Conferida só com testes automáticos; numa sessão real ainda não. Com ela ligada, a busca ainda diferencia letras com e sem acento e também encontra o raciocínio do modelo; isso será corrigido.',
        en: 'New experimental option, off by default: in Claude Code and OpenCode, chat history and search are read in a new way that loads older messages a little at a time. Checked only with automated tests; not yet in a real session. With it on, search still treats letters with and without accents as different and also finds the model\'s reasoning; this will be fixed.',
      },
      {
        pt: "Ligação por voz (experimental): legenda numa linha que rola sob o globo e um cartão que mostra o que ela está fazendo agora, passo a passo; em telas largas dá para abrir 'Ver o que ela vê'.",
        en: "Voice call (experimental): a rolling caption under the globe and a card showing what she is doing now, step by step; on wide screens you can open 'See what she sees'.",
      },
    ],
    fixes: [],
  },
  '2.185.0': {
    features: [
      {
        pt: 'Ligação por voz (experimental): dá para usar a sua própria chave da ElevenLabs para uma voz mais natural. A chave fica guardada criptografada e nunca aparece na tela. Conferido com testes automáticos; uma ligação real com a ElevenLabs ainda não foi feita.',
        en: 'Voice call (experimental): you can use your own ElevenLabs key for a more natural voice. The key is stored encrypted and never shown. Checked with automated tests; a real call with ElevenLabs has not been made yet.',
      },
    ],
    fixes: [
      {
        pt: 'Ligação por voz: quando a resposta tem imagens, a voz avisa que deixou imagens na tela e continua falando o texto que vem depois, em vez de parar.',
        en: 'Voice call: when a reply has images, the voice says it left images on screen and keeps speaking the text that follows, instead of stopping.',
      },
      {
        pt: 'Ligação por voz: se uma fala sua se perder no caminho, a ligação pede para você repetir e volta a ouvir, em vez de ficar surda até desligar.',
        en: 'Voice call: if something you said gets lost on the way, the call asks you to repeat and listens again, instead of going deaf until you hang up.',
      },
    ],
  },
  '2.184.0': {
    features: [
      {
        pt: 'Um líder que está esperando algo (uma entrega, memória livre, um horário ou o fim de um trabalho) agora é acordado sozinho quando isso acontece, uma vez só, mesmo que o app reinicie no meio (fluxos experimentais). Conferido pelo registro do app; ver a mensagem chegando na tela ainda falta conferir.',
        en: 'A leader waiting for something (a delivery, free memory, a set time or a job ending) is now woken on its own when it happens, exactly once, even if the app restarts midway (experimental flows). Checked through the app\'s own records; seeing the message arrive on screen is still unchecked.',
      },
      {
        pt: 'O harness nativo agora conversa com os modelos do Google. Conferido só com testes automáticos; uma conversa real ainda não foi feita.',
        en: 'The native harness now talks to Google models. Checked only with automated tests; a real conversation has not been done yet.',
      },
      {
        pt: 'No harness nativo, o modelo pode ir até a definição de um símbolo e listar onde ele é usado, pelos servidores de linguagem que você já configurou. Conferido com um servidor de teste; com um servidor real ainda não.',
        en: 'In the native harness, the model can jump to a symbol\'s definition and list where it is used, through the language servers you already set up. Checked with a test server; not yet with a real one.',
      },
    ],
    fixes: [
      {
        pt: 'Quando um trabalho passa a vez para outro, o novo continua sendo trabalho do mesmo líder, com a mesma conta, e não vira líder por engano.',
        en: 'When a worker hands its job to a new session, the new one stays a worker of the same leader, on the same account, instead of becoming a leader by mistake.',
      },
      {
        pt: 'Parar um teste numa cópia descartável do app agora encerra também os processos que ele abriu em segundo plano.',
        en: 'Stopping a test in a throwaway copy of the app now also ends the processes it started in the background.',
      },
    ],
  },
  '2.183.0': {
    features: [],
    fixes: [
      {
        pt: 'Trabalho aberto em outra conta do Claude não corre mais o risco de perder a resposta "confiar nesta pasta?" quando duas sessões começam ao mesmo tempo.',
        en: 'Work opened in another Claude account no longer risks losing the "trust this folder" answer when two sessions start at the same time.',
      },
      {
        pt: 'Ligar um fluxo pelo terminal agora chega ao app que já está aberto, sem precisar reiniciá-lo (fluxos experimentais).',
        en: 'Turning a flow on from the terminal now reaches the app that is already running, with no restart needed (experimental flows).',
      },
    ],
  },
  '2.182.0': {
    features: [
      {
        pt: 'Por baixo, o app agora consegue corrigir ou cancelar uma mensagem já enviada a uma sessão e confirmar quando o cancelamento valeu, sem repetir a ação se o app cair no meio. Ainda não há botão para isso: a chamada de voz passa a usar numa próxima versão. Conferido ao vivo no Claude, no Copilot e no OpenCode; no OpenCode faltou conferir o cancelamento de uma mensagem já respondida, e a parte de o app cair no meio só passou em testes automáticos.',
        en: 'Under the hood, the app can now correct or cancel a message already sent to a session and confirm when the cancel took effect, without repeating it if the app stops midway. There is no button for it yet: the voice call starts using it in a coming version. Checked live on Claude, Copilot and OpenCode; on OpenCode, cancelling a message that was already answered is still unchecked, and the app-stops-midway part passed only automated tests.',
      },
      {
        pt: 'No Codex, a correção foi feita a partir de uma gravação; a conferência ao vivo ainda está pendente.',
        en: 'On Codex, the fix was made from a recording; the live check is still pending.',
      },
      {
        pt: 'No Gemini, no Kimi, no Antigravity e no harness nativo, isso foi conferido só por testes automáticos, não ao vivo.',
        en: 'On Gemini, Kimi, Antigravity and the native harness, this was checked only by automated tests, not live.',
      },
    ],
    fixes: [],
  },
  '2.181.0': {
    features: [
      {
        pt: 'A base para corrigir ou cancelar uma mensagem já enviada está pronta e chega completa na próxima versão.',
        en: 'The groundwork for correcting or cancelling a message already sent is in place and arrives complete in the next version.',
      },
    ],
    fixes: [
      {
        pt: 'Sessões iniciadas em outra conta do Claude não param mais na pergunta "confiar nesta pasta?".',
        en: 'Workers started on another Claude account no longer stop at the "trust this folder?" question.',
      },
    ],
  },
  '2.180.1': {
    features: [],
    fixes: [
      {
        pt: 'Ligação por voz: o eco da própria voz e barulhos curtos não são mais tomados como interrupção; dizer "para", "não" ou "espera" continua pausando na hora.',
        en: 'Voice call: the voice\'s own echo and short noises are no longer taken as an interruption; saying "stop", "no" or "wait" still pauses at once.',
      },
    ],
  },
  '2.180.0': {
    features: [],
    fixes: [
      {
        pt: 'OpenCode: os pedidos de permissão mostram o que estão pedindo (arquivo, pasta) e podem ser respondidos.',
        en: 'OpenCode: permission requests show what they ask for (file, folder) and can be answered.',
      },
      {
        pt: 'Uma sessão que atinge o limite de uso agora avisa isso em vez de esperar para sempre.',
        en: 'A session that hits its usage limit now says so instead of waiting forever.',
      },
      {
        pt: 'OpenCode: uma sessão aberta fora do agentistics que só está esperando não aparece mais como "precisa de você".',
        en: 'OpenCode: a session opened outside agentistics that is only waiting no longer shows "needs you".',
      },
      {
        pt: 'O nome dado a uma sessão sucessora é mantido.',
        en: 'The name given to a successor session is kept.',
      },
      {
        pt: 'O cartão de permissão mostra o caminho do arquivo uma única vez.',
        en: 'The permission card shows the file path only once.',
      },
    ],
  },
  '2.179.0': {
    features: [
      {
        pt: 'Experimental, ligação por voz: pedir para cancelar ou corrigir um pedido já enviado age sobre esse pedido; quando não dá para confirmar, a voz diz isso em vez de reenviar.',
        en: 'Experimental, voice call: asking to cancel or correct a request you already sent acts on that request; when it cannot be confirmed, the voice says so instead of sending it again.',
      },
    ],
    fixes: [
      {
        pt: 'Ligação por voz: respostas longas não param mais de falar no meio.',
        en: 'Voice call: long replies no longer stop speaking halfway through.',
      },
      {
        pt: 'Ligação por voz: a transcrição entende melhor termos técnicos e palavras em inglês no meio do português.',
        en: 'Voice call: transcription understands technical terms and English words within Portuguese better.',
      },
      {
        pt: 'Ligação por voz: os botões "Continuar a fala" e "Parar a fala" seguem o estilo dos botões do app, e o brilho do globo não passa mais da borda do painel nem do cartão.',
        en: 'Voice call: the "Continue speaking" and "Stop speaking" buttons match the app\'s buttons, and the globe\'s glow no longer spills past the panel or card edge.',
      },
    ],
  },
  '2.178.0': {
    features: [
      {
        pt: 'OpenCode: uma sessão iniciada pela linha de comando agora mostra o botão de modo e a lista de modelos.',
        en: 'OpenCode: a session started from the command line now shows the mode button and the model list.',
      },
      {
        pt: 'OpenCode: ao reabrir uma conversa, cada mensagem e os avisos de limite de uso continuam lá.',
        en: 'OpenCode: when you reopen a chat, each message and the usage-limit notices are still there.',
      },
      {
        pt: 'OpenCode: Ramificar mantém o modo e o modelo da conversa.',
        en: 'OpenCode: Branch keeps the chat mode and model.',
      },
    ],
    fixes: [
      {
        pt: 'OpenCode: o nome do modelo se atualiza na hora.',
        en: 'OpenCode: the model name updates at once.',
      },
      {
        pt: 'OpenCode: uma sessão aberta fora do agentistics mostra se está trabalhando.',
        en: 'OpenCode: a session opened outside agentistics shows whether it is working.',
      },
      {
        pt: 'OpenCode: uma resposta que só usou ferramentas agora mostra a atividade.',
        en: 'OpenCode: a reply that only used tools now shows its activity.',
      },
    ],
  },
  '2.177.0': {
    features: [
      {
        pt: 'Uma sessão do OpenCode agora funciona em qualquer papel — líder, trabalhadora, revisão ou iniciada por outra sessão: recebe as instruções e ferramentas do agentistics, abre sessões, relata a entrega e passa a liderança sem perguntas.',
        en: 'An OpenCode session now works in any role — leader, worker, review or started by another session: it gets the agentistics instructions and tools, opens sessions, reports its delivery and hands over leadership without questions.',
      },
    ],
    fixes: [
      {
        pt: 'OpenCode: um arquivo de configuração com comentários não deixa mais a sessão sem ferramentas.',
        en: 'OpenCode: a config file with comments no longer leaves the session without tools.',
      },
    ],
  },
  '2.176.0': {
    features: [
      {
        pt: 'Experimental, ligação por voz: uma fala longa, com pausas, vira um pedido só, sem te cortar no meio.',
        en: 'Experimental, voice call: a long message with pauses becomes a single request, without cutting you off.',
      },
      {
        pt: 'Experimental, ligação por voz: diga "para", "não" ou "espera" e a voz pausa na hora; se foi só barulho, ela retoma. Se não der para confirmar, aparecem "Continuar a fala" e "Parar a fala".',
        en: 'Experimental, voice call: say "stop", "no" or "wait" and the voice pauses at once; if it was just noise, it resumes. If it cannot tell, "Continue speaking" and "Stop speaking" appear.',
      },
      {
        pt: 'Experimental, ligação por voz: perguntas como "tá aí?" ou "travou?" recebem o andamento real da tarefa.',
        en: 'Experimental, voice call: questions like "are you there?" or "is it stuck?" get the real progress of the task.',
      },
    ],
    fixes: [
      {
        pt: 'Ligação por voz: desligar não cancela mais a tarefa em andamento, e depois de uma interrupção a resposta considera só o que você ouviu.',
        en: 'Voice call: hanging up no longer cancels the running task, and after an interruption the reply only counts what you actually heard.',
      },
      {
        pt: 'Ligação por voz: o globo segue o estado real e só mostra "falando" quando sai som; com pouca memória, a voz carrega num modo leve e avisa.',
        en: 'Voice call: the globe follows the real state and only shows "speaking" when there is sound; with little memory, the voice loads in a light mode and says so.',
      },
    ],
  },
  '2.175.0': {
    features: [
      {
        pt: 'Experimental: quando uma sessão de trabalho entrega o resultado e o trabalho está salvo, o agentistics pode encerrá-la sozinho (ative com a opção de fluxos e `agentop flow enable fechar-entregue`). Se recusar, o líder recebe o motivo.',
        en: 'Experimental: when a worker session hands back its result and the work is saved, agentistics can close it by itself (turn it on with the flows option and `agentop flow enable fechar-entregue`). If it refuses, the leader is told why.',
      },
    ],
    fixes: [
      {
        pt: 'Rodar os testes não deixa mais processos em segundo plano consumindo memória.',
        en: 'Running the tests no longer leaves background processes eating memory.',
      },
    ],
  },
  '2.174.0': {
    features: [
      {
        pt: 'OpenCode: os quatro modos (Padrão, Aceitar edições, Plano, Sem perguntas) funcionam dentro da sessão, sem reiniciar; o chat mostra "Permitido pelo modo" quando o modo libera uma ação.',
        en: 'OpenCode: all four modes (Default, Accept edits, Plan, No questions) work inside the session without restarting; the chat shows "Allowed by the mode" when the mode lets an action through.',
      },
      {
        pt: 'OpenCode: sessões abertas no terminal aparecem no app com histórico, e "Continuar aqui" assume a conversa.',
        en: 'OpenCode: sessions opened in the terminal show up in the app with their history, and "Continue here" takes the conversation over.',
      },
      {
        pt: 'OpenCode: o rodapé mostra tokens, contexto e custo; o OpenCode entra em Comparar, no filtro de assistentes e em Uso, e a busca no histórico acha as conversas dele.',
        en: 'OpenCode: the footer shows tokens, context and cost; OpenCode is in Compare, the assistant filter and Usage, and history search finds its conversations.',
      },
      {
        pt: 'OpenCode: "Ramificar esta conversa" no menu da sessão, e o comando para retomar a conversa direto no OpenCode nas sessões encerradas.',
        en: 'OpenCode: "Fork this conversation" in the session menu, and the command to resume the conversation in OpenCode itself on ended sessions.',
      },
    ],
    fixes: [
      {
        pt: 'OpenCode: quando o limite do modelo gratuito acaba, a sessão para e o chat avisa, em vez de ficar "trabalhando" para sempre.',
        en: 'OpenCode: when the free model\'s limit runs out, the session stops and the chat says so, instead of "working" forever.',
      },
      {
        pt: 'Reabrir uma sessão volta no mesmo modo em que ela estava; quando falta memória, reabrir e iniciar dizem o motivo e oferecem "mesmo assim".',
        en: 'Reopening a session brings it back in the mode it was in; when memory is short, reopen and start say why and offer "anyway".',
      },
      {
        pt: 'No celular, o contador de caracteres do rodapé aparece inteiro.',
        en: 'On the phone, the footer\'s character counter shows whole.',
      },
    ],
  },
  '2.173.1': {
    features: [],
    fixes: [
      {
        pt: 'A ligação na janela flutuante pequena ganhou um layout próprio: o globo aparece inteiro, o status e os avisos ficam numa linha própria e nada mais fica sobreposto ao campo de escrever.',
        en: 'The call in the small floating window has its own layout: the globe shows whole, status and notices sit on their own line, and nothing overlaps the input anymore.',
      },
    ],
  },
  '2.173.0': {
    features: [],
    fixes: [
      {
        pt: 'O botão vermelho do composer agora encerra a ligação de verdade, e a ligação volta acima do campo ao retornar à sessão; o botão de ditar se esconde durante a ligação.',
        en: 'The composer\'s red button now really ends the call, and the call returns above the input when you come back to the session; the dictate button hides during the call.',
      },
      {
        pt: 'A janela flutuante abre compacta, e o botão da Nay mostra um menu com a ligação minimizada (voltar, encerrar) e "Abrir chat da Nay".',
        en: 'The floating window opens compact, and the Nay button shows a menu with the minimized call (resume, end) and "Open Nay chat".',
      },
    ],
  },
  '2.172.1': {
    features: [
      {
        pt: 'OpenCode: troque de modelo no meio da conversa pelo menu Modelo, com a lista do próprio OpenCode (inclusive os gratuitos); o rodapé mostra o modelo que está rodando de verdade.',
        en: 'OpenCode: switch models mid-conversation from the Model menu, with OpenCode\'s own list (free models included); the footer shows the model really running.',
      },
      {
        pt: 'OpenCode com os quatro modos: Padrão, Aceitar edições, Plano e Sem perguntas.',
        en: 'OpenCode with all four modes: Default, Accept edits, Plan and No questions.',
      },
      {
        pt: 'Quando o OpenCode precisa de uma versão mais nova (os modelos gratuitos pedem a 1.18.0), um botão "Atualizar o OpenCode" faz a atualização em um clique.',
        en: 'When OpenCode needs a newer version (free models need 1.18.0), an "Update OpenCode" button updates it in one click.',
      },
      {
        pt: 'O OpenCode aparece com o próprio logo em todo o app.',
        en: 'OpenCode shows its own logo across the app.',
      },
    ],
    fixes: [
      {
        pt: 'Uma sessão do OpenCode não fica mais "trabalhando" para sempre quando o modelo não responde (por exemplo, um Ollama desligado): o app para a tentativa e explica o que fazer.',
        en: 'An OpenCode session no longer stays "working" forever when its model does not answer (for example, Ollama turned off): the app stops the attempt and explains what to do.',
      },
      {
        pt: 'Uma resposta recusada pelo modelo aparece no chat com o motivo, em vez de não aparecer nada.',
        en: 'A reply the model refused now shows in the chat with the reason, instead of nothing.',
      },
      {
        pt: 'O cartão "Iniciando…" de uma sessão nova não fica mais girando depois que a sessão já abriu.',
        en: 'The "Starting…" card of a new session no longer keeps spinning after the session has opened.',
      },
      {
        pt: 'O OpenCode instalado pelo instalador oficial é encontrado mesmo quando o app roda como serviço.',
        en: 'OpenCode installed by its official installer is found even when the app runs as a service.',
      },
    ],
  },
  '2.172.0': {
    features: [
      {
        pt: 'Interfaces de motores podem acompanhar você em uma janela flutuante ao sair da sessão. Minimize no botão da Nay e retome sem interromper o que está rodando.',
        en: 'Engine interfaces can follow you in a floating window when you leave a session. Minimize onto the Nay button and restore without interrupting what is running.',
      },
      {
        pt: 'A aba Sessões do painel flutuante da Nay pode receber seções de motores habilitados.',
        en: 'The Sessions tab of the floating Nay panel can show sections from enabled engines.',
      },
    ],
    fixes: [
      {
        pt: 'Mensagens suas enviadas por uma interface agora aparecem na conversa, sem as instruções internas.',
        en: 'Your messages sent through an interface now appear in the conversation, without internal instructions.',
      },
    ],
  },
  '2.171.0': {
    features: [
      {
        pt: 'OpenCode no app: abra sessões do OpenCode como as dos outros assistentes, com o chat ao vivo, aprovações, cancelar, reabrir a mesma conversa e o modo plano.',
        en: 'OpenCode in the app: open OpenCode sessions like the other assistants, with live chat, approvals, cancel, reopening the same conversation and plan mode.',
      },
      {
        pt: 'O OpenCode usa a sua própria configuração, inclusive provedores e chaves de API próprios definidos no opencode.json.',
        en: 'OpenCode uses your own configuration, including custom providers and API keys set in opencode.json.',
      },
      {
        pt: 'Com uma versão antiga do OpenCode, o app explica em palavras simples o que atualizar.',
        en: 'With an old OpenCode version, the app explains in plain words what to update.',
      },
    ],
    fixes: [
      {
        pt: 'Uso → Agora mostra "Carregando" enquanto o app ainda está subindo, em vez de dizer que não há histórico, e tenta de novo sozinho se a leitura falhar.',
        en: 'Usage → Now shows "Loading" while the app is still starting instead of saying there is no history, and retries on its own if the read fails.',
      },
    ],
  },
  '2.170.3': {
    features: [],
    fixes: [
      {
        pt: 'O cabeçalho da sessão, logo abaixo das abas, fica arredondado só nos dois cantos da esquerda; os da direita voltam a ser retos.',
        en: 'The session header, just below the tabs, rounds only its two left corners; the right ones are square again.',
      },
      {
        pt: "'Continuar em outra conta' volta a funcionar para um líder registrado numa subtarefa; antes a nova sessão era recusada e nada começava.",
        en: "'Continue on another account' works again for a leader filed on a subtask; before, the new session was refused and nothing started.",
      },
    ],
  },
  '2.170.2': {
    features: [],
    fixes: [
      {
        pt: 'Quando o login de uma conta expira, aparece um aviso acima do campo de mensagem com "Refazer login" e "Trocar de conta"; ele só some quando você entra de novo ou troca de conta.',
        en: 'When an account\'s login expires, a notice above the message box offers "Sign in again" and "Switch account"; it only goes away once you sign in again or switch accounts.',
      },
      {
        pt: 'Refazer login mantém a mesma conta (apelido, plano e histórico), sem precisar remover e adicionar de novo; em Uso → Contas a conta mostra "Login expirado" com o botão.',
        en: 'Signing in again keeps the same account (nickname, plan and history), with no need to remove and re-add it; Usage → Accounts marks it "Login expired" with the button.',
      },
      {
        pt: 'Uma conta com login expirado nunca é escolhida para abrir sessão, trocar de conta ou na troca automática.',
        en: 'An account whose login expired is never picked to open a session, to switch to, or by the automatic switch.',
      },
      {
        pt: 'O botão de passar a liderança volta a responder: "Pedir de novo" e "Lembrar" funcionam sem leitura de uso, e durante a passagem o painel mostra só "Passagem em andamento".',
        en: 'The hand-off button responds again: "Ask again" and "Remind me" work without a usage reading, and during a hand-off the panel shows only "Hand-off in progress".',
      },
    ],
  },
  '2.170.1': {
    features: [],
    fixes: [
      {
        pt: "Trocar para 'Sem perguntas' agora abre uma confirmação explicando o risco; nada mais aparece embaixo da barra ao trocar de modo.",
        en: "Switching to 'No questions' now opens a confirmation explaining the risk; nothing else shows under the bar when you change mode.",
      },
      {
        pt: 'O cabeçalho da sessão, logo abaixo das abas, agora tem os quatro cantos arredondados, como os outros painéis.',
        en: 'The session header, just below the tabs, now has all four corners rounded, like the other panels.',
      },
    ],
  },
  '2.170.0': {
    features: [
      {
        pt: 'Uma sessão que para no limite de uso passa sozinha para outra conta com folga, continua a mesma conversa e reenvia a mensagem recusada; se nenhuma conta tiver folga, ela continua sozinha quando o limite renovar. Cada troca deixa um aviso e um comentário na tarefa. Dá para desligar em Configurações → Sessões.',
        en: 'A session stopped on a usage limit moves on its own to another account with room, keeps the same conversation and re-sends the refused message; when no account has room, it carries on by itself once the limit resets. Each move leaves a notice and a comment on the task. You can turn it off in Settings → Sessions.',
      },
      {
        pt: 'A passagem de líder abre o sucessor numa conta com folga, nunca na conta que já bateu no limite.',
        en: 'A leader hand-off opens the successor on an account with room, never on the one that already hit its limit.',
      },
      {
        pt: 'Fluxos (experimental): toda abertura de worker passa por um portão que explica em palavras simples quando recusa; a passagem de líder ganha um documento gerado do quadro e dos seus pedidos abertos; um pedido novo seu com o líder ocupado entra em paralelo, na fila ou agora, sem trocar o trabalho em andamento.',
        en: 'Flows (experimental): every worker spawn goes through a gate that says in plain words why it refuses; a leader hand-off gets a document generated from the board and your open requests; a new request of yours with a busy leader goes in parallel, to the queue or now, without replacing work in progress.',
      },
    ],
    fixes: [],
  },
  '2.169.1': {
    features: [],
    fixes: [
      {
        pt: 'Os campos de mensagem, de resposta e de comentário não mostram mais uma barra de rolagem quando estão vazios ou com pouco texto; ela só aparece quando o texto passa da altura máxima.',
        en: 'The message, reply and comment fields no longer show a scrollbar when empty or short; it only appears once the text is taller than the field\'s limit.',
      },
      {
        pt: 'O canto de cima à esquerda do cabeçalho da sessão, logo abaixo das abas, voltou a ser arredondado.',
        en: 'The top-left corner of the session header, just below the tabs, is rounded again.',
      },
    ],
  },
  '2.169.0': {
    features: [
      {
        pt: 'Motores podem colocar um botão de ícone no campo de mensagem, ao lado do microfone (engine-api 1.18).',
        en: 'Engines can add an icon button to the message box, next to the microphone (engine-api 1.18).',
      },
      {
        pt: 'Interfaces de motores podem abrir embutidas logo acima do campo de mensagem, sem moldura do app, e alternar entre embutida, lateral e tela cheia (engine-api 1.18).',
        en: 'Engine interfaces can open inline right above the message box, without the app frame, and switch between inline, side and full screen (engine-api 1.18).',
      },
      {
        pt: 'O botão de ícone de uma interface de motor no campo de mensagem agora mostra um estado ativo enquanto ela está aberta, e clicar nele a fecha (engine-api 1.18).',
        en: 'An engine interface\'s icon button in the message box now shows an active state while it is open, and clicking it closes it (engine-api 1.18).',
      },
      {
        pt: 'Motores podem pôr um ícone na barra de navegação, junto das páginas, que abre a interface deles como uma página do app, com endereço próprio (no celular, no menu Mais) (engine-api 1.18).',
        en: 'Engines can add an icon to the navigation bar, next to the pages, that opens their interface as a page of the app with its own address (on a phone, in the More menu) (engine-api 1.18).',
      },
      {
        pt: 'Uma interface de motor pode continuar rodando fora da tela quando você sai dela, e mostrar uma pílula com cronômetro na barra do topo, em qualquer tela, que leva de volta a ela (engine-api 1.18).',
        en: 'An engine interface can keep running off screen when you leave it, and show a pill with a timer in the top bar, on any screen, that takes you back to it (engine-api 1.18).',
      },
    ],
    fixes: [],
  },
  '2.168.2': {
    features: [],
    fixes: [
      {
        pt: 'Mensagens que uma sessão manda para outra (inclusive o relatório de um ajudante) não aparecem mais no chat como se fossem pedidos seus.',
        en: 'Messages one session sends to another (including a helper\'s report) no longer show up in the chat as if they were your own requests.',
      },
    ],
  },
  '2.168.1': {
    features: [],
    fixes: [
      {
        pt: 'O botão de enviar não pula mais para a esquerda quando você começa a digitar.',
        en: 'The send button no longer jumps to the left when you start typing.',
      },
      {
        pt: 'Na barra embaixo do campo, o modelo e o modo viraram texto com um ícone pequeno, sem os botões grandes.',
        en: 'In the bar below the field, the model and the mode are now text with a small icon instead of big buttons.',
      },
      {
        pt: 'A barra embaixo do campo mostra o modelo de verdade da sessão (o mesmo do cartão de detalhes), e não "Modelo" nem uma versão antiga.',
        en: 'The bar below the field shows the session\'s real model (the same as the details card), not "Model" or an older version.',
      },
    ],
  },
  '2.168.0': {
    features: [
      {
        pt: 'Fluxos automáticos (experimental): trabalho sem commit há mais de 30 minutos gera um aviso na tarefa e segura a passagem de liderança; todo pedido seu vira um item aberto até ser ligado a uma tarefa, e o líder é lembrado se esquecer.',
        en: 'Automatic flows (experimental): work left uncommitted for over 30 minutes raises a notice on the task and holds the leader hand-off; every request of yours becomes an open item until it is linked to a task, and the leader is reminded if it forgets.',
      },
    ],
    fixes: [
      {
        pt: 'O tipo de uma sessão aberta por um líder (líder ou ajudante) não se perde mais quando várias sessões abrem ao mesmo tempo, e as sessões ajudantes continuam ligadas ao líder quando ele é reaberto.',
        en: 'The type of a session opened by a leader (leader or worker) is no longer lost when several sessions open at once, and worker sessions stay linked to their leader when it is reopened.',
      },
    ],
  },
  '2.167.0': {
    features: [
      {
        pt: 'O campo de mensagem ganhou uma barra embaixo: o modelo (clique para trocar modelo e esforço), o modo da sessão, o contexto, o contador de caracteres e o histórico. O texto da conversa não aparece mais abaixo do campo.',
        en: 'The message field has a bar below it: the model (click to change model and effort), the session mode, the context, the character count and the history. Conversation text no longer shows below the field.',
      },
    ],
    fixes: [
      {
        pt: 'A janela "Continuar em outra conta" não fica mais escondida atrás da barra lateral; o chat da Nay continua por cima.',
        en: 'The "Continue on another account" window no longer hides behind the sidebar; the Nay chat stays on top.',
      },
      {
        pt: 'O painel de informações da sessão (o "i" no topo) também ganhou o vidro.',
        en: 'The session info panel (the "i" at the top) gets the glass too.',
      },
    ],
  },
  '2.166.0': {
    features: [
      {
        pt: 'A lista de sessões carrega muito mais leve no VS Code e nas ferramentas dos assistentes (MCP), que ainda pediam a versão completa.',
        en: 'The session list loads much lighter in VS Code and in the assistants\' tools (MCP), which still asked for the full version.',
      },
    ],
    fixes: [],
  },
  '2.165.3': {
    features: [
      {
        pt: 'As instruções que cada sessão recebe agora seguem o estado: no modo ausente somem os "pergunte antes", workers não recebem blocos de líder, e um teste impede que duas regras se contradigam.',
        en: 'The instructions each session receives now follow the state: in away mode the "ask first" lines go away, workers get no leader blocks, and a test keeps two rules from contradicting each other.',
      },
      {
        pt: 'A passagem de liderança chega ao sucessor como aviso do sistema, curta e com as ordens vigentes do dono no topo.',
        en: 'A leader hand-off reaches the successor as a system notice, short and with the owner\'s standing orders on top.',
      },
    ],
    fixes: [
      {
        pt: 'O vidro ficou visível também no tema claro e um pouco mais transparente no escuro; o chat flutuante da Nay continua sólido.',
        en: 'Glass is now visible in the light theme too and a little more see-through in the dark one; the Nay floating chat stays solid.',
      },
      {
        pt: 'Passagens de bastão, relays entre sessões e instruções carregadas pelo Codex aparecem como avisos do sistema, e não mais como mensagens suas.',
        en: 'Leader hand-offs, relays between sessions and Codex-loaded instructions now appear as system notices instead of looking like messages you wrote.',
      },
      {
        pt: 'O rodapé da lista ficou mais limpo, sem o botão Ajustes repetido.',
        en: 'The list footer is cleaner, without the repeated Settings button.',
      },
    ],
  },
  '2.165.2': {
    features: [],
    fixes: [
      {
        pt: 'Atualização do motor.',
        en: 'Engine update.',
      },
    ],
  },
  '2.165.1': {
    features: [],
    fixes: [
      {
        pt: 'O vidro voltou ao visual fosco original e só aparece em menus, dropdowns, gavetas laterais e no campo de mensagem; cabeçalhos, cards e campos voltam ao sólido.',
        en: 'Glass is back to the original frosted look and only on menus, dropdowns, side drawers and the message box.',
      },
    ],
  },
  '2.165.0': {
    features: [
      {
        pt: 'Motores podem agir na sessão em que um painel foi aberto (engine-api 1.17).',
        en: 'Engines can act on the session a panel was opened from (engine-api 1.17).',
      },
    ],
    fixes: [],
  },
  '2.164.1': {
    features: [],
    fixes: [
      {
        pt: 'Quando a conexão de um assistente cai, a sessão só avisa a falha depois que o processo dele parou de verdade.',
        en: "When an assistant's connection drops, the session reports the failure only after its process has really stopped.",
      },
    ],
  },
  '2.164.0': {
    features: [
      {
        pt: 'Fluxos (experimental): ligue a opção experimental para conferir uma sessão ou fazer uma limpeza de teste com passos claros, sem apagar nada.',
        en: 'Flows (experimental): turn on the experimental option to check a session or preview cleanup with clear steps, without deleting anything.',
      },
    ],
    fixes: [
      {
        pt: 'Atualização do motor.',
        en: 'Engine update.',
      },
    ],
  },
  '2.163.2': {
    features: [],
    fixes: [
      {
        pt: 'Atualização do motor.',
        en: 'Engine update.',
      },
    ],
  },
  '2.163.1': {
    features: [],
    fixes: [
      {
        pt: 'Sessões que rodam com o login de outra conta agora mostram quanto do contexto já usaram.',
        en: "Sessions running on another account's sign-in now show their context usage.",
      },
    ],
  },
  '2.163.0': {
    features: [
      {
        pt: 'Motores podem adicionar os próprios botões e painéis ao app (engine-api 1.15).',
        en: 'Engines can add their own buttons and panels to the app (engine-api 1.15).',
      },
    ],
    fixes: [],
  },
  '2.162.0': {
    features: [
      {
        pt: 'Vidro: menus, popovers, janelas, avisos, o sino, o painel da Nay, as barras fixas e o campo de mensagem ganham um vidro fosco que deixa ver, desfocado, o que passa por trás.',
        en: 'Glass: menus, popovers, dialogs, toasts, the bell, the Nay panel, the sticky bars and the message box get a frosted glass that shows what passes behind them, blurred.',
      },
      {
        pt: 'Campos de texto e os cards de sessões, tarefas e contas ganham um acabamento acrílico leve, sem pesar no celular.',
        en: 'Text fields and the session, task and account cards get a light acrylic finish that stays light on phones.',
      },
      {
        pt: 'Dá para ligar e desligar em Configurações → Preferências → Exibição → "Vidro (experimental)"; vale para cada aparelho.',
        en: 'Turn it on or off in Settings → Preferences → Display → "Glass (experimental)"; the choice is per device.',
      },
    ],
    fixes: [],
  },
  '2.161.9': {
    features: [],
    fixes: [
      {
        pt: 'Mensagens que outra sessão ou um subagente manda para a sua conversa não aparecem mais como se fossem suas: elas saem marcadas como aviso, e só o que você digitou vira mensagem sua.',
        en: 'Messages another session or a sub-agent sends into your conversation no longer show up as if you wrote them: they are marked as notices, and only what you typed becomes your message.',
      },
    ],
  },
  '2.161.8': {
    features: [],
    fixes: [
      {
        pt: 'O quadro "Uso dos planos" abre centrado logo acima do próprio botão, sem sair da tela, com a setinha apontando para ele.',
        en: 'The "Plan usage" panel opens centred right above its own button, inside the screen, with its arrow pointing at it.',
      },
    ],
  },
  '2.161.7': {
    features: [],
    fixes: [
      {
        pt: '"Adicionar conta" agora oferece todo assistente instalado no computador, mesmo um que você ainda nunca usou pelo agentistics — no Mac, o Codex instalado pelo Homebrew passa a aparecer.',
        en: '"Add account" now offers every assistant installed on the computer, even one you have never used through agentistics — on a Mac, a Codex installed with Homebrew now shows up.',
      },
      {
        pt: 'Quando um assistente não pode ser conectado, a tela diz o motivo e oferece "Procurar de novo", em vez de simplesmente não mostrar a opção.',
        en: 'When an assistant cannot be signed in, the screen says why and offers "Look again", instead of just not showing the option.',
      },
    ],
  },
  '2.161.6': {
    features: [],
    fixes: [
      {
        pt: 'O plano de uma conta nova é gravado ao clicar em Salvar, mesmo quando ele veio preenchido sozinho e você não mexeu em nada.',
        en: 'A new account\'s plan is saved when you click Save, even when it was filled in for you and you changed nothing.',
      },
      {
        pt: 'Uma conta com o plano detectado mas ainda não confirmado mostra "Detectado: … · confirme" e um botão "Confirmar plano", em vez de "Sem plano".',
        en: 'An account whose plan was detected but not yet confirmed shows "Detected: … · confirm" and a "Confirm plan" button, instead of "No plan".',
      },
    ],
  },
  '2.161.5': {
    features: [],
    fixes: [
      {
        pt: 'No Mac, o agentistics agora confere o login do Claude no mesmo lugar onde ele foi feito, então a conta aparece depois de "Login successful".',
        en: 'On a Mac, agentistics now checks the Claude sign-in in the same place it was made, so the account shows up after "Login successful".',
      },
      {
        pt: 'Se o Claude entrar e o agentistics ainda não conseguir ler o login, a janela diz exatamente isso (e não mais "não foi salvo") e oferece "Verificar de novo", que confere outra vez sem pedir um novo código.',
        en: 'If Claude signs in and agentistics still cannot read the sign-in, the dialog says exactly that (no longer "not saved") and offers "Verify again", which checks once more without asking for a new code.',
      },
    ],
  },
  '2.161.4': {
    features: [],
    fixes: [
      {
        pt: 'Cada sessão é contada na mesma conta em todas as telas e cálculos de uso, mesmo quando ela foi aberta sem escolher uma conta.',
        en: 'Each session is counted against the same account on every usage screen and calculation, even when it was started without choosing an account.',
      },
      {
        pt: 'O cálculo de quantas sessões ainda cabem em cada plano agora conta também as sessões sem conta definida, usando o gasto médio do assistente, em vez de prometer vagas que não existem.',
        en: 'The count of how many more sessions fit in each plan now includes sessions with no account set, using the assistant\'s average burn, instead of promising room that is not there.',
      },
      {
        pt: 'Pedir para trocar uma sessão para a conta em que ela já está não abre mais uma troca desnecessária.',
        en: 'Asking to switch a session to the account it is already on no longer starts a needless switch.',
      },
    ],
  },
  '2.161.3': {
    features: [],
    fixes: [
      {
        pt: 'Ao adicionar uma conta do Claude, o código certo não é mais recusado como "código inválido" quando o login demora alguns segundos para confirmar.',
        en: 'When adding a Claude account, the right code is no longer refused as "invalid code" when the sign-in takes a few seconds to confirm.',
      },
      {
        pt: 'O campo do código fica oculto enquanto você cola (com um botão de olho para ver) e o navegador não oferece mais salvá-lo como senha.',
        en: 'The code field stays hidden while you paste (with an eye button to show it) and the browser no longer offers to save it as a password.',
      },
      {
        pt: '"Entrar" no aviso "Claude Code instalado, sem login" e "Entrar agora" depois de instalar abrem a janela de adicionar conta, em vez de uma sessão vazia que fechava na hora.',
        en: '"Sign in" on the "Claude Code installed, not signed in" notice and "Sign in now" after installing open the add-account dialog, instead of an empty session that closed at once.',
      },
    ],
  },
  '2.161.2': {
    features: [],
    fixes: [
      {
        pt: 'Ao adicionar uma conta, o código colado é enviado de verdade ao assistente; se ele recusar, a janela mostra na hora o que ele respondeu, com "Tentar de novo", em vez de ficar esperando para sempre.',
        en: 'When adding an account, the pasted code really reaches the assistant; if it refuses it, the dialog shows right away what it answered, with "Try again", instead of waiting forever.',
      },
      {
        pt: 'No macOS, se o login terminou mas a conta não apareceu, a janela explica o motivo: o macOS não deixou o agentistics ler o login (Acesso às Chaves → Permitir sempre) ou o login não foi salvo.',
        en: 'On macOS, when the sign-in finished but no account appeared, the dialog says why: macOS did not let agentistics read the sign-in (Keychain Access → Always Allow) or the sign-in was not saved.',
      },
      {
        pt: 'Um assistente instalado sem login não aparece mais como se fosse uma conta com plano: vira o aviso "Claude Code instalado, sem login", com Entrar e um × para esconder.',
        en: 'An assistant installed without a sign-in no longer looks like an account with a plan: it becomes the notice "Claude Code installed, not signed in", with Sign in and an × to hide it.',
      },
    ],
  },
  '2.161.1': {
    features: [],
    fixes: [
      {
        pt: 'Uma tentativa de login que expirou ou se perdeu não mostra mais "Esta conta já não existe": aparece "O login expirou" com "Tentar de novo", que começa um login novo.',
        en: 'A sign-in attempt that expired or got lost no longer shows "This account no longer exists": it says "The sign-in expired" with "Try again", which starts a new sign-in.',
      },
      {
        pt: 'A janela de adicionar conta ficou mais clara: três passos numerados, botões "Abrir página de login" e "Copiar link" no lugar do link enorme, e Cancelar discreto.',
        en: 'The add-account dialog is clearer: three numbered steps, "Open sign-in page" and "Copy link" buttons instead of the huge link, and a quiet Cancel.',
      },
    ],
  },
  '2.161.0': {
    features: [
      {
        pt: 'No fim da instalação pelo terminal, o instalador pergunta se você quer iniciar o agentistics agora e se ele deve iniciar sozinho quando o computador ligar (sim é o padrão nas duas), já com as configurações recomendadas.',
        en: 'At the end of the terminal install, the installer asks whether to start agentistics now and whether it should start by itself when the computer starts (yes is the default for both), already with the recommended settings.',
      },
    ],
    fixes: [
      {
        pt: 'Adicionar uma conta do Claude Code não fica mais "Esperando você entrar..." para sempre depois de colar o código: a conta aparece com o e-mail ou um erro claro aparece na tela.',
        en: 'Adding a Claude Code account no longer stays on "Waiting for you to sign in..." forever after pasting the code: the account shows up with its email, or a clear error appears.',
      },
      {
        pt: 'O campo do código de login não é mais tratado como senha pelo navegador, e Enter envia o código.',
        en: 'The browser no longer treats the login code field as a password, and Enter submits the code.',
      },
      {
        pt: 'Sem login no assistente, a tela de contas mostra "Não conectado" em vez de uma conta que não existe.',
        en: 'With no sign-in on the assistant, the accounts screen shows "Not connected" instead of an account that does not exist.',
      },
    ],
  },
  '2.160.3': {
    features: [
      {
        pt: 'Várias contas agora vem ligado: numa instalação nova já dá para entrar em outra conta de um assistente pela tela de contas.',
        en: 'Multiple accounts is now on by default: a fresh install can sign in to another account of an assistant from the accounts screen.',
      },
    ],
    fixes: [
      {
        pt: 'A instalação pelo terminal funciona com sh, bash, zsh ou fish e já coloca o agentop no caminho do seu terminal (no Mac, no .zshrc), sem passo manual.',
        en: 'The terminal install works with sh, bash, zsh or fish and puts agentop on your terminal’s path by itself (on a Mac, in .zshrc), with no manual step.',
      },
      {
        pt: 'Todo plano cadastrado pode ser removido pelo lápis da conta, inclusive um que começa depois ou um "Não sei agora"; planos de contas que saíram da lista aparecem para remover.',
        en: 'Every registered plan can be removed from the account’s pencil, including one that starts later or a "Not sure yet" one; plans of accounts that left the list show up so you can remove them.',
      },
      {
        pt: 'A aba Cobrança saiu das Configurações: o plano de cada conta fica no lápis da linha, em Uso → Contas.',
        en: 'The Billing tab left Settings: each account’s plan is on its row’s pencil in Usage → Accounts.',
      },
      {
        pt: 'Testes isolados não derrubam mais o navegador de testes por causa de um caminho temporário longo demais.',
        en: 'Isolated test runs no longer crash the test browser because of a temporary path that was too long.',
      },
    ],
  },
  '2.160.2': {
    features: [],
    fixes: [
      {
        pt: 'Clicar em "Sessões" no menu volta a abrir a lista de sessões, em vez de levar para a página de Uso.',
        en: 'Clicking "Sessions" in the menu opens the sessions list again instead of taking you to the Usage page.',
      },
      {
        pt: 'As sessões de exemplo do modo demonstração não mostram mais os caminhos reais das suas pastas.',
        en: 'The sample sessions in demo mode no longer show the real paths of your folders.',
      },
    ],
  },
  '2.160.1': {
    features: [],
    fixes: [
      {
        pt: 'Uma sessão reiniciada em outra conta agora mostra a mesma conta em todo lugar: o círculo de informações do campo de mensagem, a janela de troca de conta e os limites deixaram de apontar contas diferentes.',
        en: 'A session restarted on another account now shows the same account everywhere: the message box info chip, the switch-account dialog and the limits no longer point at different accounts.',
      },
    ],
  },
  '2.160.0': {
    features: [
      {
        pt: 'Depois de instalar um assistente, a própria janela de instalação oferece "Entrar agora" quando ainda falta entrar na conta dele, sem precisar ir até Configurações.',
        en: 'After installing an assistant, the install dialog itself offers "Sign in now" when you still need to sign in to it, without going to Settings.',
      },
    ],
    fixes: [],
  },
  '2.159.5': {
    features: [],
    fixes: [
      {
        pt: 'O menu da lista de abas de sessão ficou mais estreito e ganhou um fundo de vidro fosco, na mesma cor de antes.',
        en: 'The session tabs list menu is narrower and now has a frosted-glass background in the same colour as before.',
      },
      {
        pt: 'Clicar de novo no botão da lista de abas com o menu aberto agora fecha o menu, em vez de abri-lo outra vez.',
        en: 'Clicking the tabs list button again while its menu is open now closes the menu instead of reopening it.',
      },
    ],
  },
  '2.159.4': {
    features: [],
    fixes: [
      {
        pt: 'Instalar o Claude Code (e os outros assistentes) pelo agentistics não falha mais no meio do download no macOS: a conexão não cai mais quando o instalador fica um tempo sem escrever nada.',
        en: 'Installing Claude Code (and the other assistants) from agentistics no longer fails mid-download on macOS: the connection no longer drops while the installer is quiet.',
      },
      {
        pt: 'Quando uma instalação falha, a janela mostra o motivo real (por exemplo, o erro do instalador) em vez de sempre pedir para verificar a internet.',
        en: 'When an install fails, the dialog shows the real reason (for example, the installer error) instead of always asking you to check your internet.',
      },
    ],
  },
  '2.159.3': {
    features: [],
    fixes: [
      {
        pt: 'No celular, o botão flutuante do Nay não cobre mais o fim do eixo dos gráficos na página Uso.',
        en: 'On phones, the floating Nay button no longer covers the end of the chart axes on the Usage page.',
      },
      {
        pt: 'Ao abrir Sessões direto, a lista mostra "Lendo as sessões…" até a primeira resposta chegar, em vez de dizer por alguns segundos que não há sessões.',
        en: 'Opening Sessions directly now shows "Reading this machine’s sessions…" until the first answer arrives, instead of briefly claiming there are no sessions.',
      },
      {
        pt: 'Na tabela do Agentask, removido um pontinho perdido na primeira coluna.',
        en: 'In the Agentask table, removed a stray dot in the first column.',
      },
    ],
  },
  '2.159.2': {
    features: [],
    fixes: [
      {
        pt: 'No celular, as atualizações ao vivo travam menos o toque: o painel recalcula as métricas em segundo plano e deixa de tentar guardar uma cópia local grande demais a cada mudança.',
        en: 'On phones, live updates block taps less: the dashboard recomputes metrics in the background and stops trying to save a local copy that is too big on every change.',
      },
      {
        pt: 'No celular, o card de Tokens ficou compacto, os ícones dos cards não ficam mais sob o botão flutuante do Nay e o conteúdo não aparece mais pelo recorte da barra inferior ao lado do botão central.',
        en: 'On phones, the Tokens card is compact, card icons are no longer under the floating Nay button, and content no longer shows through the bottom bar cut-out beside the centre button.',
      },
    ],
  },
  '2.159.1': {
    features: [
      {
        pt: 'No celular, o botão redondo do centro agora é um ícone de chat e abre Sessões; dentro de Sessões ele mostra o ícone da área de onde você veio e leva de volta à página que estava aberta.',
        en: 'On phones, the round centre button is now a chat icon that opens Sessions; inside Sessions it shows the icon of the area you came from and takes you back to the page you had open.',
      },
    ],
    fixes: [
      {
        pt: 'Os cards de Métricas ficaram compactos no celular: título e ícones na mesma linha, valor logo abaixo e legenda em até duas linhas.',
        en: 'Metrics cards are compact on phones: title and icons on one line, the value right below and the caption on up to two lines.',
      },
    ],
  },
  '2.159.0': {
    features: [
      {
        pt: 'Uso agora tem uma única tela, com limites separados por conta, cores distintas, comparação por harness e mensagens por dia da semana e hora. Os momentos de maior consumo mostram quanto foi usado e em quanto tempo.',
        en: 'Usage now has one screen, with limits separated by account, distinct colors, harness comparisons and messages by weekday and hour. The busiest moments show how much was used and how long it took.',
      },
      {
        pt: 'O menu de ícones inclui Ajustes e abre sobre a página ao passar o ponteiro, sem deslocar o conteúdo.',
        en: 'The icon menu includes Settings and opens over the page on hover, without shifting the content.',
      },
      {
        pt: 'Uso lista suas contas em linhas compactas: nome, harness e plano, os dois círculos de uso (5 h e semana), a chave de uso por agentes e um lápis para editar.',
        en: 'Usage lists your accounts as compact rows: name, harness and plan, the two usage rings (5 h and week), the agent-use switch and a pencil to edit.',
      },
      {
        pt: 'O lápis abre a edição daquela conta: apelido, plano, preço, datas, planos anteriores, uso por agentes e o paralelo recomendado.',
        en: 'The pencil opens that account’s editor: nickname, plan, price, dates, earlier plans, agent use and the recommended parallel count.',
      },
      {
        pt: 'Cobrança agora fica em Uso. Ajustes → Cobrança e "Ajustar limites" levam para a lista de contas; as páginas Planejar e Limites saíram.',
        en: 'Billing now lives in Usage. Settings → Billing and "Adjust limits" take you to the accounts list; the Plan and Limits pages are gone.',
      },
    ],
    fixes: [
      {
        pt: 'Menu do celular bem mais rápido: trocar de área pela barra de baixo e abrir o menu "Mais" não trava mais a tela.',
        en: 'Much faster phone menu: switching areas from the bottom bar and opening "More" no longer freezes the screen.',
      },
      {
        pt: 'Gráficos de uso têm cores mais fáceis de distinguir e linhas sem oscilações de leituras conflitantes. Contas sem histórico usam um marcador cinza.',
        en: 'Usage charts have easier-to-distinguish colors and lines without oscillations from conflicting readings. Accounts without history use a grey marker.',
      },
      {
        pt: 'No celular, a chave Agentes responde ao toque em toda a área do botão. O menu de áreas também abre ao navegar pelo teclado.',
        en: 'On phones, the Agents switch responds across its full button area. The area menu also opens during keyboard navigation.',
      },
      {
        pt: 'O gráfico semanal identifica os dias, o uso por hora tem um título e as datas de Métricas seguem o idioma escolhido.',
        en: 'The weekly chart identifies the days, hourly usage has a title and Metrics dates follow the chosen language.',
      },
    ],
  },
  '2.158.0': {
    features: [
      {
        pt: 'Uso abre direto nos gráficos: limites ao longo do tempo, horários de uso e picos, com filtro para ver tudo sobreposto, um harness ou uma conta.',
        en: 'Usage opens straight on the charts: limits over time, hours of use and peaks, with a filter for everything overlaid, one harness or one account.',
      },
      {
        pt: 'Menu numa barra só: ao abrir, a própria barra de ícones cresce com os nomes. Métricas vem primeiro, Sessões em segundo, e clicar em Sessões abre os gráficos de uso.',
        en: 'One menu bar: opening it grows the icon bar itself into labels. Metrics comes first, Sessions second, and clicking Sessions opens the usage charts.',
      },
      {
        pt: 'Cada conta no Uso dos planos tem uma chave "Uso por agentes" para liberar ou bloquear o uso por agentes.',
        en: 'Each account in plan usage has an "Agent use" switch to allow or block use by agents.',
      },
      {
        pt: '"Nova pasta" virou "Novo grupo" e abre as opções logo abaixo do botão.',
        en: '"New folder" is now "New group" and opens its options right below the button.',
      },
    ],
    fixes: [
      {
        pt: 'Encerrar sessão: o aviso "Encerrando…" sai sozinho; se a sessão não parar em 15 segundos, ele diz o que aconteceu e oferece "Tentar de novo".',
        en: 'Ending a session: the "Ending…" notice leaves by itself; if the session has not stopped after 15 seconds it says so and offers "Try again".',
      },
      {
        pt: 'Ao reabrir uma sessão de outra conta, o chat volta a mostrar o histórico.',
        en: 'Reopened sessions on another account show their conversation history again.',
      },
      {
        pt: 'Abas das sessões: a aba ativa se funde ao cabeçalho e o botão da lista de abas fica alinhado aos nomes.',
        en: 'Session tabs: the active tab merges into the header and the open-tabs button lines up with the tab names.',
      },
      {
        pt: 'Celular: o botão do centro abre Sessões, o contador fica acima da pílula e o indicador segue a curva.',
        en: 'Phone: the centre button opens Sessions, the count sits above the pill and the indicator follows its curve.',
      },
      {
        pt: 'O ícone de worker aparece só como ícone, em ciano, alinhado à primeira linha do nome.',
        en: 'The worker icon shows as an icon only, in cyan, aligned with the first line of the name.',
      },
    ],
  },
  '2.157.0': {
    features: [
      {
        pt: 'Na troca de líder, o novo líder pode encerrar o anterior sozinho: ele sai quando termina o que estava fazendo.',
        en: 'On a leader hand-off, the new leader can retire the previous one by itself: it closes once it finishes what it was doing.',
      },
    ],
    fixes: [],
  },
  '2.156.0': {
    features: [
      {
        pt: 'Uso: o Antigravity agora mostra sua cota da semana, separada para modelos Gemini e para Claude/GPT.',
        en: 'Usage: Antigravity now shows its weekly quota, split between Gemini models and Claude/GPT.',
      },
    ],
    fixes: [
      {
        pt: 'Em Cobrança, cada conta aparece uma vez só; duas contas do mesmo assistente ganham número (#1, #2) e as barras ficam alinhadas.',
        en: 'In Billing each account shows once; two accounts of the same assistant get a number (#1, #2) and the bars line up.',
      },
    ],
  },
  '2.155.0': {
    features: [
      {
        pt: 'O app agora protege o computador: com pouca memória livre, sessões novas e tarefas pesadas esperam, e o sino avisa o que está usando mais memória.',
        en: 'The app now protects the computer: with little free memory, new sessions and heavy jobs wait, and the bell says what is using the most memory.',
      },
    ],
    fixes: [],
  },
  '2.154.0': {
    features: [
      {
        pt: 'Antigravity: a conta logada agora é reconhecida pelo nome.',
        en: 'Antigravity: the signed-in account is now recognised by name.',
      },
    ],
    fixes: [
      {
        pt: 'O app avisa quando o modelo padrão escolhido para o Antigravity saiu da lista dele.',
        en: 'The app warns when the default model picked for Antigravity is no longer in its list.',
      },
      {
        pt: 'Os limites de uso de cada conta não se misturam mais quando um líder roda em outra conta.',
        en: 'Each account\'s usage limits no longer mix when a leader runs on another account.',
      },
      {
        pt: 'O uso de contexto das sessões do Gemini aparece certo no anel e no aviso de passagem.',
        en: 'Gemini sessions show their context use correctly in the ring and the hand-off hint.',
      },
      {
        pt: 'Reabrir uma sessão que caiu não mostra mais um erro técnico: se algo falhar, o app explica em uma frase.',
        en: 'Reopening a session that fell no longer shows a technical error: if something fails, the app says why in one sentence.',
      },
    ],
  },
  '2.153.0': {
    features: [
      {
        pt: 'Na lista de sessões, o worker ganhou um ícone azul de chave e chave de fenda cruzadas, e o papel automático um ícone discreto.',
        en: 'In the sessions list, a worker now has a blue crossed wrench-and-screwdriver icon, and the automatic role a quiet one.',
      },
    ],
    fixes: [
      {
        pt: 'A janela de trocar de conta ficou mais larga: explicação à esquerda, contas à direita, e o topo não é mais cortado.',
        en: 'The switch-account dialog is wider: explanation on the left, accounts on the right, and its top is no longer cut off.',
      },
      {
        pt: 'Uma sessão do chat cujo processo cai agora volta sozinha no modo novo (a mesma conversa), em vez de ir parar no terminal.',
        en: 'A chat session whose process dies now comes back on its own in the new mode (same conversation) instead of ending up in the terminal.',
      },
      {
        pt: 'Sessões que já tinham caído no terminal podem voltar ao modo novo sem perder a conversa.',
        en: 'Sessions that already fell to the terminal can return to the new mode without losing the conversation.',
      },
      {
        pt: 'O chat de uma sessão que trocou de conta continua atualizando (antes ele parava na hora da troca).',
        en: 'The chat of a session that switched accounts keeps updating (it used to stop at the switch).',
      },
      {
        pt: 'Uma cópia de teste do app não encerra mais as sessões reais.',
        en: 'A test copy of the app no longer ends the real sessions.',
      },
      {
        pt: 'Antigravity: a resposta volta a aparecer depois de interromper uma sessão com várias filhas.',
        en: 'Antigravity: the reply shows again after interrupting a session with several children.',
      },
      {
        pt: 'Antigravity: a pergunta "confia nesta pasta?" e outros pedidos de permissão fora do turno agora aparecem como cartão no chat.',
        en: 'Antigravity: the "trust this folder?" prompt and other permission prompts outside a turn now show up as a card in the chat.',
      },
      {
        pt: 'Em "Finalizadas hoje", a mesma sessão não aparece mais duas vezes.',
        en: 'In "Finished today", the same session no longer appears twice.',
      },
      {
        pt: 'A barra de baixo no celular agora tem três peças: dois grupos de botões e o Início num círculo maior no meio, com as pontas curvas em volta dele.',
        en: 'The bottom bar on the phone now has three pieces: two button groups and a bigger round Home button in the middle, with curved ends around it.',
      },
      {
        pt: 'A aba selecionada ganha um destaque grande atrás do ícone e do nome, e o Início acende o próprio círculo.',
        en: 'The selected tab gets a large highlight behind its icon and name, and Home lights up its own circle.',
      },
      {
        pt: 'Tocar em Início sempre volta para a lista de sessões, mesmo vindo do "Resumo da frota".',
        en: 'Tapping Home always returns to the sessions list, even from the "Fleet summary".',
      },
    ],
  },
  '2.152.0': {
    features: [
      {
        pt: 'No celular, a barra de baixo tem cinco abas com Sessões no meio; arraste o dedo para trocar e, em Sessões, o botão vira Início.',
        en: 'On the phone, the bottom bar has five tabs with Sessions in the middle; drag your finger to switch, and on Sessions the button becomes Home.',
      },
      {
        pt: 'Liderança agora fica dentro de Sessões.',
        en: 'Leadership now lives inside Sessions.',
      },
      {
        pt: 'O app atualiza os dados sozinho: saíram a chave "Ao vivo" e o botão "Atualizar". "Atualizar app" só aparece quando há versão nova.',
        en: 'The app refreshes its data on its own: the "Live" switch and the "Refresh" button are gone. "Update app" only shows when a new version exists.',
      },
      {
        pt: 'O Histórico de Uso guarda 14 dias e não some quando o app reinicia; o uso real vira uma linha contínua, fácil de ler no celular.',
        en: 'Usage History keeps 14 days and survives restarts; real usage is a continuous line, easy to read on the phone.',
      },
    ],
    fixes: [
      {
        pt: 'O sino agora avisa sempre que uma sessão é encerrada, e não avisa quando ela só muda de conta ou de assistente.',
        en: 'The bell now always tells you when a session is closed, and stays quiet when it just moves to another account or assistant.',
      },
      {
        pt: 'No Cofre, o que você copia volta a ser apagado da área de transferência depois de 30 segundos.',
        en: 'In the Vault, what you copy is cleared from the clipboard again after 30 seconds.',
      },
      {
        pt: 'No celular, o menu que sobe abre compacto, sem itens repetidos.',
        en: 'On the phone, the menu sheet opens compact, with no repeated items.',
      },
    ],
  },
  '2.151.2': {
    features: [],
    fixes: [
      {
        pt: 'O texto técnico de imagem lida não aparece mais como mensagem sua no chat.',
        en: 'The technical note of a viewed image no longer shows as your message in the chat.',
      },
      {
        pt: 'No chat, as ferramentas que falharam aparecem marcadas também nas sessões do modo novo.',
        en: 'In the chat, tools that failed are now marked in new-mode sessions too.',
      },
    ],
  },
  '2.151.1': {
    features: [
      {
        pt: 'A área Uso ganhou o selo BETA, como o Agentask: as contas foram conferidas, mas a página ainda está mudando.',
        en: 'The Usage area now carries a BETA tag, like Agentask: its math was checked, but the page is still changing.',
      },
    ],
    fixes: [
      {
        pt: 'Plano acima de 100% mostra "Acima do limite" em vez de "restam −5%".',
        en: 'A plan over 100% shows "Over limit" instead of "−5% left".',
      },
      {
        pt: 'Sem ritmo medido, a página diz que ainda não mediu em vez de recomendar 0 de 1 sessão.',
        en: 'With no measured pace, the page says it has not measured yet instead of recommending 0 of 1 session.',
      },
      {
        pt: 'A previsão "acaba ~" não anda mais sozinha entre uma leitura e outra.',
        en: 'The "runs out ~" forecast no longer drifts on its own between readings.',
      },
      {
        pt: 'Cada conta aparece pelo nome, nunca por um código interno.',
        en: 'Every account shows by its name, never by an internal code.',
      },
      {
        pt: 'Planos só apertados (não pausados) voltam a receber sessões, e o aviso não diz mais "todos em pausa".',
        en: 'Plans that are only tight (not paused) get sessions again, and the notice no longer says "all on hold".',
      },
    ],
  },
  '2.151.0': {
    features: [
      {
        pt: 'Nova barra lateral por áreas: Sessões, Agentask, Liderança, Uso, Métricas, Repositórios, Cofre e Ajustes, com busca de páginas (Ctrl K).',
        en: 'A new sidebar by areas: Sessions, Agentask, Leadership, Usage, Metrics, Repositories, Vault and Settings, with page search (Ctrl K).',
      },
      {
        pt: 'Em Sessões, uma coluna de ícones das áreas fica ao lado da lista; o seletor Painel/Sessões saiu.',
        en: 'In Sessions, a column of area icons sits beside the list; the Dashboard/Sessions switch is gone.',
      },
      {
        pt: 'Página Uso: o ritmo de cada plano agora, o plano de sessões até a renovação, os limites e o histórico.',
        en: 'Usage page: each plan\'s pace right now, a session plan until renewal, the limits and the history.',
      },
      {
        pt: 'Página Liderança: líderes, check-ins, passagens e modo ausente num só lugar.',
        en: 'Leadership page: leaders, check-ins, hand-offs and away mode in one place.',
      },
      {
        pt: 'No celular, um botão "onde estou" embaixo abre o menu de áreas.',
        en: 'On a phone, a "where am I" button at the bottom opens the areas menu.',
      },
      {
        pt: 'O cartão "Limites de uso", com a troca de conta da sessão, agora também aparece no painel lateral (aba Métricas) no computador.',
        en: 'The "Usage limits" card, with the session’s account switch, now also appears in the side panel (Metrics tab) on desktop.',
      },
    ],
    fixes: [
      {
        pt: 'Sessões do Antigravity no modo novo continuam depois que o app reinicia.',
        en: 'Antigravity sessions in the new mode carry on after the app restarts.',
      },
      {
        pt: 'Quando chegam muitas notificações de uma vez, elas viram um único resumo, e quem estava fora vê só "N novidades enquanto você estava fora".',
        en: 'When many notifications arrive at once they become a single summary, and coming back shows just "N updates while you were away".',
      },
      {
        pt: 'O título e os botões do topo da sessão não passam mais por cima da linha que separa as abas.',
        en: 'The session title and top buttons no longer cross the line under the tabs.',
      },
      {
        pt: 'Ao encerrar uma sessão, a tela mostra "Encerrando…" até ela sair da lista, também na linha da lista lateral.',
        en: 'Ending a session shows "Ending…" until it leaves the list, on the aside row too.',
      },
      {
        pt: 'O grupo de comandos que ainda está rodando agora pode ser recolhido e continua recolhido.',
        en: 'A running group of commands can now be collapsed and stays collapsed.',
      },
      {
        pt: 'O comando /rename concluído aparece como aviso de sessão renomeada, em vez de uma mensagem com seu avatar.',
        en: 'A completed /rename command appears as a session renamed notice instead of a message with your avatar.',
      },
      {
        pt: 'Ao trocar de conta, os nomes das contas e dos planos ("Claude Pro", "Claude Max 5x") são os mesmos do Uso dos planos.',
        en: 'When switching accounts, account and plan names ("Claude Pro", "Claude Max 5x") now match the Plan usage list.',
      },
      {
        pt: 'No celular, os botões Confirmar e Cancelar da troca de conta ficam sempre visíveis, mesmo com muitas contas.',
        en: 'On a phone, the Confirm and Cancel buttons of the account switch always stay visible, even with many accounts.',
      },
      {
        pt: 'Quando a troca de conta falha, a mensagem mostra só o motivo, sem o texto técnico do final.',
        en: 'When an account switch fails, the message shows only the reason, without the technical text at the end.',
      },
      {
        pt: 'Se a troca de conta falhar e a sessão não voltar na conta de antes, o aviso diz que ela foi encerrada e traz o botão Reabrir.',
        en: 'If an account switch fails and the session does not come back on its previous account, the notice says it was ended and offers a Reopen button.',
      },
      {
        pt: 'Ao levar uma conversa para outro assistente, o resumo não confunde mais o aviso de limite com o estado da conversa.',
        en: 'Moving a conversation to another assistant no longer mistakes a usage-limit notice for the conversation’s state in the summary.',
      },
    ],
  },
  '2.150.0': {
    features: [
      {
        pt: 'Troque a conta da sessão aberta pelo Uso dos planos, com o nome da sessão e da conta à vista.',
        en: 'Switch the open session’s account from Plan usage, with the session and account names in view.',
      },
    ],
    fixes: [
      {
        pt: 'Comandos locais, como /rename, deixam de aparecer como não lidos quando a sessão termina de executá-los.',
        en: 'Local commands such as /rename stop appearing as unread once the session finishes handling them.',
      },
      {
        pt: 'A lista "Caíram" mostra só quedas das últimas 24 horas (as antigas ficam em Encerradas, prontas para reabrir), e sessões já encerradas não oferecem mais "Encerrar sessão".',
        en: 'The "Fell" list only shows falls from the last 24 hours (older ones stay in Ended, ready to reopen), and sessions that already ended no longer offer "End session".',
      },
      {
        pt: 'Quando um líder passa o bastão, o aviso vira "Passagem em andamento", com uma barra mostrando quanto falta para o sucessor assumir e encerrar o líder antigo.',
        en: 'When a leader hands off, the warning becomes "Handoff in progress", with a bar showing how long until the successor takes over and closes the old leader.',
      },
    ],
  },
  '2.149.0': {
    features: [
      {
        pt: 'O indicador de líder no cabeçalho virou uma coroa num círculo com os tokens ao lado, mudando de cor conforme a conversa enche.',
        en: 'The leader indicator in the header is now a crown in a circle with the token count beside it, changing colour as the conversation fills up.',
      },
    ],
    fixes: [],
  },
  '2.148.2': {
    features: [],
    fixes: [
      {
        pt: 'Sessões novas não são mais recusadas por falta de memória quando há memória livre de sobra.',
        en: 'New sessions are no longer refused for memory while plenty is free.',
      },
    ],
  },
  '2.148.1': {
    features: [],
    fixes: [
      {
        pt: 'A limpeza de disco mostra o tamanho real de cada pasta e quanto dá para liberar — antes aparecia 0 B em tudo.',
        en: 'Disk cleanup shows each folder\'s real size and how much can be freed — it used to show 0 B everywhere.',
      },
      {
        pt: 'Os comandos de terminal não mostram mais avisos "refused to follow".',
        en: 'Terminal commands no longer print "refused to follow" warnings.',
      },
    ],
  },
  '2.148.0': {
    features: [
      {
        pt: 'Troque a conta de uma sessão direto pelo cartão "Limites de uso", vendo os limites de cada conta antes de escolher.',
        en: 'Switch a session\'s account right from the "Usage limits" card, seeing every account\'s limits before you pick.',
      },
    ],
    fixes: [
      {
        pt: 'Os ajudantes em segundo plano passam sozinhos para a versão nova depois de uma atualização — o aviso de "programa antigo" não aparece mais.',
        en: 'Background helpers move to the new version by themselves after an update — no more "old binary" notice.',
      },
      {
        pt: 'Testes num ambiente descartável não entram mais em laço infinito quando o bun vem do Volta.',
        en: 'Test runs in a throwaway no longer loop forever when bun comes from Volta.',
      },
    ],
  },
  '2.147.1': {
    features: [],
    fixes: [
      {
        pt: 'O fim de uma atualização não engasga mais nem mostra "Não foi possível falar com o agentistics": enquanto a versão nova lê o seu histórico, a tela de carregamento fica e explica o motivo.',
        en: 'The end of an update no longer stutters or shows "Can\'t reach agentistics": while the new version reads your history, the loading screen stays and says why.',
      },
    ],
  },
  '2.147.0': {
    features: [
      {
        pt: '"Trocar conta" agora deixa escolher a conta e o assistente. Na mesma ferramenta a conversa continua igual; em outro assistente a sessão continua na mesma pasta e tarefa, com um resumo do que foi feito.',
        en: '"Switch account" now lets you pick the account and the assistant. With the same tool the conversation carries on as is; with another assistant the session continues in the same folder and task, with a summary of what was done.',
      },
    ],
    fixes: [],
  },
  '2.146.0': {
    features: [
      {
        pt: '"Sem perguntas" aparece em vermelho no seletor de modo das sessões, com um aviso do risco; os nomes dos modos agora estão em português.',
        en: '"No questions" shows in red in the session mode selector, with a risk warning; mode names now follow your language.',
      },
    ],
    fixes: [
      {
        pt: 'Na visão "só líderes", o cartão de cada líder não mostra mais a seta de abrir a equipe, e tocar no nome abre a sessão do líder.',
        en: 'In the "leaders only" view, each leader card no longer shows the arrow to open its team, and tapping the name opens the leader’s session.',
      },
    ],
  },
  '2.145.2': {
    features: [],
    fixes: [
      {
        pt: 'Ligar o modo ausente avisa todas as sessões quase na hora; uma sessão que não responde não atrasa mais as outras.',
        en: 'Turning on away mode tells every session almost at once; a session that does not answer no longer delays the others.',
      },
      {
        pt: 'Uma sessão externa cuja conversa ou pasta foi apagada pode ser encerrada ou tirada da lista pelo menu dela ("Encerrar" e "Remover da lista").',
        en: 'An external session whose conversation or folder was deleted can be ended or taken off the list from its menu ("End" and "Remove from list").',
      },
    ],
  },
  '2.145.1': {
    features: [],
    fixes: [
      {
        pt: 'O app parado gasta menos processador: a lista de sessões não é mais regravada a cada poucos segundos.',
        en: 'The idle app uses less CPU: the session list is no longer rewritten every few seconds.',
      },
      {
        pt: 'Um repositório que mudou de dono continua valendo para as tarefas que já apontavam para ele: o mesmo nome sob outro dono conta como o mesmo repositório.',
        en: 'A repository that changed owner still counts for the tasks that pointed to it: the same name under another owner is the same repository.',
      },
      {
        pt: '"agentop session list" e "agentop session kill" não imprimem mais avisos internos no meio da resposta.',
        en: '"agentop session list" and "agentop session kill" no longer print internal warnings in the middle of their output.',
      },
    ],
  },
  '2.145.0': {
    features: [
      {
        pt: 'Trocar a conta de uma sessão no meio dela: quando a conta bate o limite, um aviso acima da caixa de mensagem oferece continuar em outra conta, e "Trocar conta" fica no menu da sessão a qualquer momento. A conversa continua a mesma.',
        en: 'Switch a session’s account mid-session: when the account hits its limit, a notice above the message box offers to continue on another account, and "Switch account" is in the session menu at any time. The conversation stays the same.',
      },
    ],
    fixes: [],
  },
  '2.144.1': {
    features: [],
    fixes: [
      {
        pt: 'Reabrir uma sessão encerrada, ou escrever nela, não cria mais uma segunda linha da mesma conversa na lista.',
        en: 'Reopening an ended session, or writing to it, no longer creates a second row for the same conversation in the list.',
      },
      {
        pt: 'Abrir uma sessão na mesma pasta que outra já usa explica o motivo e sugere uma worktree, e um arquivo de preferências corrompido não impede mais o app de abrir.',
        en: 'Starting a session in a folder another live session already uses explains why and suggests a worktree, and a corrupt preferences file no longer stops the app from starting.',
      },
    ],
  },
  '2.144.0': {
    features: [],
    fixes: [
      {
        pt: 'O aviso de que o cofre vai se trancar agora é falado pela Nay, num cartão opaco que não cobre o botão nem o chat dela.',
        en: 'The vault auto-lock warning is now spoken by Nay, in an opaque card that covers neither her button nor her chat.',
      },
      {
        pt: '"Manter aberto" no cofre pede o Windows Hello no computador e a biometria no celular, nunca o código do autenticador.',
        en: '"Keep open" on the vault asks for Windows Hello on the computer and biometrics on the phone, never the authenticator code.',
      },
      {
        pt: 'O painel de passagem preenche "Janela 5 h" e "Semana" com o consumo da conta da própria sessão, inclusive com várias contas Claude, com uma casa decimal e o motivo dito uma vez quando faltam dados.',
        en: 'The hand-off panel fills "5 h window" and "Week" from the session’s own account, including multiple Claude accounts, with one decimal and the reason said once when data is missing.',
      },
      {
        pt: 'Resumos de ferramentas no chat mostram um ícone do que foi feito (>_ para comandos, a logo do MCP) e ficam alinhados aos avisos do sistema.',
        en: 'Chat tool summaries show an icon for what was done (>_ for commands, the MCP’s logo) and align with system notices.',
      },
      {
        pt: 'Perguntas de múltipla escolha de uma sessão aparecem no cartão do chat como a pergunta, e "Enviar resposta" manda todas as opções marcadas e o texto digitado.',
        en: 'A session’s multiple-choice questions show in the chat card as the question, and "Send answer" sends every ticked option plus the typed text.',
      },
      {
        pt: 'O pedido de "confiar nesta pasta" pode ser respondido pelo app.',
        en: 'The "trust this folder" prompt can be answered from the app.',
      },
      {
        pt: 'Um comando local, como /rename, não deixa mais a sessão presa em "trabalhando".',
        en: 'A local command such as /rename no longer leaves the session stuck on "working".',
      },
    ],
  },
  '2.143.1': {
    features: [],
    fixes: [
      {
        pt: 'Mensagens entre sessões chegam de verdade, uma vez só, também às sessões abertas em segundo plano e depois de reiniciar o servidor.',
        en: 'Messages between sessions really arrive, exactly once, also to background sessions and after a server restart.',
      },
      {
        pt: 'Dormindo mostra só sessões fixadas que terminaram. O aviso de sessões que caíram pode ser dispensado, as linhas ficam juntas e os números dos botões ficam centralizados.',
        en: 'Sleeping shows only pinned sessions that ended. The fallen-session notice can be dismissed, its rows stay together, and button counts are centered.',
      },
      {
        pt: 'Ao passar a liderança, fica um só líder com a equipe inteira (antiga e nova); o líder anterior é encerrado quando fica ocioso.',
        en: 'A leader hand-off leaves one leader with the whole team (old and new); the previous leader is closed once it goes idle.',
      },
      {
        pt: 'Um líder aberto por outro líder fica no topo com os demais líderes, nunca dentro da equipe de outro.',
        en: 'A leader started by another leader stays at the top with the other leaders, never inside another team.',
      },
      {
        pt: 'Novas ações no menu da sessão: "Tirar da equipe" e "Mover para a equipe de…".',
        en: 'New session menu actions: "Take out of the team" and "Move to a leader\'s team…".',
      },
      {
        pt: 'Sessões em "Sem líder" mostram o papel de cada uma e o projeto quando for diferente do resto.',
        en: 'Sessions under "No leader" show each one\'s role, and the project when it differs from the rest.',
      },
    ],
  },
  '2.143.0': {
    features: [
      {
        pt: 'Novo painel de sessões em três abas: Ativas, Grupos e Encerradas.',
        en: 'New sessions panel in three tabs: Active, Groups and Ended.',
      },
      {
        pt: 'Em Ativas, cada líder aparece com a equipe dele embaixo; dá para dobrar a equipe, e ela abre sozinha quando alguém dela espera por você.',
        en: 'In Active, each leader shows its team underneath; a team can be folded, and it unfolds by itself when one of its sessions is waiting for you.',
      },
      {
        pt: 'Sessões que caíram aparecem discretamente no rodapé, com Ver e Reabrir, e completas na aba Encerradas.',
        en: 'Sessions that fell show discreetly at the bottom, with See and Reopen, and in full in the Ended tab.',
      },
      {
        pt: 'O painel recolhido mostra as mesmas abas, líderes, equipes e pastas em ícones.',
        en: 'The collapsed panel shows the same tabs, leaders, teams and folders as icons.',
      },
      {
        pt: 'Filtros, ordem e as outras ações da lista ficam no menu ⋮ ao lado da busca.',
        en: 'Filters, order and the list’s other actions live in the ⋮ menu next to search.',
      },
    ],
    fixes: [
      {
        pt: 'Líderes voltam a abrir sessões em outro projeto; a sessão fica na tarefa do líder, com um aviso.',
        en: 'Leaders can start sessions in another project again; the session stays on the leader’s task, with a notice.',
      },
      {
        pt: 'Avisos do sistema no chat começam alinhados à esquerda, com a linha só depois do texto.',
        en: 'System notices in the chat start at the left edge, with the line only after the text.',
      },
    ],
  },
  '2.142.1': {
    features: [],
    fixes: [
      {
        pt: 'Sessões de uma segunda conta mostram o próprio chat e os próprios limites, inclusive depois de terminar.',
        en: 'Sessions on a second account show their own chat and their own limits, even after they end.',
      },
      {
        pt: 'Sessões abertas em segundo plano — pelo app, por um líder, numa passagem de líder ou ao reabrir — voltam a usar o chat completo em vez do terminal.',
        en: 'Sessions opened in the background — from the app, by a leader, in a leader hand-off or on reopen — use the full chat again instead of the terminal.',
      },
      {
        pt: 'Sessões abertas por um líder herdam o fluxo de trabalho dele também fora dos projetos já configurados.',
        en: 'Sessions a leader opens inherit its workflow outside already set-up projects too.',
      },
      {
        pt: 'Quando a pasta de dados não pode ser gravada, abrir ou reabrir uma sessão explica isso numa frase, sem travar.',
        en: 'When the data folder cannot be written, opening or reopening a session says so in one sentence instead of failing silently.',
      },
    ],
  },
  '2.142.0': {
    features: [
      {
        pt: 'Nova limpeza de disco: a varredura mostra o progresso, pode seguir em segundo plano pelo sino e termina numa lista com filtros, tamanhos e o que dá para liberar.',
        en: 'New disk cleanup: the scan shows its progress, can keep going in the background from the bell, and ends in a list with filters, sizes and what can be freed.',
      },
      {
        pt: 'Sessões líderes mostram um medidor da conversa no topo e, na hora certa, um aviso com o painel "continuar ou passar o líder", com custos lado a lado.',
        en: 'Leader sessions show a conversation meter at the top and, when it is time, a notice with the "continue or hand off" panel, costs side by side.',
      },
      {
        pt: 'Em Configurações › Sessões dá para escolher quando avisar sobre a passagem de líder.',
        en: 'Settings › Sessions lets you choose when to be told about a leader hand-off.',
      },
    ],
    fixes: [],
  },
  '2.141.0': {
    features: [
      {
        pt: '"Adicionar conta" agora mostra o link de login com os botões Abrir e Copiar, sem abrir terminal nem navegador sozinho.',
        en: '"Add account" now shows the sign-in link with Open and Copy buttons, without opening a terminal or a browser by itself.',
      },
      {
        pt: 'No Claude e no Gemini, você cola o código que a página mostrar; no Codex, Copilot e Kimi, o código aparece grande e a janela fecha sozinha quando você termina de entrar.',
        en: 'For Claude and Gemini you paste the code the page shows; for Codex, Copilot and Kimi the code is shown large and the window closes by itself once you finish signing in.',
      },
    ],
    fixes: [
      {
        pt: 'Sessões que terminaram normalmente não aparecem mais como "caíram" depois que o app reinicia.',
        en: 'Sessions that ended normally no longer show up as "fell" after the app restarts.',
      },
      {
        pt: 'Código errado no login mostra um aviso e um link novo, e Cancelar fecha a janela na hora.',
        en: 'A wrong sign-in code shows a notice and a fresh link, and Cancel closes the window at once.',
      },
    ],
  },
  '2.140.12': {
    features: [
      {
        pt: 'Sessões fixadas que foram encerradas descansam em "Dormindo", no menu das abas e na lista lateral, prontas para reabrir.',
        en: 'Pinned sessions that ended rest under "Sleeping", in the tabs menu and the sidebar, ready to reopen.',
      },
      {
        pt: 'Pastas sem nenhuma sessão ativa vão para "Encerradas" no fim do grupo e voltam sozinhas quando algo começa nelas.',
        en: 'Folders with no active session move to "Ended" at the end of their group and come back as soon as something starts in them.',
      },
    ],
    fixes: [
      {
        pt: 'As conversas fixadas continuam visíveis com “Só ativas”. Avisos longos ficam em “Detalhes”, e a primeira abertura após atualizar explica a leitura do histórico enquanto tenta novamente.',
        en: 'Pinned conversations stay visible with “Active only”. Long notices have a “Details” disclosure, and the first start after updating explains history loading while retrying.',
      },
      {
        pt: 'A sequência e o recorde de dias usam o mesmo dia local: atividade entre 21h e meia-noite não pula mais para o dia seguinte.',
        en: 'The day streak and the record use the same local day: late-evening activity no longer jumps to the next day.',
      },
      {
        pt: 'As abas das sessões viraram pílulas, com o menu das abas em primeiro lugar à esquerda.',
        en: 'Session tabs are now pills, with the tabs menu first on the left.',
      },
      {
        pt: 'O check-in da liderança fica em uma coluna, com tudo em sequência e sem textos cortados.',
        en: 'The leadership check-in is one column, everything in order and no cut-off text.',
      },
      {
        pt: 'No sino, o botão liga/desliga não some mais ao rolar, e o botão de reabrir sessões que caíram cabe numa linha.',
        en: 'In the bell, the on/off switch no longer scrolls away, and the reopen button for sessions that fell fits on one line.',
      },
    ],
  },
  '2.140.11': {
    features: [],
    fixes: [
      {
        pt: 'Com um histórico grande, o app continua respondendo enquanto lê o histórico na primeira abertura depois de uma atualização.',
        en: 'With a large history, the app keeps answering while it reads the history on the first start after an update.',
      },
    ],
  },
  '2.140.10': {
    features: [
      {
        pt: 'Configurações → Cobrança tem um botão "Adicionar conta" em cada assistente: ele abre o login de uma segunda conta.',
        en: 'Settings → Billing has an "Add account" button for each assistant: it opens the sign-in for a second account.',
      },
    ],
    fixes: [
      {
        pt: 'Reabrir ou assumir uma sessão não trava mais o app por alguns segundos quando o Claude Code demora a responder.',
        en: 'Reopening or taking over a session no longer freezes the app for a few seconds when Claude Code is slow to answer.',
      },
    ],
  },
  '2.140.9': {
    features: [],
    fixes: [
      {
        pt: 'Configurações → Cobrança mostra uma linha por conta e um só lugar para editar o plano; contas repetidas sumiram.',
        en: 'Settings → Billing shows one row per account and a single place to edit the plan; repeated accounts are gone.',
      },
      {
        pt: 'Valores aparecem com os centavos (R$ 110,50), a lista de planos mostra só os do assistente certo e a data inicial já vem certa.',
        en: "Prices keep their cents (R$ 110.50), the plan list shows only that assistant's plans and the start date comes pre-filled correctly.",
      },
      {
        pt: 'A janela do check-in da liderança abre sozinha, em duas colunas, sem informações repetidas e também no celular.',
        en: 'The leadership check-in window opens on its own, in two columns, without repeated details, on phones too.',
      },
      {
        pt: 'O modo Ausente virou um botão quadrado com uma lua laranja, igual aos outros botões do cabeçalho.',
        en: 'Away mode is now a square button with an orange moon, matching the other header buttons.',
      },
    ],
  },
  '2.140.8': {
    features: [],
    fixes: [
      {
        pt: 'O Codex aparece uma vez só em "Uso dos planos": a conta conectada é reconhecida sozinha e mantém o apelido e o plano.',
        en: 'Codex shows once in "Plan usage": the signed-in account is recognised on its own and keeps its nickname and plan.',
      },
      {
        pt: 'Abrir uma sessão do Codex ou de outro assistente não falha mais quando o login padrão ainda não foi identificado.',
        en: 'Opening a Codex or other assistant session no longer fails while the default login is still unidentified.',
      },
      {
        pt: 'Sessões abertas em segundo plano ficam na pasta escolhida, em vez de aparecerem soltas na lateral.',
        en: 'Sessions opened in the background stay in the chosen folder instead of showing loose in the sidebar.',
      },
      {
        pt: 'A passagem de líder conclui mesmo em conversas longas ou quando o líder anterior já foi encerrado.',
        en: 'A leader hand-off completes even in long conversations or when the previous leader has already ended.',
      },
    ],
  },
  '2.140.7': {
    features: [],
    fixes: [
      {
        pt: 'Buscar sessões não derruba mais a página, e a busca volta a achar sessões pelo nome antigo e pela primeira mensagem.',
        en: 'Searching sessions no longer breaks the page, and search finds sessions by their former name and first message again.',
      },
      {
        pt: 'Sessões encerradas aparecem no histórico com o nome que tinham, não com um resumo automático.',
        en: 'Ended sessions show in the history under the name they had, not an automatic summary.',
      },
      {
        pt: '"Só líderes" mostra apenas os líderes ativos, numa lista simples, e o número acompanha a busca e os filtros.',
        en: '"Leaders only" shows just the active leaders in a plain list, and the count follows search and filters.',
      },
      {
        pt: 'Um worker recém-aberto não toca mais aviso quando "Silenciar workers" está ligado.',
        en: 'A freshly opened worker no longer rings when "Mute active workers" is on.',
      },
      {
        pt: 'Mensagens enviadas pelo agentistics ou por outra sessão nunca aparecem como se fossem suas, inclusive as repassadas na passagem de líder.',
        en: 'Messages sent by agentistics or by another session never show as yours, including those forwarded in a leader hand-off.',
      },
      {
        pt: 'Avisos com seta no chat, como "tarefa em segundo plano respondeu", abrem o que mencionam.',
        en: 'Chat notes with an arrow, like "background task replied", open what they mention.',
      },
      {
        pt: 'A animação de atualização ficou mais leve e não engasga no final.',
        en: 'The update animation is lighter and no longer stutters at the end.',
      },
      {
        pt: 'Abrir uma sessão encerrada não quebra mais a página.',
        en: 'Opening an ended session no longer breaks the page.',
      },
      {
        pt: 'Esc fecha o menu de visualização da lista; sessões encerradas oferecem Reabrir em vez de Parar e dizem por que não dá para reabrir quando for o caso.',
        en: 'Esc closes the list view menu; ended sessions offer Reopen instead of Stop and say why when they cannot be reopened.',
      },
      {
        pt: 'Pastas ocultas abrem e fecham como as outras seções da lateral.',
        en: 'Hidden folders open and close like the other sidebar sections.',
      },
      {
        pt: 'Arquivos temporários de início de sessão não ficam mais no disco.',
        en: 'Temporary session start files no longer stay on disk.',
      },
      {
        pt: 'A tela de novidades volta a aparecer depois de atualizar.',
        en: 'The what\'s-new screen shows again after an update.',
      },
      {
        pt: 'Na passagem de líder, a nova sessão leva também as sessões silenciadas, o modelo, o esforço e a nota da anterior, e você fica sabendo quando a passagem não aconteceu.',
        en: 'A leader hand-off now also carries the muted sessions, model, effort and note to the new session, and tells you when the hand-off did not happen.',
      },
      {
        pt: 'Quando uma sessão entrega, o chat mostra "Tarefa entregue" com o nome dela; ao abrir, o texto aparece formatado. Avisos assim não oferecem mais "Enviar agora".',
        en: 'When a session hands back, the chat says "Task handed back" with its name; open it to read the text formatted. Such notices no longer offer "Send now".',
      },
      {
        pt: 'Os check-ins dos líderes passam a ser escritos em linguagem simples.',
        en: 'Leader check-ins are now written in plain language.',
      },
      {
        pt: 'Os presets de sessão foram removidos.',
        en: 'Session presets were removed.',
      },
    ],
  },
  '2.140.6': {
    features: [],
    fixes: [
      {
        pt: 'O chat mostra melhor o que a sessão está fazendo: ferramentas, subagentes e alterações em arquivos.',
        en: 'The chat shows better what a session is doing: tools, subagents and file changes.',
      },
    ],
  },
  '2.140.5': {
    features: [
      {
        pt: 'Você pode cadastrar mais de uma conta por assistente.',
        en: 'You can add more than one account per assistant.',
      },
    ],
    fixes: [],
  },
  '2.140.4': {
    features: [],
    fixes: [
      {
        pt: 'Uma sessão nunca mais mostra a conversa de outra sessão.',
        en: 'A session never shows another session\'s conversation again.',
      },
    ],
  },
  '2.140.3': {
    features: [],
    fixes: [
      {
        pt: 'O aviso de papel da sessão aparece como uma linha de sistema, não como mensagem sua.',
        en: 'The session role notice shows as a system row, not as a message from you.',
      },
      {
        pt: 'O cofre bloqueado deixou de consultar o servidor sem parar.',
        en: 'A locked vault no longer keeps polling the server.',
      },
      {
        pt: 'Pastas ocultas ficam no topo da lista e sessões encerradas ocupam menos espaço.',
        en: 'Hidden folders sit at the top of the list and ended sessions take less room.',
      },
    ],
  },
  '2.140.2': {
    features: [],
    fixes: [
      {
        pt: 'A passagem de líder não falha mais quando o resumo para o sucessor é longo.',
        en: 'A leader hand-off no longer fails when the summary for the successor is long.',
      },
    ],
  },
  '2.140.1': {
    features: [
      {
        pt: 'No assistente de nova sessão dá para criar um projeto novo na hora.',
        en: 'The new-session wizard can create a brand-new project on the spot.',
      },
    ],
    fixes: [],
  },
  '2.140.0': {
    features: [
      {
        pt: 'A passagem de líder pela linha de comando leva ao sucessor o título, a pasta, o fixado, o check-in, o papel e o modo ausente.',
        en: 'A leader hand-off from the command line gives the successor its title, folder, pin, check-in, role and away mode.',
      },
    ],
    fixes: [],
  },
  '2.139.0': {
    features: [
      {
        pt: 'O novo chat das sessões vem ativado por padrão nos assistentes compatíveis.',
        en: 'The new session chat is on by default for supported assistants.',
      },
    ],
    fixes: [],
  },
  '2.138.2': {
    features: [],
    fixes: [
      {
        pt: 'O botão de modo ausente ficou mais claro e Esc fecha a camada aberta por cima, uma de cada vez.',
        en: 'The away toggle looks clearer and Esc closes the top overlay, one at a time.',
      },
      {
        pt: 'Linhas de sistema no chat ficaram mais discretas.',
        en: 'System lines in the chat are quieter.',
      },
    ],
  },
  '2.138.1': {
    features: [],
    fixes: [
      {
        pt: 'Mensagens entre sessões aparecem como eventos do sistema, não como se fossem suas.',
        en: 'Messages between sessions show as system events, not as if you had written them.',
      },
    ],
  },
  '2.138.0': {
    features: [
      {
        pt: 'O início de uma sessão agora segue um fluxo numerado.',
        en: 'Starting a session now follows a numbered flow.',
      },
      {
        pt: 'A contagem de sessões em modo ausente atualiza ao vivo.',
        en: 'The away-session count updates live.',
      },
    ],
    fixes: [],
  },
  '2.137.1': {
    features: [],
    fixes: [
      {
        pt: 'Sessões encerradas deixam de aparecer como ativas na lateral.',
        en: 'Ended sessions no longer linger as active in the side list.',
      },
    ],
  },
  '2.137.0': {
    features: [
      {
        pt: 'A passagem de líder entre sessões ficou mais confiável, e uma sessão não fica pela metade se algo falhar ao abrir.',
        en: 'Leader hand-off between sessions is more reliable, and a session is never left half-open when something fails at start.',
      },
    ],
    fixes: [],
  },
  '2.136.1': {
    features: [],
    fixes: [
      {
        pt: 'Avisos do sistema no chat (entregas, bloqueios, modo ausente) aparecem como uma linha compacta com o nome da sessão; clique para ver o texto.',
        en: 'System notices in the chat (handbacks, blocks, away mode) show as one compact line with the session name; click to read the text.',
      },
      {
        pt: 'O modo ausente ligado e desligado agora são avisos diferentes.',
        en: 'Away mode turning on and off now read as different notices.',
      },
      {
        pt: 'No sino de notificações, os botões de ação ficam numa linha própria, abaixo da mensagem.',
        en: 'In the notification bell, action buttons sit on their own row below the message.',
      },
    ],
  },
  '2.136.0': {
    features: [
      {
        pt: 'Os limites de plano não oferecem mais vagas num assistente que não consegue abrir sessões nesta máquina.',
        en: 'Plan limits no longer offer slots on an assistant that cannot start sessions on this machine.',
      },
    ],
    fixes: [],
  },
  '2.135.1': {
    features: [],
    fixes: [
      {
        pt: 'Os limites do plano do Claude voltaram a atualizar em sessões no terminal (antes ficavam parados em 0%); uma leitura antiga agora aparece como desatualizada.',
        en: 'Claude plan limits update again for terminal sessions (they were stuck at 0%); an old reading now shows as out of date.',
      },
    ],
  },
  '2.133.0': {
    features: [
      {
        pt: 'O painel de informações da sessão mostra quem definiu o papel dela (líder ou worker).',
        en: 'The session info panel shows who set its role (leader or worker).',
      },
      {
        pt: 'Os limites de plano mostram as vagas livres por assistente; um plano em pausa não oferece vagas até o reset.',
        en: 'Plan limits show free slots per assistant; a plan on hold offers none until its reset.',
      },
    ],
    fixes: [
      {
        pt: 'Menos uso de CPU com o app parado e listas de sessões mais leves.',
        en: 'Less CPU use while idle and lighter session lists.',
      },
      {
        pt: 'Uma mensagem enviada no meio de uma resposta não fica mais presa como pendente.',
        en: 'A message sent in the middle of a reply no longer stays stuck as pending.',
      },
      {
        pt: 'O nome e o papel de uma sessão se mantêm ao abrir, reabrir ou criar em lote.',
        en: 'A session keeps its name and role when opened, reopened or created in a batch.',
      },
    ],
  },
  '2.131.0': {
    features: [
      {
        pt: 'Nova tela de sessão no celular: o título aparece inteiro, um ícone abre o painel lateral, que desliza da esquerda e fecha com um gesto para o lado.',
        en: 'New session screen on phones: the full title shows, one icon opens the side panel, which slides in from the left and closes with a swipe.',
      },
    ],
    fixes: [],
  },
  '2.130.0': {
    features: [
      {
        pt: 'Sessões abertas fora do agentistics agora mostram o estado certo, lido do histórico da própria conversa.',
        en: 'Sessions opened elsewhere (outside agentistics) now show the right state, read from the conversation transcript.',
      },
      {
        pt: 'Novas sessões com o papel "Automático" já começam como workers.',
        en: 'New sessions whose role is "Automatic" now start as workers.',
      },
      {
        pt: 'O histórico das sessões do Gemini e do Kimi é lido de forma incremental: mais rápido e com menos uso de CPU.',
        en: 'Gemini and Kimi session history is now read incrementally: faster and lighter on CPU.',
      },
    ],
    fixes: [],
  },
  '2.129.1': {
    features: [],
    fixes: [
      {
        pt: 'No Agentask, clicar numa sessão mencionada com # abre a sessão.',
        en: 'In Agentask, clicking a session mentioned with # opens that session.',
      },
      {
        pt: 'Um comentário mencionado com ^ abre mesmo quando está em outra vista da tarefa.',
        en: 'A comment mentioned with ^ opens even when it is in another view of the task.',
      },
      {
        pt: 'O aviso de comentário não encontrado aparece no idioma da interface.',
        en: 'The "comment not found" notice shows in the interface language.',
      },
    ],
  },
  '2.129.0': {
    features: [
      {
        pt: 'A lista de sessões abre muito mais rápido: só as sessões ativas vêm na primeira carga, e as fechadas aparecem quando você abre a lista delas.',
        en: 'The session list opens much faster: only active sessions come in the first load, and closed ones appear when you open their list.',
      },
      {
        pt: 'Cada sessão lembra se é líder ou worker ao ser reaberta, em qualquer assistente, e recebe esse aviso só uma vez.',
        en: 'Each session remembers whether it is a leader or a worker when reopened, in every assistant, and gets that note only once.',
      },
      {
        pt: 'Uma sessão aberta como líder pelo terminal já ganha o prefixo de líder no título.',
        en: 'A session opened as a leader from the terminal gets the leader prefix in its title right away.',
      },
    ],
    fixes: [],
  },
  '2.128.0': {
    features: [
      {
        pt: 'Mensagens enviadas a uma sessão e pedidos de aprovação ou perguntas pendentes continuam lá depois que o servidor reinicia, e podem ser respondidos normalmente.',
        en: 'Messages sent to a session and pending approval requests or questions are still there after the server restarts, and can be answered as usual.',
      },
      {
        pt: 'Enviar uma mensagem para várias sessões não reabre mais uma sessão fechada sem perguntar antes.',
        en: 'Sending a message to several sessions no longer reopens a closed session without asking first.',
      },
    ],
    fixes: [
      {
        pt: 'Quando um assistente troca de conta, o chat avisa se aquele assistente ainda não acompanha a troca, em vez de parecer travado.',
        en: 'When an assistant switches accounts, the chat says so if that assistant does not follow the switch yet, instead of looking frozen.',
      },
      {
        pt: 'Sessões nativas: se não for possível conferir a saída de uma ferramenta em busca de segredos, ela fica retida em vez de aparecer.',
        en: 'Native sessions: if a tool\'s output cannot be checked for secrets, it is withheld instead of shown.',
      },
    ],
  },
  '2.127.0': {
    features: [
      {
        pt: 'Ao abrir um tópico no Agentask você já pode escrever a primeira mensagem, mencionando sessões com # e comentários com ^.',
        en: 'When you open a topic in Agentask you can now write its first message, mentioning sessions with # and comments with ^.',
      },
    ],
    fixes: [
      {
        pt: 'Cofre mais seguro: só um gesto seu mantém o cofre aberto. Agentes e serviços que usam segredos não adiam mais a tranca automática.',
        en: 'Safer vault: only your own actions keep the vault open. Agents and services using secrets no longer postpone the auto-lock.',
      },
      {
        pt: 'Abrir um tópico não cria mais tópicos repetidos, e os botões Abrir/Cancelar não ficam escondidos no celular.',
        en: 'Opening a topic no longer creates duplicates, and the Open/Cancel buttons are no longer hidden on the phone.',
      },
    ],
  },
  '2.126.0': {
    features: [
      {
        pt: 'Novo botão "Uso" no rodapé da barra lateral: passe o mouse para ver os limites de todos os seus planos (sessão de 5 h e semana) e clique para abrir a aba Limites da Nay.',
        en: 'New "Usage" button at the bottom of the sidebar: hover to see the limits of all your plans (5-hour session and week) and click to open Nay\'s Limits tab.',
      },
      {
        pt: 'O bloco "Plano" do composer mostra anéis com o uso do plano da sessão, e a aba Limites da Nay mostra cada janela em uma linha, com quando renova.',
        en: 'The composer\'s "Plan" block shows rings with the session plan\'s usage, and Nay\'s Limits tab shows each window on its own row with when it renews.',
      },
      {
        pt: 'Assistentes que coordenam outras sessões leem os limites dos planos (agentistics_plan_limits) e recebem uma recomendação de qual assistente usar e quantas sessões manter rodando.',
        en: 'Assistants that coordinate other sessions read the plan limits (agentistics_plan_limits) and get a recommendation of which assistant to use and how many sessions to keep running.',
      },
      {
        pt: 'Sessões líderes recebem um aviso quando o contexto cresce, sugerindo passar o bastão para uma sessão nova.',
        en: 'Leader sessions get a notice when their context grows, suggesting a hand-off to a fresh session.',
      },
    ],
    fixes: [
      {
        pt: 'Trocar o tipo da sessão (Líder/Worker) no painel ⓘ agora abre as opções dentro do próprio painel, sem cobrir as outras informações.',
        en: 'Changing the session type (Leader/Worker) in the ⓘ panel now opens the options inside the panel, without covering the other details.',
      },
      {
        pt: 'A limpeza pela interface agora mostra cada item mantido com o motivo, e os itens mantidos não voltam marcados.',
        en: 'Cleanup from the app now lists each kept item with its reason, and kept items no longer come back selected.',
      },
      {
        pt: 'O selo de Líder/Worker é o mesmo na lista e no painel ⓘ, e a linha da sessão continua legível com o sino silenciado.',
        en: 'The Leader/Worker badge is the same in the list and in the ⓘ panel, and the session row stays readable with a muted bell.',
      },
      {
        pt: 'Voltar o tamanho do texto para 100% devolve o comportamento normal da página.',
        en: 'Setting the text size back to 100% restores the page\'s normal behaviour.',
      },
      {
        pt: 'Quando a importação do histórico falha, o app consulta o estado com menos frequência.',
        en: 'When the history import fails, the app checks its state less often.',
      },
    ],
  },
  '2.125.0': {
    features: [
      {
        pt: 'Limpeza pela interface: o aviso de espaço para liberar ganhou o botão "Ver o que dá para limpar", que lista o que pode sair (worktrees concluídas e dependências paradas), pede confirmação, roda em segundo plano e mostra quanto foi liberado. Nada em andamento é tocado e as branches ficam.',
        en: 'Cleanup from the app: the free-space notice now has a "See what can be cleaned" button that lists what can go (finished worktrees and idle dependencies), asks for confirmation, runs in the background and shows how much was freed. Nothing in progress is touched and branches stay.',
      },
    ],
    fixes: [],
  },
  '2.124.0': {
    features: [
      {
        pt: 'Tipo da sessão: marque uma sessão como Líder ou Worker (na Nova sessão, no ⓘ ou no menu da linha) e, se quiser, silencie os workers que estão rodando — só líderes e sessões sem tipo avisam.',
        en: 'Session type: mark a session as Leader or Worker (in New session, the ⓘ or the row menu) and, if you like, mute running workers — only leaders and untyped sessions notify.',
      },
      {
        pt: 'O tamanho do texto nas Configurações agora aumenta ou diminui o app inteiro, sem quebrar a tela; no celular há um limite para caber.',
        en: 'The text size in Settings now scales the whole app without breaking the layout; on the phone it stops where it still fits.',
      },
      {
        pt: 'Conversa da tarefa: resolver um tópico mostra que deu certo e o leva para "Resolvidos"; se falhar, aparece o erro com "Tentar de novo"; o campo de comentário fica sempre visível.',
        en: 'Task conversation: resolving a topic confirms it and moves it to "Resolved"; a failure shows the error with "Try again"; the comment field is always visible.',
      },
      {
        pt: 'Os avisos de carregamento (dados chegando, git lento, importação do histórico) agora são notificações no sininho que se atualizam sozinhas, em vez de linhas cinzas no topo.',
        en: 'Loading notices (data arriving, slow git, history import) are now bell notifications that update by themselves, instead of grey lines at the top.',
      },
    ],
    fixes: [
      {
        pt: 'O botão de idioma mostra o idioma atual, e a primeira abertura segue o idioma do navegador.',
        en: 'The language button shows the current language, and the first launch follows the browser language.',
      },
      {
        pt: 'A limpeza de worktrees ficou mais rápida em repositórios com muitas worktrees.',
        en: 'Worktree cleanup is faster in repositories with many worktrees.',
      },
    ],
  },
  '2.123.0': {
    features: [
      {
        pt: 'Quando sai uma versão nova, aparece um selo "atualizar" ao lado do número da versão; clicar abre a atualização.',
        en: 'When a new version is out, an "update" badge shows next to the version number; clicking it opens the update.',
      },
      {
        pt: 'Se a importação do histórico falhar, um botão "Tentar importar de novo" refaz a importação, sem precisar de comando.',
        en: 'If the history import fails, a "Retry the import" button runs it again, no command needed.',
      },
      {
        pt: 'As sessões conhecem melhor o agentistics: o briefing de início explica o quadro, as tarefas e as passagens de bastão, e cada harness recebe as instruções do agentistics, atualizadas a cada versão.',
        en: 'Sessions know agentistics better: the start briefing explains the board, tasks and hand-offs, and each harness gets the agentistics instructions, refreshed on every version.',
      },
    ],
    fixes: [
      {
        pt: 'Cofre: o modal rápido usa a mesma moldura dos outros diálogos, alinhado no computador e em tela cheia no celular.',
        en: 'Vault: the quick modal uses the same frame as the other dialogs, aligned on desktop and full-screen on the phone.',
      },
    ],
  },
  '2.122.1': {
    features: [],
    fixes: [
      {
        pt: 'O tempo ativo de uma sessão não passa mais da duração dela: intervalos sobrepostos contam uma vez só, e o tempo medido de cada resposta continua valendo.',
        en: 'A session\'s active time no longer exceeds its duration: overlapping intervals count once, and each reply\'s measured time still wins.',
      },
    ],
  },
  '2.121.0': {
    features: [
      {
        pt: 'Cofre: dá para criar o cofre pela própria tela, com um botão "Criar o cofre", sem precisar de comando.',
        en: 'Vault: create the vault from the app with a "Create the vault" button, no command needed.',
      },
    ],
    fixes: [
      {
        pt: 'Apagar uma pasta que tem subpastas pergunta se quer apagar as subpastas também e apaga tudo junto (as sessões continuam).',
        en: 'Deleting a folder that has sub-folders asks whether to delete them too and removes them together (sessions are kept).',
      },
      {
        pt: 'Pastas criadas ou alteradas por uma sessão aparecem na barra lateral na hora, sem recarregar.',
        en: 'Folders created or changed by a session show up in the sidebar right away, without reloading.',
      },
      {
        pt: 'Se a atualização falhar, "Reiniciar agora" funciona na hora em vez de responder que já há uma atualização em andamento.',
        en: 'If an update fails, "Restart now" works right away instead of saying an update is already running.',
      },
      {
        pt: 'Recursos: sem linhas repetidas, e CPU aparece desde a primeira leitura.',
        en: 'Resources: no repeated rows, and CPU shows from the first reading.',
      },
      {
        pt: 'Custo "Plano" calculado por harness, em vez de usar o plano do Claude para todos.',
        en: '"Plan" cost is priced per harness instead of applying the Claude plan to all of them.',
      },
      {
        pt: 'A "Nova sessão" não fica mais presa em "Vendo o que está instalado…": mostra os harnesses que já responderam.',
        en: '"New session" no longer gets stuck on "Checking what is installed…": it shows the harnesses that already answered.',
      },
      {
        pt: 'Colar um texto longo (mais de 5 mil caracteres) no chat vira o chip "Conteúdo colado".',
        en: 'Pasting a long text (over 5,000 characters) into the chat becomes the "Pasted content" chip.',
      },
    ],
  },
  '2.120.0': {
    features: [
      {
        pt: 'Recursos (Configurações → Hardware) agora resolve o que avisa: um resumo de "Ações recomendadas" mostra quanta memória dá para liberar, "Encerrar órfãos" fecha de uma vez os processos que sobraram de sessões que já acabaram, e cada sessão com o agentop antigo tem o botão "Abrir".',
        en: 'Resources (Settings → Hardware) now fixes what it reports: a "Recommended actions" summary shows how much memory can be freed, "End orphans" closes at once the processes left by sessions that already ended, and each session still on the old agentop has an "Open" button.',
      },
    ],
    fixes: [
      {
        pt: '"Encerrar" encerra de verdade, mesmo um processo que ignora o pedido de fechar, e só diz "encerrado" depois de confirmar.',
        en: '"End" really ends the process, even one that ignores the request to close, and only says "ended" after confirming it.',
      },
      {
        pt: 'Não aparece mais a notificação de "MCP com agentop antigo", que não tinha nada a fazer; só avisamos de órfãos, que você pode encerrar.',
        en: 'No more "MCP on an old agentop" notification, which had nothing to act on; only orphans, which you can end, are announced.',
      },
    ],
  },
  '2.116.0': {
    features: [
      {
        pt: 'O círculo de métricas da sessão ganhou dois arcos finos com o uso do plano nas últimas 5 horas e nos últimos 7 dias, e o painel dele mostra quando cada janela renova.',
        en: 'The session metrics circle gained two thin arcs with your plan\'s usage over the last 5 hours and 7 days, and its panel shows when each window resets.',
      },
      {
        pt: 'Na Nova sessão, passar o mouse sobre um assistente mostra os limites do plano dele; o que tem mais folga ganha a etiqueta "mais folga". No celular, os limites aparecem na revisão.',
        en: 'In New session, hovering an assistant shows its plan limits; the one with the most room is tagged "most room". On a phone, the limits show on the review step.',
      },
      {
        pt: 'A Nay tem uma aba Limites com cada plano registrado: quanto já foi usado, quando renova e quando foi a última atualização.',
        en: 'Nay has a Limits tab with every registered plan: how much is used, when it resets and when it was last updated.',
      },
      {
        pt: 'A Nay avisa quando uma janela do plano passa de 75%, 85%, 95% e 100%; no fim, diz quando renova e sugere continuar em outro assistente que ainda tenha folga.',
        en: 'Nay tells you when a plan window passes 75%, 85%, 95% and 100%; at the end it says when it resets and suggests continuing in another assistant that still has room.',
      },
    ],
    fixes: [
      {
        pt: 'O servidor ficou mais leve: gasta bem menos CPU parado e a primeira tela carrega com 14 KB.',
        en: 'The server is lighter: it uses much less CPU while idle and the first screen loads with 14 KB.',
      },
    ],
  },
  '2.115.1': {
    features: [],
    fixes: [
      {
        pt: 'Atualizar pela interface volta a reiniciar o agentistics na versão nova; se o reinício falhar, a tela oferece "Reiniciar agora" em vez de baixar tudo de novo.',
        en: 'Updating from the app restarts agentistics on the new version again; if the restart fails, the screen offers "Restart now" instead of downloading again.',
      },
      {
        pt: 'A janela flutuante tem o alfinete para desafixar ao lado do minimizar, o nome não aparece duplicado e a aba minimizada voltou ao visual de antes.',
        en: 'The floating window has the pin to unpin next to minimize, its name is no longer shown twice and the minimized tab looks as it did before.',
      },
    ],
  },
  '2.115.0': {
    features: [
      {
        pt: 'As novidades abrem sozinhas uma vez depois de cada atualização, com a opção "Não mostrar novamente"; a escolha fica salva nesta máquina.',
        en: 'What\'s new opens by itself once after each update, with a "Don\'t show again" option; the choice is saved on this machine.',
      },
      {
        pt: 'Configurações → Novidades mostra a versão atual e o histórico das atualizações; clicar no número da versão também abre as novidades.',
        en: 'Settings → What\'s new shows the current version and the history of updates; clicking the version number also opens it.',
      },
      {
        pt: 'O cartão de métricas da sessão mostra o custo por resposta e avisa quando a conversa passa do limite de tokens, para passar o bastão a uma sessão nova.',
        en: 'The session metrics card shows the cost per reply and warns when the conversation passes the token limit, so you can hand off to a fresh session.',
      },
      {
        pt: 'O briefing que cada assistente recebe ficou mais curto: só as ferramentas de sessões e do Agentask, com métricas e painéis em uma linha.',
        en: 'The briefing each assistant receives is shorter: only the sessions and Agentask tools, with metrics and dashboards in one line.',
      },
    ],
    fixes: [],
  },
  '2.114.1': {
    features: [],
    fixes: [
      {
        pt: 'O terminal da sessão e o Studio voltaram para a barra de baixo e para o painel lateral, em todos os assistentes.',
        en: 'The session terminal and the Studio are back in the bottom bar and the side panel, for every assistant.',
      },
      {
        pt: 'Um painel fixado e minimizado na barra de baixo agora pode ser desafixado: o mesmo alfinete o devolve ao painel lateral.',
        en: 'A pinned panel minimized to the bottom bar can now be unpinned: the same pin returns it to the side panel.',
      },
    ],
  },
  '2.114.0': {
    features: [
      {
        pt: 'O ⓘ ao lado do título mostra as sessões mais recentes primeiro, com a hora, separa as que estão rodando das encerradas e tem busca.',
        en: 'The ⓘ next to the title lists the newest sessions first, with their time, keeps running ones apart from ended ones and has a search.',
      },
      {
        pt: 'Cada assistente agora começa sabendo trabalhar como líder ou como executor, quais ferramentas do agentistics tem e quando sugerir uma skill de especificação.',
        en: 'Every assistant now starts knowing how to work as a leader or a worker, which agentistics tools it has and when to suggest a specification skill.',
      },
      {
        pt: 'Experimental (agentop experimental enable): sessões de Claude, Codex, Gemini e Kimi criadas pela web conversam pelo protocolo oficial de cada assistente — resposta ao vivo, cartões de permissão e pergunta, e a sessão continua viva quando o servidor reinicia.',
        en: 'Experimental (agentop experimental enable): Claude, Codex, Gemini and Kimi sessions started from the web talk through each assistant\'s official protocol — live answers, permission and question cards, and the session stays alive when the server restarts.',
      },
      {
        pt: 'Codex e Gemini mostram o comando `!` e a saída dele no chat.',
        en: 'Codex and Gemini show a `!` command and its output in the chat.',
      },
    ],
    fixes: [
      {
        pt: 'A animação de atualização vai até o fim sem piscar nem mostrar a tela de carregamento no meio.',
        en: 'The update animation plays to the end without flashing or showing the loading screen in the middle.',
      },
      {
        pt: 'Codex: a web não mostra mais "sessão encerrada" com a sessão viva, a mensagem enviada com o Codex ocupado entra na fila dele e o texto não volta para o campo nem é reenviado.',
        en: 'Codex: the web no longer says "session ended" while the session is alive, a message sent while Codex is busy joins its queue, and the text no longer comes back to the box or gets sent twice.',
      },
      {
        pt: 'Gemini e Kimi ficam ligados à conversa certa desde a criação; reabrir uma sessão Kimi voltou a funcionar.',
        en: 'Gemini and Kimi are linked to the right conversation from the start; reopening a Kimi session works again.',
      },
    ],
  },
  '2.113.0': {
    features: [
      {
        pt: 'Toda sessão nova abre direto no chat, em qualquer assistente (Codex, Gemini, Kimi, Copilot…), mesmo antes da primeira mensagem. O terminal fica a um clique.',
        en: 'Every new session opens straight on the chat, in any assistant (Codex, Gemini, Kimi, Copilot…), even before the first message. The terminal is one click away.',
      },
      {
        pt: 'Um ⓘ ao lado do título mostra quem iniciou a sessão, as sessões que ela iniciou e a tarefa ligada; clique para ir até elas.',
        en: 'An ⓘ next to the title shows who started the session, the sessions it started and its linked task; click to go to them.',
      },
      {
        pt: 'Clique com o botão direito (ou toque longo) num link de uma mensagem para copiar só o link ou abrir numa nova aba.',
        en: 'Right-click (or long-press) a link in a message to copy just the link or open it in a new tab.',
      },
      {
        pt: 'Instale o Claude Code, o Codex, o Gemini ou o Copilot com um clique em Configurações → Harnesses ou na Nova sessão, com progresso na tela e o Node.js incluído quando faltar. "Entrar" abre o login do assistente.',
        en: 'Install Claude Code, Codex, Gemini or Copilot with one click in Settings → Harnesses or in New session, with progress on screen and Node.js included when missing. "Sign in" opens the assistant\'s login.',
      },
    ],
    fixes: [
      {
        pt: 'A primeira mensagem de uma sessão nova, com ou sem anexo, aparece uma vez só e não se perde.',
        en: 'The first message of a new session, with or without an attachment, shows once and is never lost.',
      },
      {
        pt: 'As respostas do Codex, do Kimi e do Antigravity aparecem no chat em poucos segundos, não mais depois de vários minutos.',
        en: 'Codex, Kimi and Antigravity replies show in the chat within seconds, no longer after several minutes.',
      },
      {
        pt: '"Esta sessão" mostra o nome real do modelo (por exemplo, Opus 5.5).',
        en: '"This session" shows the real model name (for example, Opus 5.5).',
      },
      {
        pt: 'Atualizar o app não fica mais preso na animação: se a versão nova já está instalada, o app só reinicia, e se algo demorar aparece o botão "Reiniciar agora".',
        en: 'Updating the app no longer gets stuck on the animation: if the new version is already installed the app just restarts, and if something takes too long a "Restart now" button appears.',
      },
      {
        pt: 'A Nova sessão não perde o que você preencheu quando a janela muda de tamanho.',
        en: 'New session keeps what you filled in when the window changes size.',
      },
      {
        pt: 'Os avisos de instalar o app e de "como você paga" não voltam a cada recarga depois de fechados.',
        en: 'The install-the-app and "how do you pay" notices no longer come back on every reload once closed.',
      },
    ],
  },
  '2.112.1': {
    features: [
      {
        pt: 'Fechar a Nova sessão sem querer não perde mais o que você preencheu: o app pergunta antes de descartar.',
        en: 'Closing New session by accident no longer loses what you filled in: the app asks before discarding.',
      },
      {
        pt: 'Na Nova sessão, "Não achou? Escolher outra pasta…" fica no fim da lista e abre no disco escolhido.',
        en: 'In New session, "Not here? Choose another folder…" sits at the end of the list and opens on the chosen disk.',
      },
    ],
    fixes: [
      {
        pt: 'Ligar um disco (como o C:) passa a procurar projetos nele na hora, sem ficar em zero.',
        en: 'Switching on a disk (like C:) now searches it for projects right away instead of staying at zero.',
      },
      {
        pt: '"Todos os discos" fica selecionado.',
        en: '"All disks" stays selected.',
      },
      {
        pt: 'O agentistics agora é um app só: a "central" e o modo "membro" saíram das telas e dos comandos.',
        en: 'agentistics is now one app: the "central" and "member" modes are gone from the screens and commands.',
      },
    ],
  },
  '2.112.0': {
    features: [
      {
        pt: 'Na Nova sessão, "Procurar pasta…" deixa escolher qualquer pasta clicando, sem digitar caminho, e um filtro mostra um disco por vez.',
        en: 'In New session, "Browse folder…" lets you pick any folder by clicking, without typing a path, and a filter shows one disk at a time.',
      },
      {
        pt: 'Cofre: um só botão de olho por segredo, criar grupo na hora, excluir vários de uma vez e escolher o tipo de cada linha ao importar (inclusive tipos seus).',
        en: 'Vault: one eye button per secret, create a group on the spot, delete several at once and pick each row\'s type when importing (your own types too).',
      },
      {
        pt: 'Segredos do cofre liberados para uma conversa agora funcionam em todos os assistentes, não só no Claude Code.',
        en: 'Vault secrets granted to a conversation now work in every assistant, not only Claude Code.',
      },
      {
        pt: 'Cada assistente já começa sabendo que roda dentro do agentistics, sem responder sozinho.',
        en: 'Every assistant starts knowing it runs inside agentistics, without answering on its own.',
      },
      {
        pt: 'Uma sessão criada por outra mostra quem a criou e avisa a sessão de origem quando termina.',
        en: 'A session started by another one shows who started it and reports back to it when done.',
      },
    ],
    fixes: [
      {
        pt: 'O app fica mais leve enquanto as sessões trabalham: só o que mudou é recalculado.',
        en: 'The app stays lighter while sessions work: only what changed is recalculated.',
      },
      {
        pt: 'O Agentask abre mais rápido, lembrando a última lista, e as colunas se ajustam ao conteúdo.',
        en: 'Agentask opens faster by remembering the last list, and columns fit their content.',
      },
      {
        pt: 'Cada citação fica junto da sua resposta na mensagem.',
        en: 'Each quote stays next to your reply to it in the message.',
      },
      {
        pt: 'Uma mensagem digitada não aparece mais como "Texto colado".',
        en: 'A typed message no longer shows up as "Pasted text".',
      },
      {
        pt: 'Sem o aviso falso "A máquina não respondeu a tempo" quando a mensagem chegou.',
        en: 'No more false "The machine did not answer in time" warning when the message arrived.',
      },
      {
        pt: 'O Codex não trava mais o envio com a pergunta do serviço em segundo plano.',
        en: 'Codex no longer blocks sending with its background-service question.',
      },
      {
        pt: 'Atualizar o app também atualiza a integração com os assistentes e espera a versão nova subir.',
        en: 'Updating the app also refreshes the assistant integrations and waits for the new version to come up.',
      },
    ],
  },
  '2.111.3': {
    features: [],
    fixes: [
      {
        pt: 'O app não fica mais lento por varrer a pasta /tmp e a pasta pessoal procurando repositórios.',
        en: 'The app no longer slows down from scanning /tmp and your home folder looking for repositories.',
      },
    ],
  },
  '2.111.2': {
    features: [
      {
        pt: 'Sessões novas abrem sem travar, mesmo em máquinas com discos grandes; se a busca de projetos demorar, há "Tentar de novo".',
        en: 'New sessions open without freezing, even on machines with big disks; if the project search is slow there is a "Try again" button.',
      },
      {
        pt: 'As respostas do Antigravity agora aparecem no chat.',
        en: 'Antigravity replies now show up in the chat.',
      },
      {
        pt: 'A grade de subtarefas tem larguras de coluna próprias, ajustáveis e lembradas.',
        en: 'The subtask grid has its own column widths, resizable and remembered.',
      },
      {
        pt: 'O custo de uma tarefa mostra as requisições premium do Copilot como valor em dinheiro (aproximado).',
        en: 'Task cost shows Copilot premium requests as money (approximate).',
      },
    ],
    fixes: [
      {
        pt: 'As telas de carregamento ficam centralizadas na janela.',
        en: 'Loading screens are centred in the window.',
      },
      {
        pt: 'A Home se recupera sozinha quando as métricas ainda estão subindo.',
        en: 'Home recovers on its own when the metrics are still warming up.',
      },
      {
        pt: 'Sessões não aparecem mais como encerradas por causa de configuração de idioma do sistema.',
        en: 'Sessions no longer show as ended because of the system language setting.',
      },
    ],
  },
  '2.111.1': {
    features: [
      {
        pt: 'Nova tela de carregamento clássica, do primeiro quadro até o app abrir.',
        en: 'A new classic loading screen, from the first frame until the app opens.',
      },
      {
        pt: 'Respostas com citação aparecem como blocos de citação no campo de mensagem e na mensagem enviada, com "mostrar mais/menos" e remoção.',
        en: 'Quoted replies appear as quote blocks in the composer and in the sent message, with show more/less and remove.',
      },
      {
        pt: 'Os discos dos seus projetos são descobertos automaticamente, com chaves para ligar e desligar cada um.',
        en: 'Your project disks are discovered automatically, with a switch for each one.',
      },
      {
        pt: 'No celular, o modo de chat vira uma lista e as notificações ficam sempre visíveis.',
        en: 'On mobile, chat mode becomes a list and notifications stay on screen.',
      },
    ],
    fixes: [
      {
        pt: 'Os pedidos de aprovação do Codex 0.160.1 mostram a pergunta no chat.',
        en: 'Codex 0.160.1 approval prompts show the question in the chat.',
      },
      {
        pt: 'O sino de sessões silenciadas conta só as sessões em execução.',
        en: 'The muted-sessions bell counts only running sessions.',
      },
    ],
  },
}
