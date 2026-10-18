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
