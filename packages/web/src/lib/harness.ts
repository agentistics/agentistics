import type { SurfaceHarnessId, HarnessCapabilities } from '@agentistics/core'
import { HARNESS_CAPABILITIES } from '@agentistics/core'

/** Anthropic doc explaining Dynamic Workflows (Claude Code's multi-agent orchestration / subagents).
 *  Surfaced as a "what is this?" doc link next to the Dynamic Workflows headings. */
export const DYNAMIC_WORKFLOWS_DOC = 'https://code.claude.com/docs/en/workflows'

export const HARNESS_LABELS: Record<SurfaceHarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  copilot: 'Copilot CLI',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
  opencode: 'opencode',
  agentistics: 'Agentistics',
}

export const HARNESS_COLORS: Record<SurfaceHarnessId, string> = {
  claude: '#D97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  copilot: '#6e7681',
  // Violet — distinct from Claude's amber, Codex's green, Gemini's blue and Copilot's grey,
  // and legible on both the light and the dark surface.
  antigravity: '#8b5cf6',
  // Rose — the last hue left that stays legible on both surfaces without colliding with the others.
  kimi: '#e11d48',
  // Cyan — distinct from every hue above and legible on both surfaces. opencode has no adapter and
  // never contributes a real session (see HARNESS_INFO.opencode below), so this colour has no chart
  // to appear in today; it exists because the Record requires an entry.
  opencode: '#06b6d4',
  // Agentistics' own brand amber-orange, a step off Claude's amber so the two never read as one series.
  agentistics: '#f97316',
}

/** Provider name shown in pricing links. */
export const HARNESS_PROVIDERS: Record<SurfaceHarnessId, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
  copilot: 'GitHub Copilot',
  antigravity: 'Google',
  kimi: 'Moonshot AI',
  // opencode is a per-model ROUTER, not a vendor: the real store measured for this integration
  // carried models under providerID `opencode` (its own free tier) and `ollama` (a local install),
  // and it can equally run Anthropic/OpenAI/Google models depending on the user's own config. There
  // is no single pricing page to point at, so this names the shape rather than inventing a vendor.
  opencode: 'Multiple providers (opencode routes per model)',
  // The native harness is a client for ANY provider the person configured, so the page links to none.
  agentistics: 'Any configured provider (Anthropic, OpenAI-compatible endpoints, Ollama…)',
}

export function capable(harness: SurfaceHarnessId, metric: keyof HarnessCapabilities): boolean {
  return HARNESS_CAPABILITIES[harness][metric]
}

/** Bilingual text pair. */
export interface Loc {
  pt: string
  en: string
}

export interface HarnessInfo {
  source: string[]
  contains: Loc[]
  missing: { item: Loc; why: Loc }[]
  note?: Loc
  /** Short description of the on-disk format agentistics parses. */
  format?: Loc
  /** How long the data sticks around (cleanup/retention behavior). */
  retention?: Loc
  /** One-line summary of the harness shown at the top of the panel. */
  blurb?: Loc
  /** Link to the provider's official pricing page. */
  pricingUrl?: string
}

export const HARNESS_INFO: Record<SurfaceHarnessId, HarnessInfo> = {
  claude: {
    blurb: {
      en: 'The richest source — full token, cost, model, tool, sub-agent and git data, with aggregate history that outlives transcript cleanup.',
      pt: 'A fonte mais completa — dados de tokens, custos, modelo, ferramentas, sub-agentes e Git, com histórico agregado que sobrevive à limpeza de transcrições.',
    },
    format: {
      en: 'JSONL transcripts (one event per line) plus a pre-aggregated stats-cache.json and per-session meta files.',
      pt: 'Transcrições JSONL (um evento por linha), além de stats-cache.json pré-agregado e arquivos de metadados por sessão.',
    },
    retention: {
      en: 'Transcripts are deleted after the cleanup window (default 30 days), but stats-cache.json keeps the aggregate totals indefinitely.',
      pt: 'As transcrições são excluídas após a janela de limpeza (padrão 30 dias), mas o stats-cache.json mantém os totais agregados indefinidamente.',
    },
    source: [
      '~/.claude/stats-cache.json (aggregate history)',
      '~/.claude/projects/**/*.jsonl (transcripts)',
      '~/.claude/usage-data/session-meta/',
    ],
    contains: [
      { en: 'Tokens (input, output, cache read/write)', pt: 'Tokens (entrada, saída, leitura/escrita de cache)' },
      { en: 'Cost (USD)', pt: 'Custo (USD)' },
      { en: 'Model per session', pt: 'Modelo por sessão' },
      { en: 'Tool usage', pt: 'Uso de ferramentas' },
      { en: 'Sub-agent metrics', pt: 'Métricas de sub-agentes' },
      { en: 'Git line counts', pt: 'Contagem de linhas Git' },
      { en: 'Full session history', pt: 'Histórico completo de sessões' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [],
    note: {
      en: 'The stats cache retains aggregate totals even after Claude Code deletes transcripts older than its cleanup window (default 30 days), so historical session/token/cost totals survive.',
      pt: 'O cache de estatísticas retém os totais agregados mesmo após o Claude Code excluir transcrições mais antigas que sua janela de limpeza (padrão 30 dias), portanto os totais históricos de sessões/tokens/custos sobrevivem.',
    },
    pricingUrl: 'https://www.anthropic.com/pricing',
  },
  codex: {
    blurb: {
      en: 'Near-parity with Claude — real tokens, cost, model and tool usage from full rollout transcripts.',
      pt: 'Paridade quase total com o Claude — tokens reais, custo, modelo e uso de ferramentas a partir de transcrições completas de rollout.',
    },
    format: {
      en: 'Envelope JSONL rollouts (event_msg / response_item wrappers); token usage at payload.info.total_token_usage (cumulative).',
      pt: 'JSONL envelope de rollouts (invólucros event_msg / response_item); uso de tokens em payload.info.total_token_usage (cumulativo).',
    },
    retention: {
      en: 'Codex prunes old rollouts over time; agentistics consolidates per-session metrics so they survive cleanup.',
      pt: 'O Codex remove rollouts antigos ao longo do tempo; o agentistics consolida métricas por sessão para que sobrevivam à limpeza.',
    },
    source: [
      '~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl',
    ],
    contains: [
      { en: 'Tokens (input, cached, output)', pt: 'Tokens (entrada, cache, saída)' },
      { en: 'Cost (USD)', pt: 'Custo (USD)' },
      { en: 'Model (e.g. gpt-5.5)', pt: 'Modelo (ex.: gpt-5.5)' },
      { en: 'Tool usage (e.g. web search)', pt: 'Uso de ferramentas (ex.: pesquisa web)' },
      { en: 'Messages', pt: 'Mensagens' },
      { en: 'Project (working directory)', pt: 'Projeto (diretório de trabalho)' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [
      {
        item: { en: 'Sub-agent metrics', pt: 'Métricas de sub-agentes' },
        why: { en: 'Codex does not record per-subagent breakdowns in its transcripts.', pt: 'O Codex não registra detalhamentos por sub-agente em suas transcrições.' },
      },
      {
        item: { en: 'Git line counts', pt: 'Contagem de linhas Git' },
        why: { en: 'Not present in Codex transcripts.', pt: 'Não está presente nas transcrições do Codex.' },
      },
    ],
    note: {
      en: 'Codex reports input_tokens including the cached portion; agentistics stores the non-cached input separately from cache reads so cost is not double-counted. Sessions are listed in the Sessions tab above.',
      pt: 'O Codex reporta input_tokens incluindo a parcela em cache; o agentistics armazena a entrada não cacheada separadamente das leituras de cache para evitar dupla contagem nos custos. As sessões estão listadas na aba Sessões acima.',
    },
    pricingUrl: 'https://platform.openai.com/docs/pricing',
  },
  gemini: {
    blurb: {
      en: 'Real token/cost/model data from the rich local chat format — but only genuine sessions count (most local files are bootstrap stubs).',
      pt: 'Dados reais de tokens/custo/modelo a partir do rico formato de chat local — mas apenas sessões genuínas são contadas (a maioria dos arquivos locais são stubs de bootstrap).',
    },
    format: {
      en: 'Rich JSON chat files with per-message tokens{input,output,cached} and model; legacy JSONL stubs are filtered out.',
      pt: 'Arquivos JSON ricos de chat com tokens por mensagem {entrada,saída,cache} e modelo; stubs JSONL legados são filtrados.',
    },
    retention: {
      en: 'Gemini CLI applies a session retention window (~30 days) similar to Claude.',
      pt: 'O Gemini CLI aplica uma janela de retenção de sessão (~30 dias) similar ao Claude.',
    },
    source: [
      '~/.gemini/tmp/<project>/chats/*.json (rich session format)',
      '~/.gemini/projects.json (project names)',
    ],
    contains: [
      { en: 'Sessions', pt: 'Sessões' },
      { en: 'Projects', pt: 'Projetos' },
      { en: 'Messages', pt: 'Mensagens' },
      { en: 'Tokens (input, output, cache)', pt: 'Tokens (entrada, saída, cache)' },
      { en: 'Cost (USD)', pt: 'Custo (USD)' },
      { en: 'Model per session', pt: 'Modelo por sessão' },
      { en: 'Tool usage', pt: 'Uso de ferramentas' },
      { en: 'Activity (real-content sessions only)', pt: 'Atividade (somente sessões com conteúdo real)' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [
      {
        item: { en: 'Sub-agent metrics', pt: 'Métricas de sub-agentes' },
        why: { en: 'Gemini CLI does not record per-subagent breakdowns.', pt: 'O Gemini CLI não registra detalhamentos por sub-agente.' },
      },
      {
        item: { en: 'Git line counts', pt: 'Contagem de linhas Git' },
        why: { en: 'Not present in Gemini session files.', pt: 'Não está presente nos arquivos de sessão do Gemini.' },
      },
    ],
    note: {
      en: 'Many local Gemini files are bootstrap-only stubs with no real conversation — only sessions containing genuine user messages are counted. Token/cost/model data comes from the rich ~/.gemini/tmp/<project>/chats/*.json format. Agent metrics and git line counts are N/A. Sessions are listed in the Sessions tab above.',
      pt: 'Muitos arquivos locais do Gemini são stubs somente de bootstrap sem conversa real — apenas sessões com mensagens genuínas de usuário são contadas. Dados de tokens/custo/modelo vêm do formato rico ~/.gemini/tmp/<projeto>/chats/*.json. Métricas de agentes e contagem de linhas Git são N/A. As sessões estão listadas na aba Sessões acima.',
    },
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  copilot: {
    blurb: {
      en: 'Sessions, project/branch, messages and assistant turns — plus tokens/cost/model/git-lines on a clean exit.',
      pt: 'Sessões, projeto/branch, mensagens e turnos do assistente — além de tokens/custo/modelo/linhas-Git em saída limpa.',
    },
    format: {
      en: 'events.jsonl (session.start, user.message, assistant.message/turns, session.shutdown with per-model metrics).',
      pt: 'events.jsonl (session.start, user.message, assistant.message/turns, session.shutdown com métricas por modelo).',
    },
    retention: {
      en: 'Local session-state persists per session; token/cost/model/line data is only present when the session shut down cleanly.',
      pt: 'O estado da sessão local persiste por sessão; dados de tokens/custo/modelo/linhas só estão presentes quando a sessão encerrou normalmente.',
    },
    source: [
      '~/.copilot/session-state/<id>/events.jsonl',
      '~/.copilot/session-state/<id>/workspace.yaml',
    ],
    contains: [
      { en: 'Sessions', pt: 'Sessões' },
      { en: 'Project / repository / branch', pt: 'Projeto / repositório / branch' },
      { en: 'Messages', pt: 'Mensagens' },
      { en: 'Assistant turns', pt: 'Turnos do assistente' },
      { en: 'Tokens (input, output)', pt: 'Tokens (entrada, saída)' },
      { en: 'Cost (USD)', pt: 'Custo (USD)' },
      { en: 'Model per session', pt: 'Modelo por sessão' },
      { en: 'Git line counts', pt: 'Contagem de linhas Git' },
      { en: 'MCP usage', pt: 'Uso de MCP' },
      { en: 'Activity', pt: 'Atividade' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [
      {
        item: { en: 'Tool usage', pt: 'Uso de ferramentas' },
        why: { en: 'Copilot CLI does not record per-tool call breakdowns.', pt: 'O Copilot CLI não registra detalhamentos por chamada de ferramenta.' },
      },
      {
        item: { en: 'Sub-agent metrics', pt: 'Métricas de sub-agentes' },
        why: { en: 'Not available in Copilot local event logs.', pt: 'Não disponível nos logs de eventos locais do Copilot.' },
      },
    ],
    note: {
      en: 'Token/cost/model/git-lines data is emitted in the session.shutdown event on clean exit only — sessions that crashed will show 0 for those fields.',
      pt: 'Dados de tokens/custo/modelo/linhas-Git são emitidos no evento session.shutdown somente em saída limpa — sessões que travaram exibirão 0 nesses campos.',
    },
    pricingUrl: 'https://docs.github.com/en/copilot/about-github-copilot/plans-for-github-copilot',
  },
  kimi: {
    blurb: {
      en: 'Sessions, projects, messages, tool usage, tokens, model and cost. Kimi routes to other providers and stamps that provider\'s own model on every usage record, so the cost is calculated from the same pricing table every other harness uses.',
      pt: 'Sessões, projetos, mensagens, uso de ferramentas, tokens, modelo e custo. O Kimi roteia para outros provedores e grava o modelo do próprio provedor em cada registro de uso, então o custo é calculado pela mesma tabela de preços dos demais harnesses.',
    },
    format: {
      en: 'One directory per session holding a state.json (title, workDir, timestamps, agent tree) and one wire.jsonl per agent. The wire is flat JSONL: usage.record carries the token counts, and context.append_loop_event wraps the loop events (step.begin / step.end / tool.call / tool.result).',
      pt: 'Um diretório por sessão com um state.json (título, workDir, timestamps, árvore de agentes) e um wire.jsonl por agente. O wire é JSONL plano: usage.record carrega a contagem de tokens e context.append_loop_event envolve os eventos do loop (step.begin / step.end / tool.call / tool.result).',
    },
    retention: {
      en: 'No automatic cleanup: sessions persist under ~/.kimi-code/sessions indefinitely.',
      pt: 'Sem limpeza automática: as sessões persistem em ~/.kimi-code/sessions indefinidamente.',
    },
    source: [
      '~/.kimi-code/sessions/<workspace>/session_<id>/state.json',
      '~/.kimi-code/sessions/<workspace>/session_<id>/agents/<agent>/wire.jsonl',
      '~/.kimi-code/session_index.jsonl (workDir per session)',
    ],
    contains: [
      { en: 'Sessions', pt: 'Sessões' },
      { en: 'Project (workDir)', pt: 'Projeto (workDir)' },
      { en: 'Title (state.json)', pt: 'Título (state.json)' },
      { en: 'Messages (user prompts + assistant steps)', pt: 'Mensagens (prompts do usuário + passos do assistente)' },
      { en: 'Tokens (input, output, cache read, cache creation)', pt: 'Tokens (entrada, saída, leitura e criação de cache)' },
      { en: 'Model (provider prefix stripped, e.g. gemini-3.5-flash-lite)', pt: 'Modelo (sem o prefixo do provedor, ex.: gemini-3.5-flash-lite)' },
      { en: 'Cost (USD, derived via the shared pricing table)', pt: 'Custo (USD, derivado pela tabela de preços compartilhada)' },
      { en: 'Tool usage (Read, Write, Edit, Bash, Agent …) and MCP calls (mcp__ prefix)', pt: 'Uso de ferramentas (Read, Write, Edit, Bash, Agent …) e chamadas MCP (prefixo mcp__)' },
      { en: 'Sub-agent work, folded into the session that spawned it', pt: 'Trabalho de sub-agentes, consolidado na sessão que os criou' },
      { en: 'Start / end / duration and activity hours', pt: 'Início / fim / duração e horários de atividade' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [
      {
        item: { en: 'Prices for Kimi\'s own models', pt: 'Preços dos modelos próprios do Kimi' },
        why: {
          en: 'Routed provider models (google/…, etc.) price correctly. Kimi-native `kimi-*` ids are not in the pricing table yet, so — like any unknown id on any harness — they would take the shared fallback rate until verified prices are added.',
          pt: 'Modelos roteados de provedores (google/…, etc.) são precificados corretamente. Os ids nativos `kimi-*` ainda não estão na tabela, então — como qualquer id desconhecido em qualquer harness — usariam a tarifa padrão até que preços verificados sejam adicionados.',
        },
      },
      {
        item: { en: 'Git remote / branch', pt: 'Remote / branch do git' },
        why: { en: 'Not recorded in the session metadata.', pt: 'Não são gravados nos metadados da sessão.' },
      },
      {
        item: { en: 'Lines added / removed', pt: 'Linhas adicionadas / removidas' },
        why: {
          en: 'Edit stores the old and new strings but no diff counter, so a count would have to be recomputed rather than read.',
          pt: 'O Edit guarda as strings antiga e nova, mas nenhum contador de diff, então a contagem teria de ser recalculada em vez de lida.',
        },
      },
    ],
    note: {
      en: 'Each step.end event repeats the usage numbers of its matching usage.record, byte for byte. Only usage.record is counted — summing both would double every figure.',
      pt: 'Cada evento step.end repete os números de uso do usage.record correspondente, byte a byte. Só o usage.record é contado — somar os dois dobraria todos os valores.',
    },
    pricingUrl: 'https://platform.moonshot.ai/docs/pricing',
  },
  antigravity: {
    blurb: {
      en: 'Sessions, projects, messages, tool usage AND tokens/model/cost. Tokens and the technical model id are decoded from the gen_metadata protobuf rows inside conversations/<conversation-id>.db; cost is then derived through the standard pricing table, exactly like every other harness.',
      pt: 'Sessões, projetos, mensagens, uso de ferramentas E tokens/modelo/custo. Os tokens e o id técnico do modelo são decodificados das linhas protobuf gen_metadata dentro de conversations/<conversation-id>.db; o custo é então derivado pela tabela de preços padrão, exatamente como nos demais harnesses.',
    },
    format: {
      en: 'Step-based JSONL transcripts (one step per line: USER_INPUT / PLANNER_RESPONSE / VIEW_FILE / RUN_COMMAND / SEARCH_WEB / ERROR_MESSAGE / INVOKE_SUBAGENT …), a global history.jsonl that maps each conversation to its workspace, and one SQLite DB per conversation whose gen_metadata table holds a protobuf blob per LLM call.',
      pt: 'Transcrições JSONL baseadas em passos (um passo por linha: USER_INPUT / PLANNER_RESPONSE / VIEW_FILE / RUN_COMMAND / SEARCH_WEB / ERROR_MESSAGE / INVOKE_SUBAGENT …), um history.jsonl global que associa cada conversa ao seu workspace e um banco SQLite por conversa cuja tabela gen_metadata guarda um blob protobuf por chamada ao modelo.',
    },
    retention: {
      en: 'Transcripts and conversation DBs persist per conversation; agentistics consolidates per-session metrics so they survive any future cleanup.',
      pt: 'As transcrições e os bancos por conversa persistem; o agentistics consolida as métricas por sessão para que sobrevivam a qualquer limpeza futura.',
    },
    source: [
      '~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl',
      '~/.gemini/antigravity-cli/conversations/<conversation-id>.db (gen_metadata → tokens + model)',
      '~/.gemini/antigravity-cli/history.jsonl (prompts + workspace hint per conversation)',
      '~/.gemini/antigravity-cli/conversation_summaries.db (optional: title, parent link)',
    ],
    contains: [
      { en: 'Sessions', pt: 'Sessões' },
      { en: 'Project (workspace / cwd)', pt: 'Projeto (workspace / cwd)' },
      { en: 'Messages (user + assistant replies)', pt: 'Mensagens (usuário + respostas do assistente)' },
      { en: 'Tokens (input, cache read, output — output already includes thinking)', pt: 'Tokens (entrada, leitura de cache, saída — a saída já inclui o thinking)' },
      { en: 'Model (technical id, e.g. gemini-3.6-flash)', pt: 'Modelo (id técnico, ex.: gemini-3.6-flash)' },
      { en: 'Cost (USD, derived via the shared pricing table)', pt: 'Custo (USD, derivado pela tabela de preços compartilhada)' },
      { en: 'Tool usage (view_file, run_command, search_web …)', pt: 'Uso de ferramentas (view_file, run_command, search_web …)' },
      { en: 'Tool errors (ERROR_MESSAGE steps + non-zero exit codes)', pt: 'Erros de ferramenta (passos ERROR_MESSAGE + códigos de saída diferentes de zero)' },
      { en: 'Files modified (from the edit payloads) and lines ADDED', pt: 'Arquivos modificados (a partir dos payloads de edição) e linhas ADICIONADAS' },
      { en: 'Sub-agent (invoke_subagent) spend and work, folded into the parent session', pt: 'Gasto e trabalho dos sub-agentes (invoke_subagent), consolidados na sessão pai' },
      { en: 'Start / end / duration and activity hours', pt: 'Início / fim / duração e horários de atividade' },
      { en: 'Active session time (per-turn)', pt: 'Tempo ativo da sessão (por turno)' },
    ],
    missing: [
      {
        item: { en: 'Cache-write tokens', pt: 'Tokens de escrita de cache' },
        why: {
          en: 'gen_metadata records the cache READ count only; there is no separate cache-creation counter, so that field stays 0 and never inflates cost.',
          pt: 'O gen_metadata registra apenas a LEITURA de cache; não existe contador separado de criação de cache, então esse campo permanece 0 e nunca infla o custo.',
        },
      },
      {
        item: { en: 'Per-sub-agent breakdown', pt: 'Detalhamento por sub-agente' },
        why: {
          en: 'An invoke_subagent child is a whole conversation of its own (own transcript, own DB) instead of an agent invocation recorded on the parent. Its tokens, cost and work ARE counted — folded into the parent session — but there is no per-invocation list to show, so no sub-agent table is rendered.',
          pt: 'Um filho de invoke_subagent é uma conversa inteira própria (transcrição e banco próprios), em vez de uma invocação de agente registrada no pai. Os tokens, o custo e o trabalho dele SÃO contabilizados — consolidados na sessão pai — mas não há lista por invocação para exibir, então nenhuma tabela de sub-agentes é renderizada.',
        },
      },
      {
        item: { en: 'Lines removed (git line counts)', pt: 'Linhas removidas (contagem de linhas do Git)' },
        why: {
          en: 'Counting removals needs the replaced blob (TargetContent), which agy does not write for its normal edit path — so removals are structurally 0 and cannot be trusted. Rather than show a confident fake 0, the line-count metric is reported as N/A for this harness. Files modified is NOT affected and stays real.',
          pt: 'Contar remoções exige o trecho substituído (TargetContent), que o agy não grava no caminho normal de edição — então as remoções são estruturalmente 0 e não são confiáveis. Em vez de exibir um 0 falso e confiante, a métrica de contagem de linhas é reportada como N/A neste harness. Arquivos modificados NÃO é afetado e continua real.',
        },
      },
      {
        item: { en: 'Git commits / pushes / remote', pt: 'Commits / pushes / remoto do Git' },
        why: {
          en: 'Antigravity stores no git metadata on disk. Any line counts kept per session are edit deltas computed from the transcript, not `git diff` output.',
          pt: 'O Antigravity não guarda metadados do git em disco. As contagens de linhas mantidas por sessão são deltas de edição calculados a partir da transcrição, não a saída de `git diff`.',
        },
      },
    ],
    note: {
      en: 'Antigravity shares the ~/.gemini home with the Gemini CLI but is a separate harness: it lives in ~/.gemini/antigravity-cli, while the Gemini CLI adapter only reads ~/.gemini/tmp — the two never overlap or double-count. Conversation DBs are opened read-only and a missing, locked or corrupt DB degrades to zero tokens instead of failing. Output tokens already include the thinking tokens, so they are never added on top. Replayed CONVERSATION_HISTORY steps are skipped so a resumed conversation is not counted twice, and slash commands (/model, /usage …) are not treated as prompts. invoke_subagent children are detected from the parent transcript (never from history.jsonl, which rotates) and are FOLDED INTO the parent session: a child stores its own generations in its own conversations/<child>.db, so its tokens, cost, tools, files and errors are added to the parent — exactly like an Agent tool call belongs to the Claude Code session that spawned it — and the child does not appear as a separate session. Every gen_metadata row on disk is counted exactly once. Because a parent and its sub-agents often run different models (an Opus parent dispatching Gemini Flash sub-agents), the merged session keeps a per-model token breakdown and is priced per model; the single model label shown is the parent\'s own dominant model.',
      pt: 'O Antigravity compartilha a pasta ~/.gemini com o Gemini CLI, mas é um harness separado: fica em ~/.gemini/antigravity-cli, enquanto o adaptador do Gemini CLI lê apenas ~/.gemini/tmp — os dois nunca se sobrepõem nem contam em dobro. Os bancos por conversa são abertos somente leitura e um banco ausente, travado ou corrompido resulta em zero tokens em vez de erro. Os tokens de saída já incluem os de thinking, então nunca são somados de novo. Passos CONVERSATION_HISTORY reproduzidos são ignorados para que uma conversa retomada não seja contada duas vezes, e comandos de barra (/model, /usage …) não são tratados como prompts. Os filhos de invoke_subagent são detectados pela transcrição do pai (nunca pelo history.jsonl, que rotaciona) e são CONSOLIDADOS na sessão pai: um filho guarda as próprias gerações no seu próprio conversations/<filho>.db, então os tokens, o custo, as ferramentas, os arquivos e os erros dele são somados ao pai — exatamente como uma chamada da ferramenta Agent pertence à sessão do Claude Code que a disparou — e o filho não aparece como sessão separada. Cada linha de gen_metadata em disco é contada exatamente uma vez. Como pai e sub-agentes muitas vezes rodam modelos diferentes (um pai Opus despachando sub-agentes Gemini Flash), a sessão consolidada mantém um detalhamento de tokens por modelo e é precificada por modelo; o rótulo único de modelo exibido é o modelo dominante do próprio pai.',
    },
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  opencode: {
    blurb: {
      en: 'No local adapter yet — opencode sessions never appear in this dashboard. Its own SQLite store carries real tokens, cost, model and tool data; a replay integration reads it for the canonical event journal, but nothing today projects it into a session you can see here.',
      pt: 'Ainda sem adaptador local — sessões do opencode nunca aparecem neste painel. O banco SQLite próprio do opencode guarda tokens, custo, modelo e ferramentas reais; uma integração de replay já os lê para o diário canônico de eventos, mas nada hoje projeta isso em uma sessão visível aqui.',
    },
    format: {
      en: 'A single SQLite database (~/.local/share/opencode/opencode.db): a session row per conversation with pre-summed totals, one message row per turn, one part row per tool call or usage step.',
      pt: 'Um único banco SQLite (~/.local/share/opencode/opencode.db): uma linha de sessão por conversa com totais já somados, uma linha de mensagem por turno, uma linha de "part" por chamada de ferramenta ou etapa de uso.',
    },
    retention: {
      en: 'Unknown — no cleanup behavior has been observed or documented for this store.',
      pt: 'Desconhecido — nenhum comportamento de limpeza foi observado ou documentado para esse banco.',
    },
    source: [
      '~/.local/share/opencode/opencode.db (session/message/part tables)',
    ],
    contains: [],
    missing: [
      {
        item: { en: 'Everything — no adapter', pt: 'Tudo — sem adaptador' },
        why: {
          en: 'There is no adapters/opencode.ts / opencode-parse.ts. opencode never contributes a SessionMeta, so it never appears in AppData.harnesses, the harness selector, the Compare page, or any dashboard total — deliberately, until a legacy adapter is built (see CLAUDE.md "Adding a harness" step 4).',
          pt: 'Não existe adapters/opencode.ts / opencode-parse.ts. O opencode nunca gera um SessionMeta, então nunca aparece em AppData.harnesses, no seletor de harness, na página Compare ou em nenhum total do painel — deliberadamente, até que um adaptador legado seja construído (ver CLAUDE.md, passo 4 de "Adding a harness").',
        },
      },
    ],
    note: {
      en: 'A separate opencode-local.db file exists on some machines (a per-project store from an earlier opencode version); this integration reads only the current global opencode.db and does not merge the two.',
      pt: 'Em algumas máquinas existe também um opencode-local.db separado (um banco por projeto de uma versão anterior do opencode); esta integração lê apenas o opencode.db global atual e não mescla os dois.',
    },
  },
  agentistics: {
    blurb: {
      en: 'The native Agentistics harness: sessions run by Agentistics itself (agentop code, the web chat) on the provider you configured. Its figures come from its own journal — every billed model call, counted as it happened.',
      pt: 'O harness nativo do Agentistics: sessões executadas pelo próprio Agentistics (agentop code, o chat da web) no provedor que você configurou. Os números vêm do próprio diário — cada chamada de modelo cobrada, contada quando aconteceu.',
    },
    format: {
      en: 'No transcript file to parse: the runtime writes canonical events to the Agentistics journal (model.completed, tool.requested, run.started…), and the session store keeps the conversation.',
      pt: 'Não há arquivo de transcrição para ler: o runtime grava eventos canônicos no diário do Agentistics (model.completed, tool.requested, run.started…) e o armazenamento de sessões guarda a conversa.',
    },
    retention: {
      en: 'Kept until you delete the session (or the journal). Nothing is cleaned up behind your back.',
      pt: 'Mantido até você apagar a sessão (ou o diário). Nada é limpo pelas suas costas.',
    },
    source: [
      '~/.agentistics/runtime/sessions.db (the session store)',
      '~/.agentistics/journal (the canonical event journal)',
    ],
    contains: [
      { en: 'Tokens per model call (input, output, cache read, cache write) as the provider reported them', pt: 'Tokens por chamada de modelo (entrada, saída, leitura e escrita de cache) como o provedor informou' },
      { en: 'Cost — the provider\'s own figure when it stated one, else the pricing table; a model with no price is shown as unknown, never guessed', pt: 'Custo — o valor do próprio provedor quando ele informou, senão a tabela de preços; um modelo sem preço aparece como desconhecido, nunca estimado' },
      { en: 'Model and provider of every call, the project and repository, the task a session is filed under', pt: 'Modelo e provedor de cada chamada, o projeto e o repositório, a tarefa em que a sessão está arquivada' },
      { en: 'Tool calls by name, with their errors', pt: 'Chamadas de ferramenta por nome, com os erros' },
    ],
    missing: [
      {
        item: { en: 'Git line counters, per-turn active time, context gauge', pt: 'Contadores de linhas do Git, tempo ativo por turno, medidor de contexto' },
        why: {
          en: 'The journal does not carry them for native sessions yet, so they show as not measured rather than as zero.',
          pt: 'O diário ainda não os traz para sessões nativas, então aparecem como não medidos em vez de zero.',
        },
      },
    ],
    note: {
      en: 'Experimental: the native harness only shows where `agentop experimental enable` is on.',
      pt: 'Experimental: o harness nativo só aparece onde `agentop experimental enable` está ligado.',
    },
  },
}
