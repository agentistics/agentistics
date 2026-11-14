/**
 * delivery/classify.ts — what KIND of change a piece is, and what evidence that kind needs (spec §3.2, §3.1 binding,
 * §3.3 refusals). PURE: facts in (gathered by `classify-host.ts`), a verdict out. No git, no clock, no store.
 *
 * `unknown` is not `none`: a piece whose checkout cannot be resolved is REFUSED (`classification_required`), never
 * treated as docs or as "nothing changed". A dirty checkout with non-doc changes is `uncommitted_changes` whatever the
 * category — the work the evidence describes must be the work that is committed.
 */
import { canonicalProbeJson, sha256Hex, validateProbe, type EvidenceItem } from './evidence'

export type Category = 'screen' | 'code' | 'docs' | 'none-verified'

export interface ClassifyFacts {
  /** `resolved`: a checkout was found and read. `none`: no session of the piece names a usable checkout. `unreadable`: a repository was found but git failed. `base-unresolved`: no release line to diff against. */
  checkout: 'resolved' | 'none' | 'unreadable' | 'base-unresolved'
  /** Some session filed under the piece recorded a repository cwd at some point (a removed worktree still counts). */
  everHadRepoCwd: boolean
  headSha: string | null
  /** Paths from `git status --porcelain`. */
  dirtyPaths: readonly string[]
  /** Paths from `git diff --name-only <merge-base>..HEAD`. */
  diffPaths: readonly string[]
}

export type Classification =
  | { ok: true; category: Category; headSha: string; treeClean: true; diffPaths: readonly string[]; structuralAllowed: boolean }
  | { ok: false; code: 'classification_required' | 'uncommitted_changes'; message: string; messagePt: string; nonCodeOnly?: boolean; paths?: string[] }

export const isDocPath = (p: string): boolean => p.startsWith('docs/') || p.endsWith('.md')
export const isScreenPath = (p: string): boolean => /^packages\/(?:web|vscode|tui)\//.test(p)
const isTestPath = (p: string): boolean => /(?:\.test\.|\.spec\.|__tests__\/|\.testing\.)/.test(p) || /(?:^|\/)tests?\//.test(p)
const isBuildPath = (p: string): boolean =>
  /^(?:package\.json|bun\.lock|bun\.lockb|tsconfig[^/]*\.json|\.github\/|\.husky\/|scripts\/|Dockerfile|docker\/)/.test(p) || /(?:^|\/)(?:tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s)$/.test(p)

export function classifyPiece(f: ClassifyFacts): Classification {
  if (f.checkout !== 'resolved' || f.headSha === null) {
    const why = f.checkout === 'unreadable' ? 'the repository could not be read' : f.checkout === 'base-unresolved' ? 'no release line (origin/dev, origin/main, dev, main) could be found to compare against' : 'no session filed under it names a repository checkout that still exists'
    const whyPt = f.checkout === 'unreadable' ? 'o repositório não pôde ser lido' : f.checkout === 'base-unresolved' ? 'nenhuma linha de release (origin/dev, origin/main, dev, main) foi encontrada para comparar' : 'nenhuma sessão arquivada nela aponta para um checkout que ainda exista'
    return {
      ok: false, code: 'classification_required', ...(f.everHadRepoCwd ? {} : { nonCodeOnly: true }),
      message: `This piece's checkout could not be resolved (${why}). File the session that did the work, or declare it a non-code outcome (§3.6).${f.everHadRepoCwd ? ' A leader can also declare where to look with `agentop flow classify`.' : ' It never had a repository cwd, so it can only take the non-code path.'}`,
      messagePt: `O checkout desta peça não pôde ser resolvido (${whyPt}). Arquive a sessão que fez o trabalho, ou declare-a um resultado fora de código (§3.6).${f.everHadRepoCwd ? ' Um líder também pode indicar onde olhar com `agentop flow classify`.' : ' Ela nunca teve um cwd de repositório, então só pode seguir o caminho não-código.'}`,
    }
  }
  const nonDocDirty = f.dirtyPaths.filter(p => !isDocPath(p))
  if (nonDocDirty.length > 0) {
    return {
      ok: false, code: 'uncommitted_changes', paths: nonDocDirty,
      message: `The checkout has uncommitted changes (${nonDocDirty.slice(0, 3).join(', ')}${nonDocDirty.length > 3 ? ', …' : ''}). Commit them first: evidence describes committed work.`,
      messagePt: `O checkout tem alterações não commitadas (${nonDocDirty.slice(0, 3).join(', ')}${nonDocDirty.length > 3 ? ', …' : ''}). Faça o commit antes: a evidência descreve trabalho commitado.`,
    }
  }
  const diff = f.diffPaths
  const nonDoc = diff.filter(p => !isDocPath(p))
  const category: Category = diff.length === 0 ? 'none-verified' : diff.some(isScreenPath) ? 'screen' : nonDoc.length > 0 ? 'code' : 'docs'
  const structuralAllowed = category === 'code' && (nonDoc.every(p => isTestPath(p)) || nonDoc.every(p => isBuildPath(p)))
  return { ok: true, category, headSha: f.headSha, treeClean: true, diffPaths: diff, structuralAllowed }
}

// ── evidence requirement ─────────────────────────────────────────────────────
export type EvidenceVerdict =
  | { ok: true; ids: string[] }
  | { ok: false; code: 'evidence_required' | 'evidence_stale'; message: string; messagePt: string; missing: string[] }
  | { ok: false; code: 'evidence_invalid'; rule: string; message: string; messagePt: string; missing: string[] }

const DESKTOP = 'desktop screenshot (≥ 1000 px wide)'
const MOBILE = 'mobile screenshot (≤ 500 px wide)'
const PT: Record<string, string> = {
  [DESKTOP]: 'print desktop (≥ 1000 px)', [MOBILE]: 'print mobile (≤ 500 px)', probe: 'uma sonda', 'API capture or test log': 'uma captura de API ou log de teste',
  'non-structural probe': 'uma sonda não estrutural', report: 'um relatório',
}
const short = (sha: string | null) => (sha ?? 'none').slice(0, 7)

/** What `category` still lacks among `items` (already filtered to the ones that count). */
function missingFor(c: Extract<Classification, { ok: true }>, items: readonly EvidenceItem[]): string[] {
  const missing: string[] = []
  const has = (k: EvidenceItem['kind']) => items.some(i => i.kind === k)
  const probes = items.filter(i => i.kind === 'probe')
  const probeOk = probes.some(p => p.probe?.kind !== 'structural' || c.structuralAllowed)
  if (c.category === 'screen') {
    if (!items.some(i => i.kind === 'screenshot' && (i.width ?? 0) >= 1000)) missing.push(DESKTOP)
    if (!items.some(i => i.kind === 'screenshot' && i.width !== undefined && i.width <= 500)) missing.push(MOBILE)
    if (!probeOk) missing.push(probes.length > 0 ? 'non-structural probe' : 'probe')
  } else if (c.category === 'code') {
    if (!has('api-capture') && !has('test-log')) missing.push('API capture or test log')
    if (!probeOk) missing.push(probes.length > 0 ? 'non-structural probe' : 'probe')
  } else if (!has('report')) missing.push('report')
  return missing
}

const need = (c: Extract<Classification, { ok: true }>): { en: string; pt: string } => {
  if (c.category === 'screen') return { en: `it changed a screen, so it needs a ${DESKTOP}, a ${MOBILE} and one probe`, pt: `ela mudou uma tela, então precisa de um ${PT[DESKTOP]}, um ${PT[MOBILE]} e uma sonda` }
  if (c.category === 'code') return { en: 'it changed code, so it needs an API capture or a test log, and one probe', pt: 'ela mudou código, então precisa de uma captura de API ou log de teste, e uma sonda' }
  return { en: `it changed ${c.category === 'docs' ? 'only documentation' : 'nothing in the repository'}, so it needs a report`, pt: `ela mudou ${c.category === 'docs' ? 'só documentação' : 'nada no repositório'}, então precisa de um relatório` }
}

/**
 * Does `items` satisfy what `classification` requires at ITS HEAD? An item counts only if bound to that HEAD with a clean
 * tree (§3.1). Evidence that would satisfy the requirement but is bound elsewhere is `evidence_stale` (naming both shas);
 * nothing usable is `evidence_required`; a stored probe that is not canonical (extra field, wrong hash) is `evidence_invalid`
 * — the hash must be the one `buildEvidenceItem` computed.
 */
export function evaluateEvidence(c: Extract<Classification, { ok: true }>, items: readonly EvidenceItem[]): EvidenceVerdict {
  for (const i of items) {
    if (i.kind !== 'probe') continue
    const v = i.probe ? validateProbe(i.probe, { headSha: i.headSha, items }) : { ok: false as const, rule: 'probe-missing', message: 'a probe item carries no probe' }
    if (!v.ok) return { ok: false, code: 'evidence_invalid', rule: v.rule, message: `Evidence ${i.id} is invalid: ${v.message}`, messagePt: `A evidência ${i.id} é inválida: ${v.message}`, missing: [] }
    if (i.sha256 !== sha256Hex(new TextEncoder().encode(canonicalProbeJson(i.probe)))) {
      return { ok: false, code: 'evidence_invalid', rule: 'probe-hash-mismatch', message: `Evidence ${i.id} is invalid: its hash is not the canonical hash of its probe.`, messagePt: `A evidência ${i.id} é inválida: o hash não é o hash canônico da sonda.`, missing: [] }
    }
  }
  const current = items.filter(i => i.headSha === c.headSha && i.treeClean)
  const missing = missingFor(c, current)
  if (missing.length === 0) return { ok: true, ids: current.map(i => i.id) }
  const n = need(c)
  const stale = items.filter(i => !(i.headSha === c.headSha && i.treeClean))
  if (stale.length > 0 && missingFor(c, items).length === 0) {
    const old = stale[0]!
    return {
      ok: false, code: 'evidence_stale', missing,
      message: `This piece cannot move to review yet: the attached evidence was taken at ${old.treeClean ? short(old.headSha) : `${short(old.headSha)} with uncommitted changes`} but the piece is now at ${short(c.headSha)}. Capture it again at the current commit.`,
      messagePt: `Esta peça ainda não pode ir para revisão: a evidência anexada foi tirada em ${old.treeClean ? short(old.headSha) : `${short(old.headSha)} com alterações não commitadas`}, mas a peça agora está em ${short(c.headSha)}. Capture de novo no commit atual.`,
    }
  }
  return {
    ok: false, code: 'evidence_required', missing,
    message: `This piece cannot move to review yet: ${n.en}, all taken at the current commit ${short(c.headSha)}. Missing: ${missing.join(', ')}. Attached and current: ${current.length === 0 ? 'none' : current.map(i => i.kind).join(', ')}.`,
    messagePt: `Esta peça ainda não pode ir para revisão: ${n.pt}, todos no commit atual ${short(c.headSha)}. Faltam: ${missing.map(m => PT[m] ?? m).join(', ')}. Anexadas e atuais: ${current.length === 0 ? 'nenhuma' : current.map(i => i.kind).join(', ')}.`,
  }
}
