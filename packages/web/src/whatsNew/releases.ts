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
