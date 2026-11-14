import React from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import { METHOD_STAMP } from '../lib/benchmarkView'
import { Bar, TONE_VAR } from '../components/benchmark/BenchStyle'

type Pair = readonly [string, string]
const S: { title: Pair; body: Pair[] }[] = [
  { title: ['É uma competição justa', 'It is a fair competition'], body: [
    ['Imagine duas pessoas fazendo a mesma prova. Para ser justo, as duas recebem as mesmas perguntas, começam do mesmo ponto e não veem as respostas da outra.', 'Imagine two people taking the same exam. To be fair, both get the same questions, start from the same point and cannot see the other\'s answers.'],
    ['Aqui é igual. Os dois jeitos de trabalhar recebem as mesmas tarefas e partem do mesmo código. Depois, testes escondidos e um juiz de outro modelo corrigem tudo. O juiz não sabe qual lado está lendo.', 'It is the same here. Both ways of working get the same tasks and start from the same code. Then hidden tests and a judge from another model grade everything. The judge does not know which side it is reading.'],
  ] },
  { title: ['A nota vai de 0 a 100', 'The score goes from 0 to 100'], body: [
    ['Quanto mais perto de 100, mais compensou. 50 é empate. A nota é sempre sobre o lado novo, em comparação com o outro.', 'The closer to 100, the more it paid off. 50 is a tie. The score is always about the new side, compared with the other.'],
  ] },
  { title: ['São quatro matérias, e cada uma vale pontos', 'Four subjects, each worth points'], body: [
    ['Como numa prova em que algumas matérias valem mais. Somando os pontos das quatro, você tem a nota final.', 'Like an exam where some subjects weigh more. Adding the points of the four gives the final score.'],
  ] },
  { title: ['Como cada matéria ganha pontos', 'How each subject earns points'], body: [
    ['Empatou naquela matéria? Fica com a metade dos pontos. Foi melhor, ganha mais. Foi pior, ganha menos. Em Qualidade, que vale até 40: igual = 20 de 40; 2 vezes melhor = 27 de 40; 2 vezes pior = 13 de 40.', 'A tie in that subject earns half the points; better earns more, worse earns less. In Quality, worth up to 40: equal = 20 of 40; 2 times better = 27 of 40; 2 times worse = 13 of 40.'],
    ['Numa matéria, só conta como melhor ou pior se a diferença passar de 1,25 vez. Menos que isso é empate. O risquinho no meio de cada barra é o ponto de empate daquela matéria.', 'In a subject, it only counts as better or worse if the difference exceeds 1.25 times. Less is a tie. The tick in the middle of each bar is that subject\'s tie point.'],
  ] },
  { title: ['Empate não quer dizer igual', 'A tie does not mean equal'], body: [
    ['A nota também tem folga, a margem de erro. Se a nota com a folga ainda fica acima do empate, é Compensou. Se fica abaixo, é Não compensou. Se fica perto demais, é Empate.', 'The score also has slack, the margin of error. If the score with the slack is still above the tie, it is Paid off. If below, Did not pay off. If too close, Tie.'],
  ] },
  { title: ['"Resultado firme" ou "Depende do que você valoriza"', '"Firm result" or "Depends on what you value"'], body: [
    ['O Benchmark refaz a conta dando outros valores às matérias. Se o resultado continua o mesmo, ele é firme. Se muda, a tela avisa: depende de você achar mais importante a qualidade ou a economia.', 'The Benchmark redoes the sum giving other weights to the subjects. If the result stays the same it is firm. If it changes, the screen says so: it depends on whether you value quality or economy more.'],
  ] },
  { title: ['Quando não aparece nota', 'When no score appears'], body: [
    ['Se foram poucas tarefas, a tela mostra "Sem dados ainda" e diz o que falta. É melhor não dar nota do que dar uma nota inventada. O mínimo é 8 tarefas, cada uma feita 2 vezes por cada lado, com 5 entregas aceitas em cada lado.', 'With few tasks the screen shows "No data yet" and says what is missing. No score is better than an invented one. The minimum is 8 tasks, each run 2 times per side, with 5 accepted deliveries on each side.'],
  ] },
  { title: ['O que a nota não sabe', 'What the score does not know'], body: [
    ['Ela não mede quanto da sua atenção cada jeito de trabalhar tomou, nem o valor de cada entrega para o seu negócio. Ela vale para as tarefas e projetos testados, e não para qualquer pessoa em qualquer situação.', 'It does not measure how much of your attention each way of working took, nor the value of each delivery to your business. It holds for the tasks and projects tested, not for anyone in any situation.'],
  ] },
]
const WEIGHTS: { pt: string; en: string; max: number; qpt: string; qen: string }[] = [
  { pt: 'Qualidade', en: 'Quality', max: 40, qpt: 'Ficou certo? Passou nos testes escondidos, sem defeitos?', qen: 'Was it right? Did it pass the hidden tests, without defects?' },
  { pt: 'Custo', en: 'Cost', max: 30, qpt: 'Quanto gastou para ter uma entrega aceita?', qen: 'What did it cost to get an accepted delivery?' },
  { pt: 'Tempo', en: 'Time', max: 20, qpt: 'Quanto demorou até ficar pronto?', qen: 'How long until it was done?' },
  { pt: 'Confiabilidade', en: 'Reliability', max: 10, qpt: 'Se fizer de novo, sai igual ou cada hora de um jeito?', qen: 'Done again, is it the same or different each time?' },
]
const TECH: { h: Pair; p: Pair }[] = [
  { h: ['Pontos e nota', 'Points and score'], p: ['pontos do tipo = máximo × razão ÷ (razão + 1). Razão é quantas vezes o comparado foi melhor. nota final = soma dos pontos. Trocar os lados dá o espelho exato: 60 vira 40.', 'type points = max × ratio ÷ (ratio + 1). Ratio is how many times better the compared side was. final score = sum of points. Swapping sides gives the exact mirror: 60 becomes 40.'] },
  { h: ['Razões', 'Ratios'], p: ['A razão de um tipo é a média geométrica das suas métricas. Em taxas, compara as falhas: 22% contra 9% é 2,4× melhor. Quando alguma contagem é zero, soma-se 0,5 aos dois lados, o que puxa para o empate. Custo usa só o custo por entrega aceita. Entrega rejeitada é falha e fica fora desse custo.', 'A type\'s ratio is the geometric mean of its metrics. For rates it compares failures: 22% against 9% is 2.4× better. When a count is zero, 0.5 is added to both sides, pulling toward a tie. Cost uses only cost per accepted delivery. A rejected delivery is a failure and stays out of that cost.'] },
  { h: ['Retrabalho', 'Rework'], p: ['Fica fora da nota: as rodadas de QA já estão em Custo e Tempo, e as correções depois de publicar contam em Qualidade. Rodadas até aprovar e código descartado aparecem só como evidência.', 'It stays out of the score: QA rounds are already in Cost and Time, and fixes after publishing count in Quality. Rounds until approval and discarded code appear only as evidence.'] },
  { h: ['Vereditos', 'Verdicts'], p: ['Nota final: "Compensou" se toda a margem fica acima de 52; "Não compensou" se toda abaixo de 48. Tipos e tarefas, sem margem própria: até 1,25× para cada lado é empate; acima disso, compensou ou não compensou. O comparado não recebe "Compensou" com menos aceitas que a referência além da margem. A margem vem de reamostrar as tarefas, com semente guardada, e qualquer pessoa pode reproduzir.', 'Final score: "Paid off" if the whole margin is above 52; "Did not pay off" if all below 48. Types and tasks, with no margin of their own: up to 1.25× either way is a tie; beyond that, paid off or not. The compared side does not get "Paid off" with fewer accepted deliveries than the reference beyond the margin. The margin comes from resampling the tasks with a stored seed, and anyone can reproduce it.'] },
  { h: ['Teste de firmeza', 'Firmness test'], p: ['Refaz a conta com pesos iguais, 55/20/15/10 e 25/40/25/10.', 'Redoes the sum with equal weights, 55/20/15/10 and 25/40/25/10.'] },
  { h: ['Como o instrumento é testado', 'How the instrument is tested'], p: ['Um método contra ele mesmo não pode apontar vencedor, e um defeito plantado precisa ser encontrado. Só depois disso o benchmark vale.', 'A method against itself cannot name a winner, and a planted defect must be found. Only after that does the benchmark count.'] },
  { h: ['De onde vêm os dados', 'Where the data comes from'], p: ['Qualidade: testes executados depois de cada execução e avaliador cego de outro modelo. Custo: tokens de cada turno × tabela de preços (preço de tabela, não fatura). Tempo: início e fim de cada sessão. Confiabilidade: repetições da mesma tarefa.', 'Quality: tests run after each execution and a blind evaluator from another model. Cost: per-turn tokens × price table (list price, not invoice). Time: start and end of each session. Reliability: repeats of the same task.'] },
]

export function BenchmarkHowItWorksPage() {
  const { lang } = useOutletContext<AppContext>()
  const pt = lang === 'pt', i = pt ? 0 : 1
  const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: '15px 18px' }
  const p: React.CSSProperties = { margin: '0 0 8px', fontSize: 14, lineHeight: 1.55, color: 'var(--text-secondary)' }
  const colors: [keyof typeof TONE_VAR, string, string][] = [
    ['good', pt ? 'Verde: compensou' : 'Green: paid off', pt ? 'Deu mais retorno do que custou.' : 'Gave more return than it cost.'],
    ['tie', pt ? 'Amarelo: empate' : 'Amber: tie', pt ? 'Ficou perto demais para dizer quem ganhou.' : 'Too close to say who won.'],
    ['bad', pt ? 'Vermelho: não compensou' : 'Red: did not pay off', pt ? 'Custou mais do que entregou.' : 'Cost more than it delivered.'],
  ]
  return <main data-testid="benchmark-how-page" style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 12, minWidth: 0 }}>
    <Link to="/benchmark" style={{ color: 'var(--text-secondary)', fontSize: 12.5, textDecoration: 'none', display: 'inline-flex', gap: 4, alignItems: 'center' }}><ChevronLeft size={14} />{pt ? 'Voltar ao Benchmark' : 'Back to Benchmark'}</Link>
    <h1 style={{ margin: '4px 0 2px', fontSize: 25 }}>{pt ? 'Como funciona o Benchmark' : 'How the Benchmark works'}</h1>
    <p style={{ ...p, fontSize: 15, margin: 0 }}>{pt ? 'Dois jeitos de trabalhar fazem a mesma lição. Um juiz corrige sem saber de quem é. No fim, cada um ganha uma nota. É só isso.' : 'Two ways of working do the same lesson. A judge grades without knowing whose it is. In the end each gets a score. That is all.'}</p>
    {S.map((s, n) => <section key={n} style={card}>
      <h2 style={{ margin: '0 0 7px', fontSize: 16, display: 'flex', gap: 9, alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 23, height: 23, flex: 'none', borderRadius: '50%', background: 'color-mix(in srgb, var(--accent-cyan, var(--accent-blue)) 14%, transparent)', color: 'var(--accent-cyan, var(--accent-blue))', fontSize: 12.5, fontWeight: 800 }}>{n + 1}</span>{s.title[i]}</h2>
      {s.body.map((b, k) => <p key={k} style={p}>{b[i]}</p>)}
      {n === 1 && <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8, fontSize: 14 }}>{colors.map(([t, a, b]) => <div key={t} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}><b style={{ minWidth: 150, color: TONE_VAR[t] }}>{a}</b><span style={{ color: 'var(--text-secondary)' }}>{b}</span></div>)}</div>}
      {n === 2 && <>{WEIGHTS.map(w => <div key={w.en} style={{ display: 'grid', gridTemplateColumns: '128px minmax(0,1fr) 60px', gap: '4px 12px', alignItems: 'center', fontSize: 13.5, margin: '10px 0' }}>
        <b>{pt ? w.pt : w.en}</b><Bar value={w.max} tone="rate" mark={false} /><span style={{ textAlign: 'right', fontWeight: 800 }}>{pt ? 'até' : 'up to'} {w.max}</span>
        <span style={{ gridColumn: '1/-1', color: 'var(--text-secondary)' }}>{pt ? w.qpt : w.qen}</span></div>)}
        <p style={p}>{pt ? 'Por que Qualidade vale mais? Porque não adianta economizar para receber algo errado. Essa divisão é uma escolha, não uma lei: nenhum estudo diz quais são os números certos. Ela foi fixada antes de sair qualquer resultado, para ninguém mexer depois até o seu lado ganhar.' : 'Why does Quality weigh more? Because saving money to receive something wrong is pointless. This split is a choice, not a law: no study says what the right numbers are. It was fixed before any result came out, so nobody changes it afterwards until their side wins.'}</p></>}
    </section>)}
    <details style={card}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14.5 }}>{pt ? 'Para quem quer ver a conta (parte técnica)' : 'For those who want to see the math (technical)'}</summary>
      {TECH.map(t => <div key={t.h[0]}><h3 style={{ margin: '13px 0 4px', fontSize: 13.5 }}>{t.h[i]}</h3><p style={{ ...p, fontSize: 13 }}>{t.p[i]}</p></div>)}
      <h3 style={{ margin: '13px 0 4px', fontSize: 13.5 }}>{pt ? 'Versão do método' : 'Method version'}</h3>
      <p data-testid="benchmark-method-version" style={{ ...p, fontSize: 13 }}>{pt ? `Método ${METHOD_STAMP.version}, ${METHOD_STAMP.date.pt}. Todo resultado guarda a versão que o produziu. Mudar o método cria uma versão nova, e resultados antigos não mudam em silêncio.` : `Method ${METHOD_STAMP.version}, ${METHOD_STAMP.date.en}. Every result keeps the version that produced it. Changing the method creates a new version, and old results do not change silently.`}</p>
      <h3 style={{ margin: '13px 0 4px', fontSize: 13.5 }}>{pt ? 'A pesquisa por trás' : 'The research behind it'}</h3>
      <ul style={{ margin: 0, paddingLeft: 17, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        <li>{pt ? 'Pesos são julgamento de valor: ' : 'Weights are a value judgement: '}<a href="https://www.oecd.org/content/dam/oecd/en/publications/reports/2008/08/handbook-on-constructing-composite-indicators-methodology-and-user-guide_g1gh9301/9789264043466-en.pdf" target="_blank" rel="noreferrer">{pt ? 'manual da OCDE sobre indicadores compostos' : 'OECD handbook on composite indicators'}</a>.</li>
        <li>{pt ? 'Equipes de agentes custam de 1,8 a 5,1 vezes mais: ' : 'Agent teams cost 1.8 to 5.1 times more: '}<a href="https://www.vals.ai/blog/multi-agent-vibe-code-bench" target="_blank" rel="noreferrer">Vals AI</a>.</li>
        <li>{pt ? 'Benchmarks costumam mostrar custo e sucesso separados: ' : 'Benchmarks usually show cost and success separately: '}<a href="https://hal.cs.princeton.edu" target="_blank" rel="noreferrer">HAL</a>. {pt ? 'Por isso esta nota é um resumo, e os números ficam abertos.' : 'That is why this score is a summary, and the figures stay open.'}</li>
        <li>{pt ? 'Não encontramos estudo comparando líder + worker + QA com uma sessão em entregas reais.' : 'We found no study comparing leader + worker + QA with a single session on real deliveries.'}</li>
      </ul>
    </details>
  </main>
}
