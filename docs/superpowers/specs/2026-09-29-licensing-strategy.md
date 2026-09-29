# Licensing and commercial-protection strategy — 2026-09-29

**Status: analysis for the owner's decision. Nothing here has been applied.** No LICENSE, package
metadata, header or README was changed by this work. The owner decides. **The owner decided on
2026-09-29 not to consult a lawyer**, so the points marked [LAWYER] are open risks he accepts, and §I.4
says how each one is reduced without one.

**This is not legal advice.** It is a product and engineering analysis of licence texts and of what
comparable projects did.
Every claim carries a label:

- **[FACT]** — verified in this repository or in a primary source (licence text, the project's own
  LICENSE/FAQ/blog). Sources are listed in §J.
- **[INTERP]** — my reading of a fact; reasonable people (and courts) may read it differently.
- **[REC]** — a product recommendation.
- **[LAWYER]** — a point a lawyer would normally settle. Here it is an accepted open risk (see the
  status note above), reduced as far as possible without one in §I.4.

Context read for this analysis: the owner's brief (verbatim in the leader's
`licensing-brief.md`), `CLAUDE.md`, the enterprise decisions E1–E25
(`docs/enterprise-product-spec` branch, local only), the runtime master spec
(`2026-09-19-agentistics-runtime-master.md`), board tasks `t-35a89395fe` and `t-cf96eb10bd`, and
the owner's answers to six strategic questions asked in this session (§0).

---

## 0. The owner's answers that shape this analysis (2026-09-29)

| # | Question | Owner's answer | Effect on the recommendation |
|---|---|---|---|
| Q1 | Who owns the code? | The owner states the project is his alone. | Handled in a **private note outside this repository** (§B.4.2). The only repository-visible consequence is a `.mailmap` entry, not a history rewrite (§G.8). |
| Q2 | Will there be a paid self-hosted Enterprise edition, or only the Cloud? | **Undecided** ("but we need to protect ourselves now"). | The recommendation must protect **now** and keep **both** doors open: Cloud-only, or Cloud + self-hosted Enterprise. |
| Q3 | May consultancies/MSPs operate Agentistics for their clients? | "What do you recommend, given I want to stop others profiting from our project?" | [REC] Allow services **on the client's own infrastructure**; forbid hosting it as a service, white-label and resale (§E). |
| Q4 | Is the mark registered? | Not registered; asked whether it is worth doing now and the cost. | [REC] Yes — file now (§E.5, costs in §I). |
| Q5 | External contributions? | **Yes, with a CLA.** | A licence-grant CLA becomes part of the model (§G.6, §H). |
| Q6 | May third parties embed Agentistics? | **Integration pieces yes, the platform no.** | Two licences in one repository: a permissive one for the integration surface, a protective one for the platform (§F). |

---

## A. Diagnosis — what problem are we actually solving?

**The problem is value capture, not code theft.** The owner wants the economic value that
Agentistics creates — companies running it across teams, machines and a hosted hub — to accrue to
Agentistics, while the single-machine product keeps spreading freely (E2: "one machine is free;
joining machines or people is paid").

That value can leak through five different doors. Only two of them are closed by a licence:

| # | How value leaks | Closed by a licence? |
|---|---|---|
| 1 | A company takes the code, rebrands it, and **sells or hosts it** as its own product | **Yes** — this is exactly what a source-available licence forbids and MIT allows |
| 2 | A company takes the code, keeps it private, **builds a competing hub** on top of it | **Yes**, if the licence forbids commercial substitutes |
| 3 | A company **uses the name** "Agentistics" or a confusing variant | **No** — that is trademark law |
| 4 | A company **rebuilds the same idea from scratch** (clean room, or with AI assistance) | **No** — copyright protects expression, not ideas, architecture or features |
| 5 | The harness vendors (Anthropic, OpenAI, GitHub, Google) **ship fleet/cost/session management natively** | **No** — nothing stops a platform vendor from building its own |

**[INTERP]** Doors 4 and 5 are the larger commercial risks for a product of this kind today, and
no licence touches them. A licence is worth doing because doors 1 and 2 are real and cheap to close
**now**. But the owner should not expect a licence to be the moat. The moat is the hub (closed),
the brand (registered), the speed of the team, and the relationships with the companies that adopt
it.

**[FACT]** The current state the decision starts from:

- Root `LICENSE` is MIT, "Copyright (c) 2026 blpsoares", last changed 2026-04-10.
- Licence fields in the repo: the root `package.json`, `@agentistics/agentop` and `@agentistics/mcp` are `MIT`
  (both published on npm at 2.68.0), and `agentistics-vscode` is `MIT` with its own
  `packages/vscode/LICENSE`. `@agentistics/runtime` has **no licence field and is not private**.
  It is not on npm yet. `core`, `server`, `web`, `tui` and `desktop` are private and have no field. The desktop
  `tauri.conf.json` declares no copyright or licence. The `Dockerfile` has no OCI licence label.
- The latest release is **v2.68.0** (`origin/main`). **312 more commits** are already public on
  `origin/dev`, among 23 public branches. `packages/runtime` (28 commits) is already public on both
  `main` and `dev`.
- A **push hold** has been in force since 2026-09-29 (owner decision via the leader). Nothing new has been
  published since then.
- Adoption signals: 44 stars and 7 forks on GitHub, plus the owner's team using it at work.
- Dependencies: no GPL/AGPL/SSPL/BUSL package in the JS tree. Of about 435 packages, 354 are MIT; the
  rest are ISC, Apache-2.0, BSD and three MPL-2.0 (`lightningcss`, a build-time CSS tool, file-level
  copyleft, not linked into the product's own code). `dompurify` is MPL-2.0 OR Apache-2.0. The Rust
  tree of the desktop app was **not** scanned (see §H).
- Contributors:
  - Everything is authored by the owner (under several identities), bots and AI co-authors,
    **except** two external people.
  - **Gustavo Gondim**: 2 commits plus 16 co-authored ones, the April OTel watcher and deep tool
    metrics PRs #7/#8.
  - **Vinicius Mostaço de Moraes**: 4 merged PRs (#288, #289, #295, #296), about 590 lines added.
  - A third PR, from `webbrain-one`, was closed unmerged.

---

## B. The owner's premises — which hold and which do not

### B.1 Valid

1. **"MIT lets anyone take it all, rebrand it and sell it."** **[FACT]** Correct. MIT allows use,
   modification, sublicensing and sale, including in closed form, provided the copyright notice is kept.
   Nothing in MIT stops a closed fork or a competing SaaS.
2. **"The value is moving from a log viewer to a platform."** **[INTERP]** Correct, and it matters
   for timing. When Agentistics was a personal dashboard, the MIT code carried little business value.
   Now it holds a session manager, an ALM, a team central with IAM, and soon a native runtime. A
   platform is worth forking; a log viewer is not.
3. **"The best moment to change is now."** **[INTERP]** Correct. Relicensing costs little
   while the community is small (two external contributors, seven forks) and a great deal later. HashiCorp
   changed licence with a large contributor base and got OpenTofu, a foundation-backed fork of the last
   MPL version (§D). Agentistics has no such base yet.

### B.2 Overstated

1. **"Someone can simply fork it and get rich."** **[INTERP]** Forks rarely win on their own. The
   fork has the code as of one day. The original has the team that wrote it, the roadmap, the
   users' trust, the release channel (installers, auto-update, npm, the VS Code Marketplace) and,
   soon, a hub with data and network effects. The forks that did win (OpenTofu, OpenSearch,
   Valkey) had a foundation or a hyperscaler behind them, and all three were forks of a project
   with a very large installed base. Seven forks and 44 stars do not attract that kind of attack.
   The realistic threat is quieter: a small vendor wraps the MIT code in a paid product. That one
   a licence does stop.
2. **"A restrictive licence protects the business."** **[INTERP]** It protects the **code**. The
   business is protected by what the code does not contain: the hub (closed from day one, E9), the
   operations, the brand, and speed. A competitor who writes the same product from scratch — which
   AI-assisted development makes cheaper every month — owes the licence nothing.

### B.3 Confused — where the brief mixes different tools

| Concept | What it protects | What it does NOT protect |
|---|---|---|
| **Copyright** | The literal code, text and images you wrote | Ideas, features, architecture, UX patterns, the ALM concept, data formats you read |
| **Licence** | The terms on which **you** let others use **your** copyright | Anything you do not hold copyright in: code already released under MIT, or someone else's clean-room rewrite |
| **Trademark** | The **name**, logo and trade dress, against confusion | The code itself. A fork is legal; a fork **called Agentistics** is not |
| **Trade secret** | Information kept secret with reasonable measures | Anything you publish. Publishing the source ends it for that code — which is why the hub stays private |
| **Patents** | A technical invention, if one qualifies and is filed | Not pursued here. Software patents are narrow in Brazil and slow and expensive everywhere; [INTERP] not worth it at this stage |
| **Product differentiation** | Nothing legally — it is why customers choose you | — |

Two consequences the owner should hold on to:

- **White-label is mainly a trademark problem.** **[FACT]** Apache-2.0 §6 grants no trademark
  rights, and MIT grants none either. So even under MIT a fork may not call itself "Agentistics",
  but only if the mark is protected and enforced. A licence can additionally forbid the
  **commercial** rebrand of the code (§C). But the name is what customers recognise, and the name is
  protected by registration, not by a licence.
- **"Closed" and "protected" are not the same.** The hub is protected by being private: nobody
  has the code. The public platform is protected by the licence, which only binds people who use
  your code. The two need different tools and should not be confused in the product spec.

### B.4 Two things the brief did not raise, and should

1. **[LAWYER] The strength of the copyright itself.** Most commits in this repository are
   co-authored by AI models: 1,659 of the 2,772 commits on `dev` carry an AI co-author trailer (Claude or Copilot).
   **[INTERP]** Whether, and how far, AI-generated code is protected by copyright is unsettled.
   Brazil's copyright law (Lei 9.610/98, art. 11) defines the author as a natural person, and the US
   Copyright Office requires human authorship. A licence only binds what copyright protects. This
   does not change which licence to choose, but it lowers how much weight a licence can carry, and
   raises the weight of the trademark, the closed hub and speed. The owner's human direction,
   review, selection and arrangement of the work are what make it protectable, so keep a record of
   them (§I.4, L6).
2. **Ownership comes before any licence.** A licensor must hold the rights it licenses. The owner
   states he does. The facts that support that, and the steps that document it, are kept in a
   **private note outside this repository**. This document is headed for a public repository, and an
   ownership analysis does not belong there. It is step 1 of the order in §G.4, before the cutover.

---

## C. Comparison of the strategies

### C.1 What each licence is

| Strategy | Type | Core rule | OSI "open source"? |
|---|---|---|---|
| **MIT** | Permissive | Do anything; keep the notice | Yes |
| **Apache-2.0** | Permissive | As MIT, plus an explicit patent grant, NOTICE handling and §6 "no trademark rights" | Yes |
| **AGPLv3** | Strong copyleft, network clause | Anyone who distributes it, **or lets users interact with a modified version over a network**, must offer the complete source under AGPL | Yes |
| **BSL 1.1** | Source-available, delayed open source | Non-production use is free; production use only under the licensor's own "Additional Use Grant"; each version becomes the "Change License" at the Change Date (max 4 years) | No |
| **FSL-1.1-ALv2** (Functional Source License) | Source-available, delayed open source ("Fair Source") | Any purpose **except a "Competing Use"**; each version becomes Apache-2.0 two years after release | No |
| **Sustainable Use License** (n8n) | Source-available ("fair-code") | Use and modify only for internal business, non-commercial or personal use; distribute only free of charge for non-commercial purposes | No |
| **Elastic License 2.0** | Source-available | Anything except: providing it as a hosted/managed service, circumventing licence keys, removing notices | No |
| **Open-core** | A structure, not a licence | A core under one licence, plus an `ee/` part under a proprietary licence (production use needs a subscription) | Core: depends; `ee/`: no |

**[FACT] FSL's key definitions** (fsl.software, FSL-1.1 templates):

> **Competing Use** means making the Software available to others in a commercial product or
> service that: substitutes for the Software; substitutes for any other product or service we offer
> using the Software that exists as of the date we make the Software available; or offers the same
> or substantially similar functionality as the Software.

> **Permitted Purpose** is any purpose other than a Competing Use. It includes internal use and access,
> non-commercial education, non-commercial research, and use "in connection with professional services
> that you provide to a licensee using the Software in accordance with these Terms and Conditions".

The future grant is Apache-2.0 (or MIT), effective on the second anniversary of each version.

### C.2 The scenario matrix (§9 of the brief)

✅ allowed · ⚠️ allowed with a condition · ❌ forbidden without a commercial agreement. Rows 16–17 are
added because they decide this case. "Open-core" assumes a permissive core plus a proprietary `ee/`
directory.

| Scenario | MIT | Apache-2.0 | AGPLv3 | BSL 1.1 (HashiCorp-style grant) | FSL-1.1-ALv2 | SUL (n8n) | ELv2 | Open-core |
|---|---|---|---|---|---|---|---|---|
| 1. Personal use | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2. Internal company use | ✅ | ✅ | ⚠️¹ | ✅ | ✅ | ✅ | ✅ | ✅ core · ❌ `ee` without subscription |
| 3. Internal modification | ✅ | ✅ | ⚠️¹ | ✅ | ✅ | ✅ | ✅ | ✅ core |
| 4. Own adapter | ✅ | ✅ | ⚠️² | ✅ | ✅³ | ✅³ | ✅ | ✅ |
| 5. Own integration | ✅ | ✅ | ⚠️² | ✅ | ✅³ | ✅³ | ✅ | ✅ |
| 6. Self-hosting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ core |
| 7. Public fork | ✅ | ✅ | ✅ | ✅⁴ | ✅⁴ | ⚠️ free and non-commercial only | ✅ | ✅ core |
| 8. Private fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 9. Closed fork, distributed | ✅ | ✅ | ❌ | ⚠️ unless competitive | ⚠️ unless Competing Use | ❌ if commercial | ✅ | ✅ core |
| 10. Competing SaaS | ✅ | ✅ | ⚠️⁵ | ❌ | ❌ | ❌ | ❌ | ✅ core · ❌ `ee` |
| 11. Managed hosting for customers | ✅ | ✅ | ⚠️⁵ | ❌ if competitive | ❌ | ❌ | ❌ | ✅ core |
| 12. White-label (rebrand and sell) | ✅⁶ | ✅⁶ | ⚠️⁵ ⁶ | ❌ | ❌ | ❌ | ⚠️ self-hosted ✅, hosted ❌ | ✅⁶ core |
| 13. Resale | ✅ | ✅ | ✅ with source | ❌ if competitive | ❌ | ❌ | ⚠️ copies ✅, as a service ❌ | ✅ core |
| 14. Competing product (on-prem) | ✅ | ✅ | ✅ with source | ❌ | ❌ | ❌ | **✅** | ✅ core |
| 15. Commercial embedding | ✅ | ✅ | ⚠️ the product becomes AGPL | ⚠️ ❌ if competitive | ⚠️ ❌ if Competing Use | ❌ | ✅ unless hosted | ✅ core |
| 16. Consultancy installs it on the client's infra | ✅ | ✅ | ✅ | ✅ | ✅ (explicit) | ✅ (n8n says so) | ✅ | ✅ core |
| 17. Someone rebuilds it from scratch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Notes:

1. **[INTERP]** AGPL imposes nothing extra for purely internal use, even when employees reach it
   over a network, as long as the company is the only "user". Beyond the text, however, many
   companies' open-source policies **forbid AGPL outright**. That is friction on exactly the adoption
   channel that matters here: developers installing it at work.
2. An adapter linked into an AGPL program is part of it. It must be AGPL when distributed.
3. Allowed for free distribution and for internal use. Selling an adapter commercially is fine
   if it does not substitute for Agentistics. [REC] Publishing the adapter/SDK contracts under
   Apache-2.0 (§F) removes the question entirely: the adapter then touches only Apache code.
4. Allowed for the permitted purposes; the fork inherits the same restrictions.
5. **[FACT]** Allowed, provided the full source of the modified version is offered to the service's
   users under AGPL. AGPL forbids **closing** it; it does **not** forbid **competing**.
6. The code may be rebranded; the **name** may not. That is trademark law, not the licence (§B.3).

**The row that decides between the source-available licences is 14, "competing product
(on-prem)".** ELv2 only forbids offering the software as a hosted service. A company may take
ELv2 code, rebrand it and **sell it as a self-hosted product**, which is exactly the owner's fear.
FSL and BSL forbid that. SUL forbids it too, but it also forbids a good deal the owner wants to
allow (row 7, and any commercial adapter or embedding).

---

## D. Reference projects — what they teach

**[FACT]** unless marked otherwise. Sources in §J.

| Project | Original licence | Change(s) | Stated reason | Community / Enterprise today | Lesson for Agentistics |
|---|---|---|---|---|---|
| **n8n** | Apache-2.0 + Commons Clause (2019) | → **Sustainable Use License**, March 2022 (issue #2932, blog 2022-03-17) | The Commons Clause "restricts people from charging fees for consulting and support: services we want to freely allow and encourage", and created "ambiguity and confusion" | SUL for the product. Files with `.ee.` in the name are under `LICENSE_EE.md`: production use needs an n8n Enterprise licence, while dev/test is free. White-label and embedding are sold separately (n8n Embed; [INTERP] only secondary sources found) | **Consultancy is worth allowing.** n8n changed licence specifically to allow it. They also wrote their own licence and coined "fair-code" to make it legible. The cost of a custom licence is ambiguity ("internal business purposes") that a lawyer has to interpret for every customer |
| **Sentry** | Unlicensed (2008) → BSD-3 (2009) | → **BSL** (2019) → **FSL**, which Sentry authored (blog "Introducing the Functional Source License") | "Every BSL is a different license" (the Additional Use Grant varies), and 3–4 years is too long. Aim: stop "harmful free-riding" while keeping "user freedom" | FSL for the product. Sentry SaaS is the business. Self-hosted is fully functional | **A standardised licence beats a bespoke one.** FSL is a BSL with the grant and the window fixed, so nobody has to read a custom grant. It was written by a company in exactly this position |
| **Elastic** | Apache-2.0 | → SSPL/ELv2 dual (2021) → **AGPLv3 added** as a third option (blog 2024-08-29, "Elasticsearch is open source again") | 2021: "issues with AWS and the market confusion their offering was causing". 2024: "Amazon is fully invested in their fork, the market confusion has been (mostly) resolved" | ELv2 / SSPL / AGPL for Elasticsearch and Kibana. Elastic Cloud plus subscriptions | **The threat was a hyperscaler hosting the software, and the licence did not stop the fork** (OpenSearch). Elastic returned to an OSI licence once the confusion passed. Licences serve a phase |
| **HashiCorp / Terraform** | MPL-2.0 | → **BSL 1.1**, 2023-08-10 | Vendors building "competitive services" on the community edition | Terraform 1.6+ BSL. Grant: production use is allowed "provided such use does not include offering the Licensed Work to third parties on a hosted or embedded basis which is competitive with HashiCorp's products". Change Date 4 years, then MPL-2.0 | **Changing late, with a large contributor base, produced a fork** (OpenTofu, public 2023-08-25, Linux Foundation 2023-09-20). OpenTofu called the BSL a "poison pill" because users could not tell whether their use was "competitive". Ambiguity is itself a cost |
| **Grafana Labs** | Apache-2.0 | Grafana, Loki and Tempo → **AGPLv3**, 2021-04-20 | Balance "value creation" with "value capture" | AGPL core. **"Plugins, agents, and certain libraries will remain Apache-licensed."** Grafana Cloud plus Grafana Enterprise | **Keep the integration surface permissive while protecting the platform.** Grafana did precisely the split Q6 asks for |
| **GitLab** | MIT | Open-core: MIT CE + `ee/` under the proprietary "GitLab EE license" | — | `ee/` "may only be used in production" under a subscription; dev and test are free. **Switched from CLA to DCO in 2017** because the CLA was "unpopular with developers" | **The `ee/` directory pattern** keeps the Enterprise door open without deciding it now. The CLA has a real adoption cost, and GitLab accepted it could not later relicense contributions |
| **PostHog** | MIT | Open-core: MIT + `ee/` | — | `ee/` production use requires a subscription and "a valid PostHog Enterprise license for the correct number of user seats" | Same pattern, applied per seat. Seats as the unit matches E14 |
| **Plausible** | MIT | → **AGPLv3**, 2020-10-12 | "A corporation has taken parts of our code, made it closed source and started selling it as a direct competitor", and large firms wanted to resell it | AGPL self-hosted edition + Plausible Cloud | **The owner's exact fear, from MIT, in a small project.** AGPL fixed the "closed" part. It does not stop an AGPL-compliant competitor |
| **Cal.com** | AGPLv3 core + `ee/` | 2026-04-15 (v6.4): the free code relaunched as **Cal.diy under MIT**; the commercial codebase went closed | AI-related security risk from public code | MIT hobby edition + a closed commercial product | **A 2026 counter-example:** give up licence protection entirely and move the value into a closed product. It works if the valuable part can be kept closed — which is already this project's plan for the hub |

**What the precedents say, together:**

1. **[FACT] A relicense only ever moves forward.** Every project above kept its old versions under
   the old licence, and every fork was taken from the last permissive version. v2.68.0 and every
   commit already public on `dev` will stay MIT forever (§G).
2. **[INTERP] Every one of these projects was protecting a hosted business**, with the closed or
   hosted part as the actual product. That matches E2–E9: the hub is the product.
3. **[INTERP] Ambiguity costs as much as permissiveness.** OpenTofu's "poison pill" and Sentry's
   "every BSL is different" point the same way: prefer a **standard text** with a **fixed**
   definition over a bespoke grant.
4. **[INTERP] Keep the edges permissive.** Grafana (plugins, agents, libraries) and n8n (consulting)
   show that protecting the platform works best when integrators and service providers are
   explicitly welcome.
5. **[INTERP] Timing matters more than the licence text.** Changing before there is a contributor
   community is almost free. Changing after one exists gets you a fork.

---

## E. Recommendation

### E.1 The main strategy

**[REC] A layered model, a different tool for each layer:**

1. **The platform** (everything that makes Agentistics run: server, web, cockpit/TUI, runtime,
   desktop, the VS Code extension, the CLI) → **FSL-1.1-ALv2** from the cutover onward. Each release
   becomes Apache-2.0 two years after it ships.
2. **The integration surface** (the pieces third parties build against: `@agentistics/mcp`, the hub
   contract/protocol of E9, the future SDK of E11, and an adapter/plugin SDK once extracted) →
   **Apache-2.0**.
3. **The hub** (`agentistics-cloud`) → **proprietary and private**, never published (already
   decided in E9).
4. **Reserved, not built:** an `ee/` convention for a future **self-hosted Enterprise edition**
   under a proprietary "Agentistics Enterprise License" (production use needs a subscription;
   dev and test are free), the GitLab/PostHog/n8n pattern. It is only created if the owner decides
   Q2 that way.
5. **The name** → **registered trademark** (INPI now; USPTO/Madrid when there is a foreign market),
   plus a short `TRADEMARKS.md` policy.
6. **Contributions** → accepted under a **licence-grant CLA** (not a copyright assignment), as n8n
   does.

### E.2 Why FSL for the platform — and not the others

- **It closes exactly doors 1 and 2 of §A.** "Competing Use" forbids making the software available
  in a commercial product or service that substitutes for it, or offers "the same or substantially
  similar functionality". That covers a competing SaaS, managed hosting, white-label, resale, **and**
  a competing self-hosted product (row 14, the gap in ELv2). It also covers a competitor building a
  paid hub on top of the platform ("substitutes for any other product or service we offer using the
  Software", which would include Agentistics Cloud once it exists).
- **It allows everything on the owner's "allow" list.** Personal, developer and internal company use,
  internal modification, self-hosting, adapters, integrations, contributions, public forks for
  permitted purposes, reading the code — and **consultancies**, which the text names explicitly:
  "professional services that you provide to a licensee". That answers Q3 without a custom clause.
- **It is a standard text.** There is no Additional Use Grant to draft and no custom definitions to
  argue about. It carries an SPDX identifier (`FSL-1.1-ALv2`), it is recognised as Fair Source, and a
  company's legal team can evaluate it once. This avoids both HashiCorp's "is my use competitive?"
  problem and n8n's "what is internal business?" problem.
- **It keeps the open-source promise on a clock.** Every version becomes Apache-2.0 after two years.
  If Agentistics ever disappears, the code still ends up free. That is what makes the change
  defensible to the community and to E2/E25's "the free product is open" spirit. **[INTERP]** A
  two-year-old snapshot of a product that ships several releases a week is not a competitive threat.
- **Apache rather than MIT as the future licence** gives the explicit patent grant and the NOTICE
  mechanism, and matches the integration surface's licence.
- **Why not SUL:** it forbids more than the owner wants (a paid adapter, commercial embedding of
  anything, non-free distribution of a fork). It is n8n's own text, and it never becomes open source.
- **Why not BSL:** FSL *is* a standardised BSL. With BSL, the owner would have to draft the
  Additional Use Grant, which is exactly the part that made the OpenTofu fork possible.
- **Why not ELv2:** it lets a competitor sell a rebranded self-hosted copy (row 14).
- **Why not AGPL:** see the second alternative (§E.6).
- **Why not stay on MIT or Apache:** it leaves doors 1 and 2 open. That is a coherent strategy
  (Cal.com's in 2026), but the owner explicitly asked to close those doors.

### E.3 What it permits and what it restricts

| Actor | Under the recommendation |
|---|---|
| A developer at home | Everything. |
| **A company installing it internally for its employees** (brief §4, second question) | Everything: install, self-host (including the team central), modify, build internal adapters and integrations, run it on any number of machines. **No fee, no licence key, no registration.** Today's single-machine and team features stay free (E2). |
| A consultancy / MSP | May install, configure, customise and support it **on its client's infrastructure** and charge for that work. May **not** host it as a service for clients, rebrand it, or resell it. |
| A company building an integration | Builds against the Apache-2.0 SDK / contract / MCP. May sell its integration. |
| An open-source project embedding a piece | The Apache-2.0 pieces, freely. The platform only for non-competing purposes. |
| **A company that downloads it tomorrow to build a competing commercial product** (brief §4, first question) | May read it, learn from it, run it internally, and contribute. May **not** ship it, or a modification of it, as a commercial product or service that substitutes for Agentistics or offers substantially similar functionality: no SaaS, no managed hosting, no white-label, no resale, no competing on-prem product. It **may** still use every commit up to the cutover under MIT, may take any FSL version once it turns two (Apache-2.0), and may build the same thing from scratch. It may never use the name. |

### E.4 Risks that remain — stated, not hidden

1. **The MIT line stays open forever.** v2.68.0 and every commit already on public `dev` (including
   the early `packages/runtime` and the complete team central) are MIT. **[INTERP]** That includes
   an MIT-licensed self-hosted team central. A competitor can start from it today. The practical
   answer is that the owner's future work (runtime, native harness, remote access, the hub) is
   where the value will be, and none of that is MIT.
2. **Each version becomes Apache-2.0 after two years.** That is a deliberate trade for community
   trust. **[INTERP]** It is acceptable while the product moves fast. It would not be if the product
   stagnated — but then no licence would save it.
3. **"Substantially similar functionality" is broad.** A legitimate observability vendor may ask
   whether its product is a Competing Use. [REC] A short public FAQ (§H) should say what is plainly
   allowed.
4. **It is not "open source" by the OSI definition.** The product can no longer be described that way;
   "source-available, becomes open source after two years" is the accurate phrase. **E2 and E25 use
   the words "open source"** and must be reworded (§H). Some distribution channels and some
   corporate policies require an OSI licence. [LAWYER/verify] Check each channel the product uses —
   for example, a Homebrew core formula versus a tap.
5. **Enforcement costs money.** A licence you never enforce protects less each year. [INTERP] The
   cheap enforcement tools are the trademark (a takedown on a marketplace listing) and the private
   hub, not litigation.
6. **Copyright strength** (§B.4.1). The more of the code is machine-generated, the less of it a
   licence can reliably bind. That is a reason to lean harder on the non-licence moats, not to skip
   the licence.

### E.5 Effect on the community, on companies, and on monetisation

- **Community:** a small, one-off cost now. Some developers dislike non-OSI licences on principle,
  and a CLA adds a step for contributors. It is offset by: two external contributors today, free use
  for everyone, the two-year promise, and a permissive integration surface to build on. **[INTERP]**
  The larger community risk is not the licence, it is doing the change badly — silently, or by
  rewriting history. §G is written to avoid both.
- **Companies:** for **internal use nothing changes**. It stays free, self-hostable and modifiable.
  FSL is a short standard text a legal team can clear once. Companies that ban AGPL have nothing to
  object to here.
- **Monetisation:** it keeps every door open. The Cloud/hub is protected by being private **and** by
  the platform's licence (nobody may build a competing hosted service with the platform). A future
  self-hosted Enterprise fits in `ee/` without another relicense. **Seats per person (E14)** work with
  either. White-label and OEM deals become **sellable**: a company that wants to embed or rebrand
  the platform now needs a commercial licence from Agentistics, which is a revenue line MIT made
  impossible.
- **The trademark (Q4):** yes, file now. **[FACT]** The INPI fee as of 2025-09-20 is **R$ 880 per
  class** for a pre-approved specification, and it now includes the concession and first decade. A
  natural person without a stake in a company in the same field, MEI, ME and EPP get **50% off
  (R$ 440 per class)**. Classes **9** (downloadable software) and **42** (SaaS) are the fit; both
  together cost **R$ 880 with the discount** (R$ 1.760 without). A free-text specification costs
  R$ 1.720 per class. USPTO: **US$ 350 per class** since 2025-01-18. Madrid Protocol: a basic
  fee of 653 CHF plus per-country fees. **[REC]** Run a prior-mark search first; a trademark agent
  or lawyer does both steps for a modest fee.

### E.6 The second alternative — AGPLv3 + CLA + trademark + closed hub

**What it is:** the Grafana/Plausible path. The platform goes to AGPLv3 (OSI open source). The
integration surface is Apache-2.0, as in the main recommendation. Because the CLA lets the owner
dual-license, a company that cannot accept AGPL buys a commercial licence.

**What it buys over FSL:**

- The product stays **"open source" by the OSI definition** — no rewording of E2/E25, no channel
  that refuses it.
- **Closed forks are forbidden permanently**, not just for two years.
- Dual licensing is a proven revenue line (the "sell exceptions" model).

**What it gives up:**

- **It does not forbid competing.** A company may host Agentistics as a paid SaaS, white-label it
  (under another name) or sell it, **as long as it publishes its source under AGPL**. The owner's
  core fear, "someone makes money on my work", stays possible (rows 10–14 of §C.2).
- **Many companies ban AGPL internally.** The product's growth channel is developers installing it at
  work, so this is friction exactly where adoption happens.
- **Adapters and plugins linked into the platform must be AGPL** when distributed, unless the SDK
  boundary is drawn very carefully.

**Choose AGPL over FSL if:** the "open source" label matters more to the owner than stopping an
AGPL-compliant competitor — for example, if a foundation, a government buyer, or a distribution
channel requires an OSI licence. **[INTERP]** Nothing in the current context points that way, which is
why it is the second choice.

**A third option, named for completeness — MIT or Apache + closed hub + trademark (the Cal.com
2026 bet).** It maximises adoption and moves all protection into what is closed. It is coherent, but
it contradicts the owner's explicit request to close doors 1 and 2, and a competing hub built on the
public platform would remain legal.

---

## F. Proposed architecture

The Community / Enterprise / Cloud split the brief proposes works, with **one addition**: the
integration surface is a layer of its own, with a different licence. Without it, Q6 ("integration
pieces yes, the platform no") cannot be honoured.

```
Agentistics
├── Community  (public repo agentistics/agentistics · FSL-1.1-ALv2 → Apache-2.0 after 2 years)
│   ├── core            shared types, pricing, formatters, billing arithmetic, i18n
│   ├── server          local app: metrics pipeline, harness adapters (parsers), sessions,
│   │                   ALM/tasks, fleet, events, backup, shell, capability guard, and the
│   │                   self-hosted team central (already MIT at v2.68.0 — it stays free)
│   ├── runtime         the native harness: agent loop, providers, tools, sandbox, policy
│   ├── web · tui · desktop · vscode · agentop (CLI + installer)
│   └── the device side of the hub: device pairing and the E2E tunnel client (it runs on
│       the user's machine, so it ships in the public product; it is useless without the hub)
│
├── Integration surface  (same public repo · Apache-2.0)
│   ├── @agentistics/mcp          (already standalone; imports no platform package)
│   ├── @agentistics/contract     the E9 contract: ingest + tunnel protocol, OpenAPI (E11)
│   ├── @agentistics/sdk          E11 phase 2, generated from the OpenAPI spec
│   └── @agentistics/adapter-sdk  the HarnessAdapter contract, once extracted from server/
│
├── Enterprise  (reserved — only if the owner decides a paid self-hosted edition)
│   └── ee/  in the public repo · "Agentistics Enterprise License" (proprietary: production
│            use requires a subscription; dev/test free). Candidates: SSO/SAML/OIDC, SCIM,
│            advanced audit, per-person budgets, governance policies (E21)
│
└── Cloud / Hosted  (private repo agentistics/agentistics-cloud · proprietary, never published)
    └── the multi-tenant hub: OAuth, workspaces, tenancy layer, relay, billing, GitHub App
        back end, hosted MCP, notifications, real-cost reconciliation (E5–E23)
```

**Rules that make the split hold:**

1. **Apache code may never import FSL code.** An Apache package that bundles platform code is not
   Apache. Today `@agentistics/mcp` imports nothing internal, so it qualifies. `vscode` imports
   `@agentistics/core` and `@agentistics/tui`, and `runtime` imports `core`, so both belong in the
   FSL layer. [REC] A lint test, in the style of `tokens.lint.test.ts`, that fails the build when a
   package declared Apache imports a package declared FSL, and asserts every `package.json`
   `license` field matches the map in `LICENSING.md`.
2. **Harness adapters stay in the platform (FSL).** The owner wants third parties to *write*
   adapters (brief §3), not to take ours. The Apache `adapter-sdk` is what makes a third-party
   adapter independent of the FSL code.
3. **Do not move today's free features to `ee/`.** E2 promises single-machine features are never
   crippled, and the team central is already free under MIT at v2.68.0. `ee/` only ever holds
   **new** features. **[INTERP]** Taking away what users already have is the one move that
   reliably provokes a fork.
4. **Is Community/Enterprise even the right split?** **[INTERP]** For now the more important line is
   **public vs hosted**, which E2 and E9 already drew: what runs on your machines is public, what we
   host is closed. Enterprise is an option in reserve, not a necessity. Nothing in this architecture
   forces the Q2 decision.

---

## G. Cutover — leaving MIT without rewriting what was published

### G.1 What is already MIT, forever — **[FACT]**, then **[LAWYER]** on the edges

- **Every version already distributed:** tags `v1.x`–`v2.68.0`, npm `@agentistics/agentop` and
  `@agentistics/mcp` ≤ 2.68.0, GHCR images ≤ 2.68.0, VS Code extension ≤ 1.1.0, and every desktop
  installer attached to a release.
- **Every commit ever pushed to a public branch** of `github.com/blpsoares/agentistics`, whether
  or not it was released. Today that is the tip of `origin/dev` (`e0ce6913`, 312 commits after
  v2.68.0) and the 23 public branches. The `LICENSE` file in each of those trees says MIT.

Nothing in this plan tries to revoke, rewrite or re-tag any of it.

### G.2 What is protected by the hold

Everything committed **locally** since the push hold and not yet pushed: the runtime work in the
worktrees, this branch. **[INTERP]** Because it has not been published, it was never offered under
MIT, and it can first appear under the new licence. This is the whole value of the hold, and why
the order of G.4 matters.

### G.3 The last MIT version — the proposal

**[REC] Release v2.69.0 from the exact current tip of public `origin/dev`, adding nothing. It is
the final MIT release. Then v3.0.0 is the first FSL release.**

- **Why release it at all:** those 312 commits are already public under MIT. A release turns
  "some MIT commits nobody installed" into a **named** boundary, and gives current users the fixes
  on the licence they installed under. The major bump to 3.0.0 signals the licence change the way
  semver signals any breaking change in terms.
- **Tag** that commit also as `mit-final` (a permanent, human-readable marker).
- **Alternative if the owner prefers not to publish another release:** v2.68.0 stays the last MIT
  *release*, and `mit-final` marks the last MIT *commit* on `dev`. This is equally correct. It only
  leaves a window of MIT source that was never released as binaries.

### G.4 The order of operations

1. **Pre-conditions** (§I.4): ownership documented (L1, in the private note); the licence, CLA and
   notices taken from their **unmodified official templates** (L2, L4); the trademark filed at INPI
   (L7).
2. **(Optional) v2.69.0 / `mit-final`**, released from `origin/dev` as it stands.
3. **The relicense commit is the FIRST commit pushed after the hold is lifted.** It lands on
   `dev` directly on top of `mit-final` and changes only licensing files (§H).
4. **Every held branch is rebased onto the relicense commit, or squash-merged, before it is ever
   pushed.** **[INTERP] / [LAWYER]** A branch cut from pre-relicense `dev` carries `LICENSE = MIT` in
   every one of its own commits. If those commits are pushed as they are, each is a public tree
   containing new code next to an MIT licence file, which invites exactly the argument the hold
   exists to prevent. A rebase gives every new commit the new `LICENSE`; a squash merge publishes
   only the post-relicense tree.
5. **v3.0.0**, the first release under the new terms.
6. **The org transfer (t-cf96eb10bd)** after the relicense — so the licence history is continuous
   in one repository — **or** at the same time, if the transfer happens first. Either works. It must
   not be separated by a push of held code.

### G.5 How to document the change

- `LICENSING.md` — which path is under which licence, the MIT history ("every version up to and
  including v2.69.0 / commit `mit-final` is MIT and stays MIT"), and a plain-language FAQ: *Can I use
  it at work? Yes. Can I self-host it for my team? Yes. Can I offer it to my customers as a hosted
  service? No, talk to us.*
- `CHANGELOG.md` and the v3.0.0 release notes say it in the first paragraph, not a footnote.
- A short post / README section **before** v3.0.0 ships. [INTERP] Silence is what turns a
  reasonable licence change into a controversy.

### G.6 Existing contributions

- **[FACT]** Gondim's and Vinicius's contributions were made under MIT. **[INTERP]** MIT permits
  sublicensing, so their code may ship inside an FSL-licensed distribution **provided their MIT
  notice is preserved**. No consent is legally required for that ([LAWYER] confirm).
- **[REC]** Ask both to sign the CLA retroactively anyway. It is courteous, it removes the need to
  carry a separate MIT notice for their code, and there are only two of them. If either declines,
  keep their MIT notice in `NOTICE`, or rewrite the few hundred lines.
- AI co-authors and bots (`copilot-swe-agent`, `dependabot`, `github-actions`) are not contributors
  in the copyright sense. See §B.4.1 for what that implies.

### G.7 Dependencies

- **[FACT]** No copyleft dependency constrains the move. The JS tree is MIT/ISC/BSD/Apache. The MPL-2.0
  packages are a build tool (file-level copyleft, unmodified). The runtime's Vercel AI SDK is
  Apache-2.0 (runtime master §22.1.1).
- **[REC]** Keep third-party notices for bundled Apache/BSD code in `NOTICE` or a generated
  `THIRD_PARTY_NOTICES` file. The compiled binary and the desktop installer bundle these packages,
  and their licences require the notices to travel with them.
- **[REC]** Scan the desktop app's Rust dependency tree (Tauri) with `cargo-deny` or
  `cargo-about` before v3.0.0. It was not scanned here.

### G.8 A former e-mail address on some commits (Q1)

- **[FACT]** A different e-mail address appears on a block of commits made in 2026. Rewriting them
  would change the hash of nearly every later commit and **211 of the 215 release tags**, break every
  clone, worktree and fork, and remove nothing from the 7 existing forks or from archives. It is not
  a safe operation, and it does not achieve its goal.
- **[INTERP]** A rewritten history also reads as concealment to anyone comparing it against a fork.
  An honest `.mailmap` does not.
- **[REC] Add a `.mailmap`** that maps that address to the owner's personal identity. `git log`,
  `shortlog` and `blame` then show the right identity, with no rewrite. GitHub's web UI does not read
  `.mailmap`. Removing the address from the owner's GitHub account, if it is there, stops GitHub
  attributing those commits through it.
- **[INTERP]** The address on a commit neither creates nor transfers ownership (§B.4.2).

---

## H. What changes in the repository (a list — nothing here has been done)

| File | Change |
|---|---|
| `LICENSE` (root) | Replace with FSL-1.1-ALv2 text: Licensor (the owner, or a company if one is formed first — L3), "Software: Agentistics", copyright line |
| `LICENSING.md` (new) | Path → licence map, the MIT history and `mit-final`, the `ee/` convention (if used), the plain-language FAQ |
| `NOTICE` (new) | Copyright; "portions were previously released under MIT up to `mit-final`"; the MIT notices for external contributions (if no CLA); third-party notices, or a pointer to a generated file; the trademark statement |
| `TRADEMARKS.md` (new) | What forks may and may not do with the name and logo (keep the notices; do not use the mark for a modified product; plain nominative use is fine) |
| `CONTRIBUTING.md` | New "Licensing of contributions" section: the CLA requirement and how signing works |
| `CLA.md` (new) + `.github/workflows/cla.yml` | A licence-grant CLA (n8n-style: "permission to license my contributions on any terms"); a CLA-assistant bot that blocks merge until signed |
| `.github/PULL_REQUEST_TEMPLATE.md` | A CLA reminder |
| `README.md` | The badge at lines 23–24 (currently the MIT shield), a "License" section, "source-available" wording in place of "open source" |
| `CHANGELOG.md` | The v3.0.0 entry leads with the licence change |
| `package.json` (root) | `license: "FSL-1.1-ALv2"` |
| `packages/agentop/package.json` | `MIT` → `FSL-1.1-ALv2` (the npm installer ships the platform binary) |
| `packages/mcp/package.json` + `packages/mcp/LICENSE` (new) | `MIT` → `Apache-2.0` for new versions (or keep MIT; both are permissive — [REC] Apache for the patent grant and one integration licence) |
| `packages/vscode/package.json` + `packages/vscode/LICENSE` | `MIT` → `FSL-1.1-ALv2` (it imports `core` and `tui`) |
| `packages/runtime/package.json` | **Add** `license: "FSL-1.1-ALv2"`. Today it has none and is publishable — the most urgent metadata gap |
| `packages/{core,server,web,tui,desktop}/package.json` | Add the `license` field, even though they are private, so the map is machine-checkable |
| `packages/desktop/Cargo.toml`, `tauri.conf.json` | `license` / `bundle.copyright` / the installer's licence page (NSIS shows a licence) |
| `Dockerfile` | `LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2"` (and `vendor`, `source` after the org move) |
| `.mailmap` (new) | The former address → the owner's identity (G.8) |
| A lint test (new) | Every package's `license` matches `LICENSING.md`; an Apache package never imports an FSL package (F.1) |
| Headers | **[REC] No per-file headers now.** The package-level `LICENSE` plus `LICENSING.md` is sufficient, and 2,700 files of boilerplate is churn. Add SPDX short identifiers (`// SPDX-License-Identifier: Apache-2.0`) only in the Apache packages, where the line between licences needs to be visible in the file itself. If `ee/` is created, every file in it carries a header |
| Docs | `docs/architecture.md` (a licensing paragraph); `docs/mcp.md` (Apache); decisions E2 and E25 (wording: "source-available, open source after two years"); the E9 note "licence stays open" → a pointer to this document |
| Store listings | VS Code Marketplace, npm READMEs, the GHCR package description, the desktop installer's licence page |
| `ee/LICENSE` | **Only if** Q2 is decided for a self-hosted Enterprise |

---

## I. Legal risks — separated

### I.1 Facts

- The repository has been MIT since its first commit; v2.68.0 and all public commits stay MIT.
- MIT permits sublicensing; the two external contributions were made under MIT.
- FSL-1.1-ALv2, Elastic-2.0 and BUSL-1.1 have SPDX identifiers and are **not** OSI-approved.
- No dependency with a copyleft licence constrains the change (JS tree; the Rust tree was not scanned).
- INPI (Portaria INPI/PR nº 10/2025, in force for trademarks from 2025-09-20): R$ 880 per class,
  pre-approved specification, concession and first decade included; 50% off for eligible natural
  persons, MEI, ME and EPP. USPTO: US$ 350 per class (2025-01-18).

### I.2 Interpretations (mine — not legal conclusions)

- Unpublished work under the hold was never offered under MIT.
- Squash-merging or rebasing held branches onto the relicense commit avoids MIT-licensed trees
  containing new code.
- The FSL "Competing Use" definition covers a competing on-prem product, a competing SaaS, and a
  competing hub built on the platform.
- The e-mail on a commit does not transfer ownership.
- The copyright in heavily AI-assisted code is weaker and less certain than in hand-written code.

### I.3 Product recommendations

FSL for the platform; Apache-2.0 for the integration surface; a private hub; `ee/` reserved; the
trademark filed now; a licence-grant CLA; v2.69.0 as the last MIT release and v3.0.0 as the first
FSL one; `.mailmap`, not a history rewrite; no per-file headers.

### I.4 Open points — the owner decided not to consult a lawyer (2026-09-29)

Each row names the point a lawyer would normally settle and the step that reduces the risk without
one. What remains after that step is an accepted risk, stated here rather than hidden.

| # | Question | Why it matters | Reduced without a lawyer by |
|---|---|---|---|
| **L1** | **Ownership** | A licence granted by someone who does not hold the rights is void. This comes before everything else | The private note (outside this repository): hygiene from now on, a private evidence file, and a written statement of no claim |
| **L2** | **The licence text and parameters.** Is FSL-1.1-ALv2 enforceable as intended under Brazilian law (and US law, for foreign users)? Who is the Licensor? Does the "Competing Use" definition reach a competing hub built on the platform? | The licence is the whole instrument; its enforceability in the owner's own jurisdiction must be confirmed | Use the **official FSL-1.1-ALv2 template unmodified**, filling in only its parameters. A standard text is the one a stranger's lawyer has already read |
| **L3** | **The Licensor entity.** Should a company (Ltda.) be formed first and the copyright assigned to it, so the company — not the individual — licenses, sells and owns the mark? | Changing the Licensor after the fact is another relicense. The mark should be filed in the name of whoever will own the business | Decide before filing the trademark, and file it in the name of whoever will own the business |
| **L4** | **The CLA.** Wording (a licence grant with a right to relicense, not an assignment), its validity for Brazilian and foreign contributors, and the patent grant | It is what makes dual licensing and `ee/` possible | Adopt a published plain-language CLA (n8n's, from Indie Open Source) as-is: a licence grant, not an assignment |
| **L5** | **The cutover mechanics.** Is `mit-final` a sufficient boundary? Do MIT trees on held branches matter once squashed? What notices must the FSL distribution carry for the MIT history? | The whole point of the hold depends on it | Follow §G.4 exactly: `mit-final` tag, the relicense commit first, squash or rebase every held branch |
| **L6** | **AI authorship.** How should the owner document his human authorship, selection and arrangement so the copyright — and therefore the licence — holds? | It determines how much the licence can actually bind | Keep specs, reviews and decision records (this repository's `docs/superpowers/` already is one) as evidence of human direction |
| **L7** | **The trademark.** Prior-mark search, classes, the specification text, and whether "Agentistics" is registrable (it is coined, but "agent" is descriptive in this field) | The cheapest protection in this document, if done correctly | Run an INPI search, then file with the pre-approved specification (e-Marcas) for classes 9 and 42 |
| **L8** | **Terms of use, privacy policy, DPA** for the hub (E24), and their consistency with the licence | E24 already requires them before the first charge | Only needed before the first charge. Start from a reputable SaaS template and adapt it to LGPD |
| **L9** | **Vendor terms.** The harness vendors' terms on intermediating subscriptions and credentials (runtime master §22.3, E3 form C) | A licence does not protect a product that breaches a vendor's terms | The runtime master §22.3 rule: API keys only on hosted runners; never hold a vendor login |

---

## J. Sources

Primary sources, retrieved 2026-09-29. Quotes came through a fetch tool that may paraphrase
slightly; re-check the wording verbatim before quoting externally.

- n8n: Sustainable Use License — `github.com/n8n-io/n8n/blob/master/LICENSE.md`. Enterprise
  licence — `.../LICENSE_EE.md`. CLA — `.../CONTRIBUTOR_LICENSE_AGREEMENT.md`. Licence-change
  issue #2932 (2022-03-03). Blog — `blog.n8n.io/announcing-new-sustainable-use-license/`
  (2022-03-17).
- Sentry / FSL: `fsl.software`; templates `github.com/getsentry/fsl.software`
  (`FSL-1.1-ALv2.template.md`, `FSL-1.1-MIT.template.md`); blog
  `blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/`;
  Fair Source definition `fair.io/about/`.
- Elastic: ELv2 — `elastic.co/licensing/elastic-license`; blog
  `elastic.co/blog/elasticsearch-is-open-source-again` (2024-08-29).
- BSL 1.1: SPDX `spdx.org/licenses/BUSL-1.1.html` (the canonical mariadb.com page refused
  retrieval). HashiCorp Terraform v1.6.0 `LICENSE`; blog
  `hashicorp.com/blog/hashicorp-adopts-business-source-license` (2023-08-10); OpenTofu manifesto
  `opentofu.org/manifesto/`; Linux Foundation release `linuxfoundation.org/press/announcing-opentofu`
  (2023-09-20).
- Grafana: `grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/`.
- GitLab: `gitlab.com/gitlab-org/gitlab/-/raw/master/LICENSE` and `ee/LICENSE`; DCO switch
  `about.gitlab.com/blog/gitlab-switches-to-dco-license/` (2017-11-01).
- PostHog: `github.com/PostHog/posthog` `LICENSE` and `ee/LICENSE`.
- Plausible: `plausible.io/blog/open-source-licenses` (2020-10-12).
- Cal.com: `cal.com/blog/calcom-v6-4` (2026-04-15).
- DCO: `developercertificate.org`.
- SPDX licence list: `spdx.org/licenses/`.
- INPI: Portaria INPI/PR nº 10/2025
  (`gov.br/inpi/pt-br/servicos/marcas/arquivos/legislacao/PORT_INPI_PR_10_2025.pdf`), fee comparison
  and Q&A under `gov.br/inpi/pt-br/inpi-data/precificacao-dos-servicos/`.
- USPTO: `uspto.gov/trademarks/fees-payment-information/summary-2025-trademark-fee-changes`.
- WIPO Madrid fee schedule: `wipo.int/en/web/madrid-system/fees/sched`.
- This repository: `LICENSE`, `packages/*/package.json`, `git log` authorship and trailers, `gh pr
  list`, the dependency tree under `node_modules`, `npm view`, and the enterprise decisions E1–E25.

Not verified from a primary source: n8n's FAQ on white-label and embedding (their docs pages
returned 404), Grafana Enterprise's licence terms, whether the Madrid basic fee covers three
classes, and the Nice class descriptions themselves (classes 9 and 42 are standard practice).
