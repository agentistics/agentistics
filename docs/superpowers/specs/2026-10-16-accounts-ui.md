# ACCT.UI — Settings → Accounts, redesigned (design options)

Status: design, 2026-10-16. Task `t-084a489bf7` (PLAN.ACCOUNTS). Design only: no production code.
The owner picks an option; implementation is a later session.

Builds on `2026-10-15-plan-accounts.md` (registry v2, account roots, the hard availability rule) and
on the C2 payload (`/api/plan-limits`: one row per account, `accountLabel`, hidden accounts).

Prints (desktop 1280 / mobile 390, dark + light): `~/.agentistics/leader/shots/accounts-ui-design/`.
They were rendered by a throwaway prototype that imports the app's REAL components and `index.css`
(`packages/web/proto-accounts/`, kept out of the commit; a copy sits beside the prints in `proto/`).

---

## 1. What the owner saw, and what each defect becomes

Owner print `~/.agentistics/leader/shots/accounts-ui-owner/owner-contas-1155.png`. His words:
"HORRÍVEL, confusa, componentes péssimos, complexo entender a divisão e o funcionamento."

| Defect today (`BillingSettings.tsx`, accounts block) | Root cause | Answer in every option |
|---|---|---|
| Six identical cards "Conta padrão" | The title is `account.label`; a root-keyed harness (gemini/kimi/agy) and an unprobed one both fall back to the literal `Conta padrão` | Title = **nickname → login → "Conta do <Harness>"**; never a bare "Conta padrão". The line under it says WHOSE (the e-mail/login) or, when the harness cannot tell, says so in words |
| The card looks broken in two (toggle row padding ≠ header) | `RowSwitch` (padding `0 2px`) put inside `RecordCard`'s `actions` footer, which is built for `RecordCardAction` buttons (grey 1px separator background) | The switch is a plain `Toggle` in the row itself, on the same padding grid as everything else (12px 14px). `RecordCard.actions` only ever holds `RecordCardAction` |
| "Desligada: continua logada…" repeated 6× | `RowSwitch.sub` on every card | Said **once**, in the section intro. Rows carry only the switch + an `aria-label`; the long sentence appears again only in the detail drawer, for the one account open there |
| No harness icon, no grouping | Flat list, harness as subtitle text | `HarnessMark` + harness name; accounts grouped under their assistant |
| No "add account" | Not built (spec §4) | "Adicionar conta" per assistant (absent with a sentence for Antigravity) + a 3-step drawer |
| No state (logged in? limits? in use?) | `/api/accounts` read alone | Each row: state word + dot (`StatusDot`), sessions running now, 5h/week bars (`PlanLimitBars`) or a sentence when the harness has no meter |
| account ↔ harness ↔ plan not understandable | Plan only as a subtitle suffix, billing far below | Plan named on every row ("Plano não informado" when unknown, never blank); the drawer links to the plan in Billing. Option C goes further and puts the plan timeline under the same tab |

## 2. Component map — the only parts an option may use

Every option below is drawn **only** with these. A hand-rolled variant of any of them is a bug.

| Need | Existing component | Where |
|---|---|---|
| Section title | `SectionHeader` | `pages/settings/primitives.tsx` |
| One-time explanation / info note | `ScopeNote` (orange info box), plain intro `<p>` (BillingSettings' own 12.5px tertiary paragraph) | primitives |
| Account switch inside a row | `Toggle` (34×20 pill, `role=switch` + `aria-label`) | primitives |
| Switch WITH its sentence (drawer only) | `RowSwitch` | primitives |
| State dot (never alone, always with a word) | `StatusDot` | primitives |
| Harness icon | `HarnessMark` | `components/sessions/HarnessMark.tsx` |
| Status pill shape (hidden chip) | the pill of `HarnessStatusBadge` (11px/700, radius 20, tinted border) | `pages/settings/HarnessesSettings.tsx` — to be exported as a small `Pill` primitive, not copied |
| Mobile record | `RecordCard` + `RecordCardAction` | primitives |
| Tabs per harness | `TabSelect` (already used by Billing's timeline) | primitives |
| Plan meters, compact | `PlanLimitBars` | `components/PlanLimitMeter.tsx` |
| Plan meters, full | `PlanLimitsBlock` (`details` adds "updated · source") | PlanLimitMeter |
| Detail / add flow container | `Drawer` (right; full screen on mobile; `dirty` guard) | `components/Drawer.tsx` |
| Text field | `FieldInput` (16px on mobile via the global guard) | primitives |
| Plan / harness picker | `Select` (options carry `hint` + `disabled`) | primitives |
| Buttons | `dialogButtonStyle('primary'|'secondary'|'danger')`, `DialogActions` | primitives |
| Destructive confirm | `ConfirmModal` | primitives |
| Waiting state | `AgentisticsLoader` (inside a panel) / `CenteredLoader placement="area"` | components |
| Muted footnote | `MetricNote` | components |
| Opening a harness login | `useOpenAccountSignIn()` → Usage → Accounts' "Add account" dialog (paste the code); never a session (CONTAS.LOGIN r4) | `lib/accountSignIn.ts` |

Group container (Option A) and table (Option B) reuse the `RecordCard` frame tokens
(`--border`, `--radius-lg`, `--bg-card`, header band `--bg-elevated`) — no new colour, radius or
shadow is introduced.

## 3. What the server really knows (so the screen claims nothing more)

From `harness-accounts.ts` (registry v2) and C2 (`plan-limits.ts`):

- Per account: `id`, `harness`, `label` (e-mail / login / account_id, or `Conta padrão` when the
  harness has no identity), `nickname?`, `plan?` (reported by the harness: claude `subscriptionType`,
  codex `plan_type`), `available`, `root` (`null` = default folder), `retired?`, `firstSeen`, `lastSeen`.
- Per account, metered harnesses only (claude, codex): `PlanLimits` windows `5h`/`week`, `updatedAt`,
  `source`; the registered Billing plan via `withPlanLabel`.
- Per account: live sessions (`LivePlanSession.account`).
- Identity: claude, codex, copilot are probed (the row can say WHOSE). gemini, kimi, antigravity are
  keyed by folder only → the row says "o assistente não informa qual conta é" and asks for a nickname.
- Add account: account roots + login session are spec §4 (not built yet), behind the
  `multi-account` experimental flag. **Flag off → no "Adicionar conta" anywhere** (absent, not
  disabled). Antigravity has no isolation variable → its add action is replaced by the sentence
  "O Antigravity ainda não permite manter uma segunda conta separada."

States a row can be in: **Logada**, **Em uso · N sessões**, **Aguardando login** (a root created,
login not confirmed), **Saiu desta máquina** (its root now holds another login; history kept).
Hidden is not a state: it is the switch, shown as the chip **Oculta dos agentes** so it is not
colour-only.

New wire needs for the chosen option (small, owner surface only): `/api/accounts` rows gain
`state` and `sessions` (or the page joins `usePlanLimits()` + fleet itself — implementation choice).

## 4. The options

### Option A — one block per assistant, accounts as rows (RECOMMENDED)

Prints: `A-overview-{desktop,mobile}-{dark,light}.png`, `A-overview-desktop-dark-en.png`.

- One intro paragraph explains the switch once.
- Per assistant one framed block: header band = `HarnessMark` · name · "N contas" · "Adicionar
  conta" (secondary button; "+ Conta" on mobile) · column caption **AGENTES** over the switches.
- Each account is one row on the same 12px/14px grid: **name** (nickname/login) + hidden chip ·
  line 2 = whose (e-mail) · plan · state (dot + word) · compact bars or "Este assistente não informa
  limites de uso" · `Toggle` · chevron. The whole row opens the detail drawer; the switch stops
  propagation.
- Mobile: same block; row stacks name + "Agentes [switch]" / bars / state + "Detalhes ›". No
  per-row big button (the first draft had one — it doubled the height for nothing).

Why recommended: it answers "the division" directly — the assistant is the box, the accounts are
its rows, the switch has one column with one caption. Everything is visible at once (6 assistants,
no tabs), it scales from 1 to N accounts per assistant, and it reads the same on a phone.
Cost: tallest page of the three on a machine with 6 assistants (each block has a header).

### Option B — one table, assistants as bands

Prints: `B-overview-*`.

- Columns Conta · Plano · Estado · Uso (5 h · semana) · Agentes; each assistant is a band row with
  its mark and an "Adicionar conta" link; a primary "Adicionar conta" top-right opens the drawer at
  step 1 (pick the assistant).
- Mobile: one `RecordCard` per account (title = name, subtitle = assistant · e-mail, switch in the
  badge slot, fields Plano/Estado/Uso, one "Detalhes" action).
- Pro: densest; best when comparing usage across many accounts. Con: on mobile the grouping is
  lost (seven cards in a flat list again, the harness only in the subtitle) and the switch in the
  badge slot has no visible caption — the closest to what the owner rejected.

### Option C — one tab per assistant, accounts and what you pay together

Prints: `C-overview-*`.

- `TabSelect` "Claude Code · 2 | Codex CLI · 1 | …" (the same control Billing already uses).
- The tab shows that assistant's accounts as cards (name, whose, plan, state, full
  `PlanLimitsBlock`, footer "Agentes podem usar [switch]", "Detalhes e plano"), a dashed "Adicionar
  conta do Claude Code — a conta atual continua logada" tile, and **below, the plan timeline of the
  same assistant** (today's Billing section moved under the tab, per account — spec §6).
- Pro: the clearest account ↔ plan relation (one screen per assistant: who is logged in, what each
  costs). Con: only one assistant visible at a time; "is anything of mine hidden from agents?" needs
  six clicks; bigger change (merges two sections of Billing).

## 5. Add-account flow (shared by all options)

A right `Drawer` (full screen on mobile) with a 3-step bar **1. Assistente · 2. Entrar · 3. Confirmar**.
Opened from an assistant's button, step 1 is skipped.

| Step / state | Print | Content | Actions |
|---|---|---|---|
| 1 pick | `add-pick-*` | `Select` of assistants; hint = "N conta(s) hoje"; Antigravity disabled with its sentence | Cancelar · Continuar (disabled until picked) |
| 2 explain | `add-explain-claude-*`, `add-explain-gemini-*` | 3 numbered sentences: we open a separate sign-in window; you sign in in the browser it opens; both stay signed in and you decide about agents. Gemini/Kimi add a `ScopeNote`: the assistant does not report which account — you will name it | Cancelar · **Abrir o login** |
| 2 waiting | `add-waiting-*` | `AgentisticsLoader` + "Aguardando você entrar na conta…" + "esta tela avança sozinha" (probe every few s, spec §4.5) | "Voltar para a janela de login" (opens the login session) · Cancelar |
| 2 error — could not start | `add-error-start-*` | `role=alert`: could not open the window; nothing changed | Cancelar · Tentar de novo |
| 2 error — closed without login | `add-error-nologin-*` | the window closed before signing in; no account registered | Descartar (removes the pending folder) · Cancelar · Tentar de novo |
| 3 detected (new) | `add-detected-*` | green confirmation "Conta detectada · freela@… · Pro"; Apelido (`FieldInput`, "agents only see this name — never the e-mail"); Plano read-only when reported; `RowSwitch` Agentes **default OFF** | Concluir |
| 3 adopted (known account) | `add-adopted-*` | "Conta reconhecida" + `ScopeNote`: plan, history, limits and the agents choice are back (spec requirement 2) | Concluir |
| 3 unidentified (gemini/kimi) | `add-unidentified-*` | "Nova conta do Gemini CLI logada · o assistente não informa qual é"; **name required** (Concluir disabled until typed); Plano `Select` from the catalog ("pode deixar para depois") | Concluir |

Decision taken here: **a NEW account added through this flow starts with Agentes OFF** and the owner
turns it on in step 3 — the spec's hard rule is "registered ≠ authorised", and an account the owner
just added on purpose is the moment to ask. Accounts detected automatically (a login made outside
agentistics) keep today's default (`available: true`) — flagged as open question U2.

The "Abrir o login" step is the headless paste-the-code login (`account-login.ts`); since CONTAS.LOGIN r4 every "Entrar" opens that same dialog — the old `loginHarness()` managed session is gone
in the account root); the person never sees a command.

## 6. Other states

| State | Print | Content |
|---|---|---|
| Loading | `state-loading-*` | `AgentisticsLoader` "Lendo as contas" inside the section (not full-screen) |
| Error | `state-error-*` | one line `role=alert` "Não foi possível ler as contas agora. As suas contas não foram alteradas." + Tentar de novo. A failed **toggle** reverts that switch and shows the same line naming the account |
| Empty | `state-empty-*` | "Nenhuma conta encontrada ainda — as contas aparecem sozinhas quando você entra num assistente" + Adicionar conta (flag on) |
| Pending root | `state-overview-pending-*` | row "Nova conta · aguardando você entrar", state Aguardando login, switch disabled |
| Detail drawer | `state-detail-*` | header (mark, assistant, state); **Quem é**: Apelido, Login, Pasta, Sessões agora; **Plano e limites**: plan + "editar em Cobrança", `PlanLimitsBlock details`; **Agentes**: `RowSwitch` with the sentence for its current position; footer **Remover conta** (only for a non-default folder; refused while a session runs) → `ConfirmModal` naming the folder and saying history/plan are kept |
| Signed out | (row variant) | grey dot "Saiu desta máquina"; switch still works; detail says the account will come back when signed in again |

## 7. Copy (PT / EN)

| Key | PT | EN |
|---|---|---|
| intro | Cada assistente pode ter mais de uma conta logada nesta máquina. Os agentes só usam as contas com “Agentes” ligado — as outras não aparecem para eles, nem no roteamento, nem nos limites. Desligar não desconecta: a conta continua logada e você ainda pode usá-la. | Each assistant can have more than one account signed in on this machine. Agents only use accounts with “Agents” on — the others never reach them, routing or the limits. Turning it off does not sign out: the account stays signed in and you can still use it. |
| column | Agentes | Agents |
| toggle aria | Agentes podem usar {nome} | Agents may use {name} |
| unnamed title | Conta do {Harness} | {Harness} account |
| unidentified | o assistente não informa qual conta é | the assistant does not say which account |
| hidden chip | Oculta dos agentes | Hidden from agents |
| states | Logada · Em uso · N sessões · Aguardando login · Saiu desta máquina | Signed in · In use · N sessions · Waiting for sign-in · Signed out |
| no plan | Plano não informado | Plan not set |
| no meter | Este assistente não informa limites de uso | This assistant does not report usage limits |
| agy | O Antigravity ainda não permite manter uma segunda conta separada. | Antigravity cannot keep a second account apart yet. |
| add | Adicionar conta / + Conta (mobile) | Add account / + Account |
| nickname help | É só este nome que os agentes veem — nunca o e-mail. | Agents only ever see this name — never the e-mail. |
| drawer switch on/off | Ligada: entra no roteamento e nos limites que os agentes leem. / Desligada: continua logada para você; os agentes não a veem. | On: part of routing and of the limits agents read. / Off: still signed in for you; agents do not see it. |
| remove confirm | A conta sai desta máquina e a pasta {pasta} é apagada. O histórico de uso e o plano ficam guardados — se você entrar de novo nela, tudo volta. | The account leaves this machine and the folder {folder} is deleted. Usage history and plan are kept — sign in to it again and it all comes back. |

Flow sentences: see §5 (the prototype carries them verbatim in both languages).

## 8. Recommendation

**Option A.** It is the direct answer to every defect in the owner's print with the fewest new
ideas: grouped by assistant with its mark, whose account on every row, one switch column with one
caption and one explanation, state + limits + sessions inline, add per assistant. It keeps Billing's
plan timeline where it is (so the change is contained to the accounts block + the drawer), and
Option C's "plan under the same tab" can follow later if the owner wants the merge.

Implementation notes for the later session:
- Replace the `RecordCard`+`RowSwitch` block in `BillingSettings.tsx` with an `AccountsSection`
  component (own file); export the badge pill from `HarnessesSettings.tsx` as a primitive instead of
  copying it.
- Verify at 390px (`scrollWidth <= innerWidth` held on every print) and both themes. Touch target:
  `Toggle` is 34×20 (it opts out of the 44px rule on purpose), so on mobile the "Agentes [switch]"
  group must be the hit area (one `role=switch` element ≥ 44px tall, the `RowSwitch` shape), not the
  bare pill as in the prototype.
- `account-visibility.test.ts` gains the Settings surface only as an owner surface (it shows hidden
  accounts by design).

## 9. Open questions (provisional answers; nothing blocks)

- **U1** Option A vs B vs C — owner's pick. Provisional: A.
- **U2** Accounts detected automatically: keep `available: true` default, or start OFF like the
  add flow? Provisional: keep ON (changing it would hide the current single account of every
  existing user on upgrade).
- **U3** Show the e-mail on owner surfaces at all? Provisional: yes, it is what answers "whose";
  agents never see it (C2 already enforces).
