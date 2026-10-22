# Lead Intelligence Platform — Phase 1

Phase 1 of the architecture we agreed on: project setup, database, authentication, API foundation.
Everything in this phase is real, working code — it was written, migrated against a live
PostgreSQL instance, and exercised with real HTTP requests before being handed to you (see
"What was actually verified" below). Nothing here is mocked or stubbed.

## What's implemented

- **Database** — `packages/db/migrations/001_init.sql`: 31 tables covering the full V2 entity
  model (organizations/users/memberships, taxonomy, sources, leads + contacts + emails,
  history/provenance/change-events, campaigns + campaign runs, AI usage, audit log).
- **Auth** — real bcrypt password hashing (cost 12), JWT sessions, register/login/me endpoints,
  org created and OWNER membership assigned atomically on registration.
- **API** — Fastify + TypeScript, org-scoped queries throughout (every query filters by the
  authenticated user's organization — no cross-tenant leakage), Zod request validation.
  - `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
  - `GET /leads` (filters: country, status, verificationStatus, score range, hasEmail, search;
    paginated), `GET /leads/:id` (full detail: contacts, emails, provenance, history,
    verifications, classifications), `POST /leads` (manual entry — also the seam the
    USER_IMPORT connector type will use in Phase 3)
  - `POST /campaigns`, `GET /campaigns`, `GET /campaigns/:id`

## Why Prisma isn't used

The originally planned ORM (Prisma) downloads compiled query-engine binaries from
`binaries.prisma.sh` at install/generate time. That domain isn't reachable from build
environments restricted to package-registry traffic (npm/pypi/apt only) — including the
sandbox this was built in. Rather than block on that, this pivoted to raw SQL migrations +
the `pg` driver directly. This is a legitimate, common production pattern (not a downgrade),
and it removes a whole class of "works on my machine, fails in CI" problems tied to binary
downloads. If your actual deployment environment *can* reach `binaries.prisma.sh`, swapping
in Prisma (or Drizzle, which is pure-JS) later is a contained change — the SQL schema already
defines the target shape.

## Deliberately not in Phase 1

Per the phased plan: source connectors, scraping/extraction workers, AI classification,
scoring, verification, scheduler/queues, and the frontend all come in Phases 2–5. Building
those now would mean either (a) real network calls to arbitrary external sites, which this
sandbox's network allowlist doesn't permit, or (b) stubbed/fake versions — which was explicitly
ruled out. So Phase 1 stops at the foundation that Phases 2+ build on, and each of those phases
will be built and verified the same way this one was: for real, against a live system, wherever
the network/tooling in front of me allows it.

## What was actually verified (not just written)

Run in this session against a live local Postgres + the built API:

1. Applied the full migration to a real Postgres 16 instance — 31 tables, no errors.
2. `POST /auth/register` → created a real user + org + OWNER membership in one transaction.
3. `GET /auth/me` with the issued JWT → returned the correct joined user/org/role.
4. Duplicate registration with the same email → `409`.
5. Login with wrong password → `401`.
6. `POST /leads` → created a lead, auto-normalized the company name, parsed the domain from
   the URL, and wrote a `lead_history_events` row.
7. `GET /leads?country=AU` → correctly filtered to the created lead.
8. `GET /leads/:id` → returned the lead with its (empty-but-present) contacts/emails/provenance
   arrays and the one real history event.
9. Unauthenticated `GET /leads` → `401`.
10. `POST /campaigns` and `GET /campaigns` → created and listed a campaign with V2 fields
    (include/exclude countries, cost/runtime caps).

## Running it yourself

```bash
docker compose up --build
# API on http://localhost:4000, health check at /health
```

Or locally without Docker:

```bash
# Postgres + Redis running locally, then:
psql -d leadintel -f packages/db/migrations/001_init.sql
cd apps/api
cp .env.example .env   # fill in DATABASE_URL / JWT_SECRET
npm install
npm run dev
```

## Phase 2 — taxonomy, normalization, dedup, connector interface

Added on top of Phase 1, same standard (real code, run against a live Postgres, verified):

- **Taxonomy** (`routes/taxonomy.ts`) — `industries`/`categories`/`subcategories`/`countries`
  CRUD, plus `GET /taxonomy/tree` which assembles the full nested tree in one query (avoids
  N+1 calls from the frontend picker). Verified live: created Healthcare → Dental, tree
  endpoint returned it correctly nested.
- **Normalization** (`lib/normalize.ts`) — company name (legal-suffix stripping), domain,
  phone, email normalization, plus a from-scratch Jaro-Winkler similarity function (no
  external dependency — small enough to own and keeps dedup behavior from shifting under an
  upstream library change).
- **Duplicate detection** (`lib/dedup.ts`) — two-stage as designed in Architecture V2 §19:
  cheap indexed blocking (exact domain or normalized-name match) narrows candidates, then a
  weighted score (domain match + name similarity) classifies each as auto-merge
  (≥0.93), needs-review (0.75–0.93), or distinct. Wired into `POST /leads`: a matching
  submission updates `last_discovered` on the existing row and logs a history event instead
  of creating a duplicate row. Verified live: submitting `"Smith Dental Pty Ltd"` /
  `smithdental.com.au` followed by `"smith dental"` / `www.smithdental.com.au` produced
  **one** lead, not two, with `similarity: 1` recorded.
- **Source connector interface** (`connectors/types.ts`) — the typed plug-in contract from
  Architecture V2 §7 (capabilities, compliance mode, discover/fetch/parse).
- **Sitemap connector** (`connectors/sitemap.ts`) — a real implementation: walks a
  `sitemap.xml`, fetches pages, and extracts business data structured-data-first
  (schema.org JSON-LD) with a deterministic HTML fallback (mailto:/tel: links, `<title>`).
  This is genuinely functional code, not a stub — but see the caveat below on what could and
  couldn't be verified.

### What was verified live this round (real Postgres, real HTTP)

1. `POST /industries`, nested `POST /industries/:id/categories` → both created correctly.
2. `GET /taxonomy/tree` → correctly assembled nested industry→category→subcategory tree.
3. `POST /leads` with `"Smith Dental Pty Ltd"` → created.
4. `POST /leads` with `"smith dental"` (different casing, no suffix, `www.` domain variant) →
   matched the first as a duplicate (`similarity: 1`), updated it instead of creating a
   second row.
5. `GET /leads` for that org → returned exactly 1 lead, confirming no duplicate was created.

### What was verified via fixtures, not live HTTP (`connectors/sitemap.test.ts`, 22/22 passing)

The sitemap connector's `discover()` and `fetch()` methods call real external URLs by design —
this sandbox's network is restricted to package registries, so I can't demonstrate them
against a live third-party site from here. What I *could* verify without violating that
boundary: `parseSitemapXml()` and `parseBusinessPage()` — the actual parsing logic — against
realistic fixture data (sample sitemap XML, JSON-LD business markup, plain HTML with
mailto:/tel: links, malformed XML, 404 responses, empty pages). All 22 assertions pass,
including that malformed input degrades to zero/null results rather than throwing or
fabricating data. Run it yourself: `npx tsx src/connectors/sitemap.test.ts`.

**The honest gap:** I have not run this connector against a real website, because doing so
from this sandbox isn't possible. When you deploy this (or run it locally with normal internet
access), the `discover`/`fetch` methods should be exercised against one real, low-risk source
(a sitemap you have permission to crawl) before trusting it in a campaign — the parsing logic
is tested, the network round-trip to a real site is not.

### One environment note

This session's sandbox turned out to alternate between (at least) two underlying container
instances across tool calls, with independent filesystems/processes — background servers and
`.env` files from one call sometimes weren't there in the next. Worked around it by keeping
each live-test sequence (start Postgres/Redis → launch API → run the HTTP calls) inside a
single command rather than spanning multiple calls. Doesn't affect the code itself, just
explains why the testing looks batched rather than exploratory.

## Next: Phase 3

Source discovery orchestrator (basic version — AI strategy generation, query generation,
candidate source evaluation) and the extraction/verification worker queue (BullMQ). This is
where AI provider calls first enter the system, so it'll also be where the tiered
cost-optimization dispatch (Architecture V2 §24) gets its first real implementation.

## Phase 3 — AI provider abstraction, BullMQ queues, extraction/verification workers, basic orchestrator

Same standard again: real code, run against real infrastructure, verified before handoff.

### What's new

- **AI provider abstraction** (`ai/types.ts`, `ai/anthropicProvider.ts`, `ai/mockProvider.ts`,
  `ai/factory.ts`) — the full interface from Architecture V2 §23 (extract, classify,
  detect country, analyze relevance, summarize, generate search strategy, evaluate source).
  `getAIProvider()` uses a real Anthropic client when `ANTHROPIC_API_KEY` is set, and falls
  back to a deterministic mock provider (zero cost, no network) when it isn't — which is also
  what test code uses, per the "mock provider for CI, no live API spend" testing strategy
  from §42. **I don't have an Anthropic API key in this sandbox**, so the real provider's HTTP
  calls were never exercised live here — only the mock path was. The real provider's request
  shape is standard `/v1/messages` and should work as-is once you supply a key; treat it as
  written-but-unexercised, not verified.
- **Cost tracking + daily spend cap** (`ai/factory.ts`) — every AI call through
  `withCostTracking()` logs to `ai_usage` (now organization-scoped — added migration
  `002_ai_usage_org_scope.sql` after finding the Phase 1 schema didn't have this column) and
  checks cumulative spend against the campaign's `max_ai_cost_usd` before calling, throwing
  `AIBudgetExceededError` if the cap's hit. Verified live: generated a strategy (mock, $0),
  confirmed the `ai_usage` row, then set a cap of $0 and confirmed the next call was refused.
- **BullMQ queues** (`queues/index.ts`) — one queue per pipeline stage per §28
  (`extraction.fetch`, `verification`, plus stubs for `discovery.strategy`/`discovery.query`
  not yet consumed by a worker). Real Redis connection, verified with a live `PING`.
- **Extraction worker** (`extraction/worker.ts`) — consumes a candidate URL, runs it through
  the sitemap connector's `fetch`+`parse`, ingests the result (with dedup), records a
  `source_runs` row, and chains a verification job. This is the first place connector code
  actually runs inside the job pipeline rather than being called directly.
- **Verification worker + checks** (`verification/worker.ts`, `verification/checks.ts`) —
  email syntax, phone format, country/phone consistency, and a **real DNS-based domain check**
  (`dns.resolveMx`/`resolve4`). Rolls up into `verification_status` on the lead
  (VERIFIED/PARTIALLY_VERIFIED/INVALID) via a deterministic rule, no AI.
- **Basic discovery orchestrator** (`orchestrator/discovery.ts`) — scoped exactly to what
  Architecture V2 §45 calls MVP: AI strategy generation for a campaign, and running a campaign
  against one user-specified, already-approved source (sitemap discovery → candidate URLs →
  extraction queue). It deliberately does **not** yet do automatic source discovery from a bare
  description, source ranking against history, or the iterative re-prioritization loop — those
  need either more connector types or real campaign history to be meaningful, and are called
  out explicitly in the file as Phase 6+ work rather than silently missing.
- **Sources API** (`routes/sources.ts`) — register a source with a declared `complianceMode`,
  list sources, and a `/sources/:id/health` endpoint computing real success-rate/status from
  `source_runs` (§18's "healthy/degraded/needs_attention" states, computed not hardcoded).
- **Campaign strategy/approve/run endpoints** — `POST /campaigns/:id/strategy` (generate,
  reviewable), `POST /campaigns/:id/approve` (requires a strategy to exist first), `POST
  /campaigns/:id/run` (requires `ACTIVE` status — i.e. approved — first, enforced server-side
  not just by the UI).
- **Shared ingestion service** (`lib/ingestion.ts`) — the dedup-then-insert logic from Phase 2
  was embedded in the `POST /leads` handler; pulled out so the extraction worker uses the exact
  same path (no drift between the manual-entry and connector-discovered dedup behavior).
  Extended to also write `lead_field_provenance` and `lead_sources` attribution rows.

### What was verified live this round

Real Postgres, real Redis, real BullMQ workers, real HTTP requests throughout:

1. Redis connection — live `PING` → `PONG`.
2. **Full pipeline via a local fixture HTTP server** (`src/e2e-test.ts`) — since this sandbox
   can't reach arbitrary third-party sites, I stood up a local server serving a realistic
   `sitemap.xml` + a business page with schema.org JSON-LD, then ran the *actual* production
   path against it: connector discovers the URL from the sitemap → job enqueued to real BullMQ
   → real worker picks it up → connector fetches + parses (structured-data extraction) →
   ingestion writes the lead + field provenance + generic email → a verification job is
   chained automatically → verification worker runs real checks (including a real DNS lookup,
   which correctly failed because the fixture used `localhost` as its domain — accurate
   behavior on a test artifact, not a bug) → `verification_status` rolled up correctly.
   All assertions passed (1 lead created, correct company name, verification status set).
3. **Dedup through the queue, not just direct calls** (`src/e2e-dedup-test.ts`) — ran discovery
   against the same fixture twice through the full worker pipeline. Second pass correctly
   merged into the same lead (`duplicate_submission_merged` history event, updated
   `last_seen_at` on `lead_sources`), confirming the dedup logic holds when reached via workers,
   not only via the API route tested directly in Phase 2.
4. **AI provider factory + cost cap**, live: confirmed `getAIProvider()` returns the mock
   provider when no API key is set, confirmed the `ai_usage` row was written with the right
   organization/tier/cost, then confirmed a $0 cap correctly threw `AIBudgetExceededError`.
5. **Full campaign lifecycle via real HTTP**: created a source, created a campaign, generated
   a strategy (mock-labeled honestly in the response), confirmed `run` is rejected with `400`
   before approval, approved, ran successfully (0 candidates — accurate, since `example.com`
   genuinely has no `sitemap.xml`), and confirmed `/sources/:id/health` computed correctly
   from zero recorded runs.
6. Deterministic verification checks tested directly: email syntax, phone format, and a real
   DNS lookup (`google.com` → pass, a nonexistent domain → fail with `ENOTFOUND`).
7. Full `tsc --noEmit` type-check clean across the whole codebase after all additions.

### Honest gaps, stated plainly

- **The Anthropic provider's live HTTP path is untested** — no API key available here. It's
  written to the standard `/v1/messages` shape; verify it against a real key before trusting
  it in production.
- **Only the sitemap connector type is wired into the extraction worker.** The `type` field on
  `sources` supports API/RSS/STATIC_WEB/BROWSER/USER_IMPORT/SEARCH_DISCOVERY, but the worker's
  dispatch only handles SITEMAP so far — extending that switch is Phase 4 work, not a redesign.
- **No live third-party scraping was performed or could be performed from this sandbox** —
  every "real network" claim above is either against local fixtures I built for this purpose,
  or against domains explicitly in this sandbox's package-registry allowlist (which is why the
  DNS/domain-format tests used `google.com` — a deliberately neutral, universally-resolvable
  domain, not a scraping target).
- **Source ranking, historical performance weighting, and automatic source discovery from a
  bare campaign description are not built yet** — flagged in the orchestrator code itself as
  Phase 6+ scope, matching the original phase plan.

## Next: Phase 4

AI classification (industry/country) wired into the extraction pipeline as the Tier 3 fallback
when deterministic parsing leaves required fields empty, plus the four-way scoring split (Lead
Score / Data Confidence / Campaign Relevance / Source Confidence) from Architecture V2 §25.
This is also where I'd want a real `ANTHROPIC_API_KEY` from you (or your own test key) if you
want the AI paths verified live rather than only against the mock provider.

## Phase 4 — AI classification, four-way scoring, campaign relevance

Same standard, same honest caveat as Phase 3: no `ANTHROPIC_API_KEY` in this sandbox, so every
AI call below ran through the mock provider. The plumbing (cost tracking, budget caps, taxonomy
matching, review-queue flagging) is real and verified; the actual classification *quality* is
untested until you point this at a real key.

### What's new

- **AI classification** (`ai/classification.ts`) — `classifyLeadIndustry` (matches the AI's
  answer against the real taxonomy table, and — importantly — does **not** force a mapping if
  the AI's answer doesn't exactly match a taxonomy entry; instead logs a
  `classification_unmapped` history event for review, rather than silently picking the nearest
  option) and `classifyLeadCountry` (updates the lead, records provenance, and flags a
  `low_confidence_country_flagged` history event below a 0.6 confidence threshold — the §29
  "country conflict = review priority HIGH" rule, implemented as an actual flag, not just
  documented as an intention).
- **Four-way scoring** (`scoring/engine.ts`), exactly per §25, never collapsed:
  - **Lead Score** (0-100) — from field completeness, contact availability, verification
    status, and a source-overlap bonus (more independent sources confirming the same lead →
    higher confidence, capped so one source can't dominate).
  - **Data Confidence** (0-1) — from average field-level provenance confidence, completeness,
    and verification status.
  - **Campaign Relevance** (0-100, stored in `campaign_leads`, one row per lead-per-campaign,
    never written back to the lead's permanent score) — Tier 1/2 rule-based first (country
    include/exclude match, required-field presence); escalates to AI relevance analysis
    **only** when the rules didn't actually fire (i.e., the campaign's criteria are
    qualitative enough that keyword/rule matching has nothing to check) — the real Tier
    1→3 escalation pattern from §24, not just AI-for-everything.
  - **Source Confidence** — computed on demand from real `source_runs` success rate where
    history exists, falling back to a compliance-mode-based prior (official API > sitemap >
    RSS > user-provided > direct-crawl) when it doesn't. Explicitly documented as the simpler
    version — full historical ranking against `source_performance_history` is Phase 6.
- **Extraction worker** now attempts classification for newly-created, campaign-linked leads
  when deterministic extraction left industry/country empty, using the campaign's own
  `max_ai_cost_usd` as the spend cap — a budget-exceeded error doesn't fail the job (the lead
  was still successfully extracted), it logs `ai_classification_skipped_budget` and moves on.
- **Verification worker** now calls `computeLeadScore` after the verification rollup, so
  Lead Score/Data Confidence reflect real verification results, not stale data.
- **New endpoints**: `GET /campaigns/:id/leads` (leads ranked by campaign relevance, with
  signals), `POST /leads/:id/rescore` (manual trigger — useful for leads that never went
  through a campaign context, like manual entries).

### A real bug found and fixed during live testing

`computeLeadScore`'s source-overlap bonus formula (`Math.min(sourceCount - 1, 3) * 0.05`) went
**negative** for leads with zero sources (e.g. manually-entered leads, which have no
`lead_sources` row at all) — `sourceCount=0` → `-1 * 0.05`. Caught this by actually hitting
`POST /leads/:id/rescore` against a real manually-created lead and seeing
`"sourceOverlapBonus": -0.05` in the response. Fixed to floor at zero
(`Math.max(0, Math.min(sourceCount - 1, 3)) * 0.05`) and re-verified directly against a
zero-source lead (`sourceOverlapBonus: 0`, confirmed) plus reran both Phase 3 E2E tests to
confirm no regression. Flagging this explicitly rather than quietly — it's exactly the kind of
thing that only surfaces by actually running the code against real data, which is the whole
point of testing this way instead of just writing and shipping it.

### What was verified live this round

1. **Full pipeline through classification and scoring** (`src/e2e-phase4-test.ts`) — local
   fixture business page (Brisbane, AU, dental description, no machine-readable
   industry/country field) run through the real queue → extraction worker → ingestion →
   **AI industry classification** (matched "Healthcare" against the real seeded taxonomy row,
   confidence recorded, `lead.industry_id` set) → **AI country detection** (mock provider
   correctly returned "Unknown"/low confidence, which correctly triggered the
   `low_confidence_country_flagged` history event — the flagging logic working exactly as
   designed, even though the mock provider's *answer* was a placeholder) → verification →
   **Lead Score computed (17)** and **Data Confidence computed (0.3)** → **Campaign Relevance
   computed separately (35)**, correctly penalized because the mock-detected country ("XX")
   didn't match the campaign's `AU` include list — proving the four scores are genuinely
   independent, not the same number in four columns.
2. **Manual entry → rescore → bug found → fixed → reverified**, live HTTP + direct DB calls,
   as described above.
3. Reran Phase 3's two E2E tests after the fix — both still pass, no regression.
4. Full `tsc --noEmit` clean across the whole codebase.

### Honest gaps, stated plainly

- **Classification quality is entirely unverified** — the mock provider's answers are
  placeholders (`"Healthcare"` because it's the first/only taxonomy entry, `"Unknown"/"XX"`
  always for country). What's proven is that the *pipeline* — cost tracking, taxonomy
  matching, confidence-based flagging, budget caps, score computation from real classification
  results — works correctly. Supply a real `ANTHROPIC_API_KEY` to find out if the actual
  classifications are any good.
- **Source Confidence has no historical-ranking version yet** — it's the compliance-mode prior
  / real-success-rate version only, as documented in the code and above. Phase 6 territory.
- **Campaign relevance's AI escalation path is real code but only exercised via the mock** —
  same caveat as classification.

## Next: Phase 5

Scheduler (cron-triggered recurring campaign runs) and multi-source campaigns (currently
`runCampaignAgainstSource` takes one source at a time — the orchestrator doesn't yet loop over
an approved source pool). This is also a natural point to wire in a second connector type
(RSS or a simple API connector) so the "only sitemap is implemented" gap from Phase 3 starts
closing.

## Phase 5 — scheduler, multi-source campaigns, RSS connector

### What's new

- **RSS/Atom connector** (`connectors/rss.ts`) — second connector type, real implementation.
  Parses both RSS 2.0 (`<item><link>`) and Atom (`<entry><link href>`) formats. Reuses the
  sitemap connector's `parseBusinessPage` for actual page extraction, since structured-data-
  first/deterministic-fallback doesn't depend on how the URL was discovered.
- **Connector factory** (`connectors/factory.ts`) — single dispatch point from a source's
  `type` column to the right connector instance. Both the orchestrator and the extraction
  worker go through this now instead of the extraction worker hardcoding
  `createSitemapConnector` regardless of the source's actual type (a latent bug from Phase 3:
  an RSS-discovered URL would previously have been fetched correctly by accident, since both
  connectors' `fetch`/`parse` happen to be identical, but it was structurally wrong and would
  have broken the moment a connector type with different fetch behavior — e.g. a browser
  connector — was added).
- **Multi-source campaigns** — new `campaign_sources` join table (migration
  `003_campaign_sources.sql`) is the "Approved Source Pool" from Architecture V2 §5.
  `POST /campaigns/:id/sources` attaches a source; `runCampaignAgainstApprovedSources` (new in
  `orchestrator/discovery.ts`) loops over all approved sources under one `campaign_runs` row,
  with a source whose connector type isn't implemented failing gracefully (recorded in
  `perSource` and `campaign_runs.errors`) rather than aborting the whole run.
- **Scheduler** (`scheduler/index.ts`, `scheduler/worker.ts`) — recurring campaign runs via
  BullMQ v6's Job Scheduler API. Worth noting: the installed BullMQ version (6.0.11) replaced
  the older `queue.add({repeat})` pattern with `upsertJobScheduler`/`getJobSchedulers`/
  `removeJobScheduler` — I initially wrote this against the older API from memory, and the
  live type-check caught it immediately (not a runtime surprise). `POST /campaigns/:id/schedule`
  accepts either a real cron expression or, for cases where a plain interval is more useful
  (and for testing), `everyMs`. A scheduled run checks the campaign is still `ACTIVE` before
  running — a paused/completed campaign's schedule doesn't silently keep firing.
- **`POST /campaigns/:id/run`** now supports both modes: give a `sourceId` to retry one source
  manually, or omit it to run the full approved pool — same endpoint, not a breaking change to
  Phase 3's contract.

### A structural bug found and fixed before it caused a real problem

The extraction worker's job data didn't carry the source's `type`/`baseUrl`, so it (and the
orchestrator, separately) had to reconstruct a connector from the raw URL — Phase 3's version
literally called `createSitemapConnector` unconditionally, which happened to work only because
`fetch`/`parse` are currently identical between the sitemap and RSS connectors. Introducing the
RSS connector as a genuinely different `discover()` implementation exposed this: the
orchestrator's `runCampaignAgainstSource` also had a `source.type !== "SITEMAP"` hard check that
would have rejected the new RSS sources outright. Fixed by threading `sourceType`/`sourceBaseUrl`
through the job data and routing both the orchestrator and the worker through the same
`createConnectorForSource` factory, so there's exactly one place that maps a DB `type` value to
a connector — verified by the Phase 5 E2E test actually running a campaign against one sitemap
source and one RSS source in the same run and getting one lead from each.

### What was verified live this round

1. **Fixture-based connector tests**: 6 new RSS/Atom assertions (RSS 2.0 parsing, Atom parsing,
   malformed-XML handling, empty-feed handling) — all pass, bringing the connector test suite
   to 28/28.
2. **Multi-source campaign run, live** (`src/e2e-phase5-test.ts`, Part 1): one campaign with
   two approved sources (one SITEMAP, one RSS) pointed at two different fixture businesses on
   the same local fixture server. `runCampaignAgainstApprovedSources` correctly enqueued
   candidates from both, and both leads landed in the database with the right data — proving
   the RSS connector works end-to-end, not just at the parsing-fixture level, and that
   `campaign_sources` genuinely drives multi-source execution rather than just being a table
   that exists.
3. **Real recurring scheduler, live** (same test, Part 2): registered a schedule with a 1.5s
   interval via the actual BullMQ Job Scheduler (not simulated, not a setTimeout loop I wrote
   myself), and waited for it to fire **three separate times on its own**, each producing a
   real `campaign_runs` row with `discovered: 2`. Confirmed the schedule was listed via
   `getJobSchedulers()`, confirmed it stopped firing after `disableCampaignSchedule`, confirmed
   4 total `campaign_runs` rows existed (1 manual + 3 scheduled) — that's about as close to
   "proven, not asserted" as recurring-job behavior gets without waiting on a real cron tick.
4. **Live HTTP test of every new endpoint**: attach a source to a campaign, list a campaign's
   sources, run against the approved pool via `POST /campaigns/:id/run` with no `sourceId` in
   the body, schedule with a real cron expression, unschedule. All worked correctly against the
   live API and database.
5. **Full regression suite rerun** after every change in this phase (job-data shape change,
   scheduler API rewrite) — all of Phase 3's and Phase 4's E2E tests and the connector fixture
   suite still pass.
6. Full `tsc --noEmit` clean.

### Honest gaps, stated plainly

- **The scheduler was only tested with `everyMs`, not a real cron pattern's actual tick
  timing** — the cron *expression* was tested for acceptance (`POST .../schedule` with
  `"0 2 * * *"` succeeded and was stored/listed correctly), but waiting for an actual 2am
  trigger isn't something a test run can verify. The underlying mechanism (BullMQ's Job
  Scheduler) is the same regardless of whether the input is a cron pattern or an interval, so
  this is a reasonable inference, not a leap — but it's still an inference, not a direct
  observation, and worth being clear about the difference.
- **Only SITEMAP and RSS connector types are implemented.** API/STATIC_WEB/BROWSER/
  USER_IMPORT/SEARCH_DISCOVERY are typed throughout the schema and connector interface but
  have no connector implementation — `createConnectorForSource` throws a clear error for them
  rather than pretending to support them.
- **Source ranking/prioritization within a multi-source run is manual** (`campaign_sources.priority`,
  set by the caller) — there's no automatic reordering based on historical performance yet.
  That's still Phase 6, same as noted in Phase 3/4.

## Next: Phase 6

Enrichment engine (fill gaps in existing leads via targeted re-discovery), source ranking
against real historical performance now that Phase 5 produces actual multi-run history to rank
against, human review queue with the priority levels from §16, and change detection for
re-verified leads.

## Phase 6 — review queue, change detection, enrichment engine, source ranking

### What's new

- **Review Queue as a first-class table** (`review_flags`, migration `004_review_flags.sql`)
  — HIGH/MEDIUM/LOW priority per §16, written explicitly at the four points in the pipeline
  that already detect review-worthy conditions rather than inferred later by parsing history
  events: dedup ambiguity (HIGH), low-confidence country detection (HIGH), unmapped AI
  classification (MEDIUM), budget-skipped classification (LOW), plus a new one from change
  detection below (website domain changed = MEDIUM, company name changed = LOW).
  `GET /review-queue` (filterable by priority/reason, sorted HIGH→LOW then newest-first),
  `GET /review-queue/summary` (counts per priority), `POST /review-queue/:id/resolve`.
- **Change detection** (`lib/changeDetection.ts`) — runs on every dedup-matched re-discovery.
  Two different behaviors depending on the kind of difference found, matching the "don't
  silently overwrite" requirement exactly: a field that was **empty** and is now populated
  gets filled in directly (nothing to lose); a field that already had a **different** value
  gets logged to `lead_change_events` and flagged for review, but is **not** auto-applied — a
  changed website or company name could mean a rebrand, or it could mean the dedup match was
  wrong, and that's a human judgment call. New emails found on a re-discovery are added
  additively (not a "change" to an existing value).
- **Enrichment Engine** (`enrichment/engine.ts`) — scoped to one lead, not a campaign-wide
  crawl, per §20. Re-fetches the lead's own website; fills in email if the lead currently has
  none (applied automatically, since there's nothing to overwrite); records address text as an
  enrichment attempt but does **not** auto-parse it into city/region (that needs NLP/AI
  judgment this phase doesn't do), instead flagging it for review. Every attempt — successful,
  partial, or a dead fetch — is recorded in `lead_enrichment_runs` with source/method/confidence.
  `POST /leads/:id/enrich`.
- **Source ranking** (`orchestrator/sourceRanking.ts`) — now that Phase 5 produces real
  `source_runs` history, `rankSourcesForCampaign` computes each approved source's confidence
  (via Phase 4's `computeSourceConfidence`, which already blends real success rate with a
  compliance-mode prior) and **writes the result back into `campaign_sources.priority`** — not
  just displayed, actually used, since `runCampaignAgainstApprovedSources` already orders by
  priority descending. `POST /campaigns/:id/sources/rank`.

### A wrong assumption caught by actually running the test, not by reasoning about it

My first version of the Phase 6 E2E test assumed that re-discovering a business with the same
name but a completely different domain would (or should) be treated as the same lead. Running
it immediately proved that assumption wrong: the dedup scoring correctly computed a similarity
of 0.85 (name-only match, no domain match) — above the review threshold but *below* the
auto-merge threshold — so it created a second lead and raised a HIGH-priority
`duplicate_candidate_ambiguous` flag instead of guessing either way. That's actually the
*correct* behavior per the architecture (§12: "when appropriate, merge... never silently
destroy," §29: ambiguous duplicates are explicitly a HIGH review reason) — my test's
expectations were wrong, not the code. Rewrote the test with two properly-distinguished
scenarios instead of "fixing" the implementation to match a flawed assumption: same-domain
rename (correctly auto-merges, with the rename logged and flagged) vs. different-domain
same-name (correctly stays ambiguous, not merged). Documented here rather than quietly
discarding the failed first attempt, since it's a real example of testing catching a design
question worth being explicit about.

### What was verified live this round

1. **Change detection, both branches** (`src/e2e-phase6-test.ts`, Parts 1–2b): same-domain
   rename correctly auto-merged (1 lead, not 2), the OLD company name stayed in the database
   (not silently overwritten), a `lead_change_events` row recorded old→new, and a LOW-priority
   review flag was raised. Different-domain same-name correctly created a second lead with a
   HIGH-priority ambiguous-duplicate flag, as described above.
2. **Enrichment, live**: a lead created with a website but zero emails, run through
   `enrichLead`, correctly fetched its own website, found an email via structured-data
   extraction, and applied it — confirmed both in `lead_emails` and in the
   `lead_enrichment_runs` audit trail (`applied: true`).
3. **Source ranking, live**: created a campaign with one approved source, ran the ranking
   function, confirmed it returned a result AND that `campaign_sources.priority` in the
   database actually changed to match — not just computed and discarded.
4. **Review queue over real HTTP**: created an ambiguous-duplicate pair via the live API,
   confirmed it showed up correctly in `GET /review-queue` (right priority, right reason, right
   candidate details) and in `/review-queue/summary`, resolved it via
   `POST /review-queue/:id/resolve`, confirmed it disappeared from the OPEN-status listing.
5. **`POST /leads/:id/enrich` against `example.com`** (a real, reachable domain in this
   sandbox's allowlist) correctly returned nothing applied — `example.com` genuinely has no
   schema.org business markup, so an empty result is accurate, not a bug being hidden.
6. **Independently re-verified this whole phase** in a follow-up session (picking up after an
   interruption): reran the Phase 6 E2E test cold, reran the entire cross-phase regression
   suite (connector fixtures + Phases 3/4/5 E2E tests), and separately live-HTTP-tested the
   review-queue list/summary/resolve cycle and the enrich endpoint against a lead with no
   website at all (correctly returns `{applied: [], flaggedForReview: []}` rather than
   erroring) — all green, no drift from what's documented above.
7. Full `tsc --noEmit` clean.

### Honest gaps, stated plainly

- **Enrichment only re-fetches the lead's own website** — discovering genuinely *new* sources
  to enrich a sparse lead from (per §20's fuller vision) isn't built; this is the narrower,
  safer version explicitly scoped in the code's own comments.
- **Address parsing into structured city/region/postal fields is not implemented** — enrichment
  records the raw address text and flags it for review rather than guessing at a parse. Real
  structured parsing would need either a proper address-parsing library or an AI call, neither
  of which is in this phase's scope.
- **Source ranking has no decay/recency weighting yet** — `computeSourceConfidence` uses
  all-time success rate, so a source that used to perform well but has degraded recently ranks
  the same as one that's been consistently good. A weighted-recent-window version is a
  reasonable next refinement, not built here.

## Next: Phase 7

Analytics/dashboard endpoints (the numbers Architecture V2 §33/§37/§38 describe — lead/campaign/
source trend data), AI cost reporting by campaign/source, and export (CSV/XLSX/JSON respecting
active filters). This is largely aggregation over data every prior phase has been generating —
a good point to also circle back and add a couple of the still-open items (address parsing,
STATIC_WEB/API connector types) if you'd rather prioritize depth over breadth at this stage.

## Phase 7 — dashboard, analytics, AI cost reporting, exports

### What's new

- **Dashboard** (`GET /dashboard`) — the exact metric set from §24/§33: total leads, new
  today/this week, verified count, high-quality count (score ≥ 80), active campaigns, running/
  failed jobs, distinct countries/industries. All real aggregation queries against `leads`/
  `campaigns`/`campaign_runs`, no separate pre-computed stats table.
- **Analytics endpoints** (`routes/analytics.ts`): leads by country, by industry, by source
  (via `lead_sources`, so a lead confirmed by multiple sources counts toward each), by day
  (configurable window), verification-rate breakdown, quality-score distribution
  (high/medium/low/unscored buckets), and campaign performance (leads evaluated, average
  relevance, discovered/error totals per campaign).
- **AI cost reporting** (`GET /analytics/ai-cost?groupBy=campaign|operation|tier`) — real
  aggregation over `ai_usage`, plus today's running total so the admin panel can show spend
  against the cap `withCostTracking` is already enforcing (Phase 3), not just describe it.
- **Exports** (`GET /leads/export?format=csv|xlsx|json`) — reuses the **exact same filter
  logic** as `GET /leads` (extracted into `lib/leadFilters.ts` so the two can't drift), per
  §23's "exports must respect currently selected filters." CSV is a real hand-rolled
  serializer with proper quote/comma/newline escaping (tested against a company name
  containing both a comma and an embedded quote); XLSX is a genuine workbook via SheetJS, not
  a renamed CSV — verified with the `file` command reporting `Microsoft Excel 2007+`, not
  guessed at.

### A real refactor, not just new files

`GET /leads`' filter-building logic (country/status/verification/score range/hasEmail/search)
was duplicated for the export endpoint's first draft — pulled it into
`buildLeadFilterClause()` in `lib/leadFilters.ts` instead, shared by both routes, specifically
because a filter that behaves differently between "what I'm looking at" and "what I exported"
would be a real, easy-to-miss bug. Reran the full cross-phase regression suite after this
refactor (not just the new Phase 7 code) since it touched an existing, already-tested route.

### What was verified live this round

1. **Dashboard and every analytics endpoint**, live, against a fresh org with real leads
   created through the actual API (not seeded directly in the database) — counts matched
   exactly what was created (2 leads → `total_leads: 2`, 2 distinct country codes →
   `countries: 2`, etc.).
2. **CSV export escaping**, live, with a deliberately adversarial company name
   (`Export Test, "The" Co` — both a comma and an embedded quote) — came back correctly as
   `"Export Test, ""The"" Co"`, valid CSV, not corrupted.
3. **XLSX export**, live — downloaded the actual binary, confirmed `content-type`/
   `content-disposition` headers, and confirmed with the `file` utility that the bytes are a
   genuine `Microsoft Excel 2007+` file, not just CSV bytes with an `.xlsx` name slapped on.
4. **Export filtering**, live — `minScore=999` (an impossible filter) correctly returned an
   empty export rather than ignoring the filter.
5. **AI cost reporting**, live — generated a real strategy call through a real campaign,
   confirmed it showed up correctly grouped by both campaign and operation, with the mock
   provider's `$0` cost reported accurately rather than a fabricated non-zero number.
6. **Full cross-phase regression suite** (connector fixtures + all of Phases 3–6's E2E tests)
   rerun clean after the `leads.ts` refactor.
7. Full `tsc --noEmit` clean.

### Honest gaps, stated plainly

- **No caching/materialization layer** — every analytics query runs live against the
  transactional tables. Fine at this data volume; would need revisiting (read replicas,
  materialized views, or a proper OLAP path) at real production scale, per Architecture V2
  §44's own scaling order (that's explicitly a "when actually needed" step, not a day-one one).
- **`leads-by-source` counts a lead once per source it's attributed to** (via `lead_sources`),
  which is correct for "how many leads did this source contribute" but means the sum across
  sources can exceed total lead count when leads have multiple sources — worth knowing when
  reading the numbers, not a bug.
- **Export is capped at 10,000 rows** as a safety net against an unbounded query; a true
  "export everything" for very large orgs would need streaming or pagination, not built here.

## Next: Phase 8

Testing/security hardening and deployment polish per the original phase plan: rate limiting,
security headers, input sanitization review, a proper test suite structure (the E2E tests so
far are manual scripts, not wired into CI), and documentation. Also a reasonable point to
revisit the still-open connector types (STATIC_WEB, API) and address parsing if depth on those
matters more than moving to the final phase.

## Phase 8 — security hardening, real test suite, CI

### What's new

- **Security headers** via `@fastify/helmet` — HSTS, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, and the rest of helmet's defaults, `contentSecurityPolicy` disabled since
  this is a pure JSON API with no HTML to protect against injection into.
- **Rate limiting** via `@fastify/rate-limit` — a global 200/min baseline, plus a much
  stricter 10/min specifically on `/auth/login` and `/auth/register` (the actual
  credential-guessing targets), configured per-route rather than relying on the global limit
  alone to catch that case.
- **Fail-fast environment validation** (`lib/env.ts`) — missing `DATABASE_URL`/`JWT_SECRET`
  crashes on startup with a clear message instead of failing confusingly on the first request.
  In `NODE_ENV=production`, additionally refuses to start on the dev-default JWT secret or a
  secret under 32 characters, and warns loudly (doesn't block) if `ANTHROPIC_API_KEY` or
  `ALLOWED_ORIGINS` aren't set — the difference being a missing DB connection can't work at
  all, while running production on the mock AI provider or open CORS "works" but shouldn't
  happen silently.
- **Configurable CORS** — `ALLOWED_ORIGINS` (comma-separated) instead of the hardcoded
  allow-all from every prior phase; still defaults to allow-all for local dev convenience, but
  `validateEnv()` calls that out explicitly in production.
- **Audit logging wired to the highest-risk automated writes** (§39) — dedup auto-merges (two
  records treated as one company without a human confirming it) and enrichment auto-applies
  (a field gets a new value without review), plus explicit admin actions (source registration,
  campaign approval). Uses the `audit_logs` table that's existed since Phase 1's schema but
  was unpopulated until now.
- **A real test suite** (`tests/unit/*.test.ts`) using Node's built-in `node:test` +
  `node:assert/strict` — replaced the old manual `console.log`/`process.exit` script from
  Phase 3 with proper `describe`/`test` structure. 35 tests across 13 suites: connector
  parsing, RSS/Atom parsing, normalization, dedup similarity scoring, and — genuinely, not
  mocked — live DNS-based domain verification checks. Run with `npm test`.
- **CI workflow** (`.github/workflows/ci.yml`) — provisions real Postgres/Redis service
  containers, applies migrations, type-checks, runs the unit suite, then runs all five E2E
  test scripts against the provisioned services.
- **Dockerfile hardening** — runs as a non-root user, adds a real `HEALTHCHECK` directive
  hitting `/health`.

### Two honest "written, not verified here" items — same treatment as the Anthropic provider

- **The CI workflow has never actually run.** This sandbox has no GitHub Actions runner to
  execute it against. It's written against real, standard Actions syntax and the actual
  `npm` scripts that exist in this repo (not invented ones), but "written correctly" and
  "verified to work" are different claims — push it and check the Actions tab before trusting
  it blind.
- **The Dockerfile has never actually been built.** No Docker available in this sandbox
  either. Same caveat: syntax is standard, logic is straightforward (non-root user, healthcheck
  hitting a real endpoint), but unbuilt.

Both are called out explicitly rather than left for you to discover — this is the same
standard applied to the Anthropic provider back in Phase 3, extended to infrastructure that
this sandbox simply doesn't have.

### A real, live-verified dependency conflict — and how it was actually resolved

Installing the latest `@fastify/helmet`/`@fastify/rate-limit` broke the server immediately on
startup: `FST_ERR_PLUGIN_VERSION_MISMATCH — expected '5.x' fastify version, '4.29.1' is
installed`. Rather than either ignore it or blindly upgrade Fastify itself (a bigger, riskier
change across 8 phases of existing code, this late), checked the actual npm registry for the
last major versions of each plugin that still declare Fastify 4.x compatibility
(`@fastify/helmet@11.1.1`, `@fastify/rate-limit@9.1.0` — confirmed by reading their `fp()`
version declarations directly in the installed source, not just the changelog), pinned those,
and re-verified the server started cleanly with real security headers on the response.

### What was verified live this round

1. **`validateEnv()` fail-fast behavior**, three cases: missing `JWT_SECRET` → exits 1 with a
   clear message; production + default/insecure `JWT_SECRET` → exits 1; valid dev config →
   passes through silently. All three run directly, not just reasoned about.
2. **Security headers on a live response** — `curl -D` against a running server shows
   `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, and the rest of
   helmet's header set actually present.
3. **Rate limiting, live, actually triggered** — 13 requests to `/auth/login` in a loop:
   requests 1–10 got real `401`s (wrong password), requests 11–13 got `429` — the limit isn't
   just configured, it measurably kicks in at the right count.
4. **Audit logging, live** — created a source and approved a campaign through the real API,
   then queried `audit_logs` directly and found both rows with correct `action`/`entity_type`/
   `details`.
5. **The real test suite, actually run** — `npm test` → 35/35 passing, including the live DNS
   checks (not mocked — `checkDomainDns("google.com")` really resolves, and the
   nonexistent-domain case really gets `ENOTFOUND` from a live lookup).
6. **Full cross-phase regression** (type-check + unit suite + all five E2E scripts) rerun after
   every change in this phase, including after the Fastify plugin version fix, since that
   touched the app entrypoint every route depends on.

### Honest gaps, stated plainly

- **No integration/contract tests for the HTTP layer itself** — the E2E scripts test the
  pipeline (queue → worker → DB) thoroughly but drive it directly, not through `supertest`-style
  HTTP assertions against the Fastify app. The live `curl` sessions throughout this whole
  project have covered the HTTP surface manually, phase by phase, but that's not the same as
  an automated, repeatable HTTP test suite.
- **CSRF protection wasn't added** — this is a JSON API using Bearer token auth (not cookies),
  where CSRF isn't the relevant threat model; noting the omission is deliberate, not missed.
- **Rate limit state is in-memory per Fastify instance by default** (`@fastify/rate-limit`
  supports a Redis store for multi-instance deployments, not configured here) — fine for a
  single API instance, would under-count correctly across multiple instances behind a load
  balancer without that store configured.

## Phase 8 was the last phase in the original plan. Where this leaves the project

Eight phases in, real and verified wherever this sandbox's network/tooling allowed it, with
every gap named rather than hidden:

- **Solid and live-tested throughout**: schema, auth, dedup, the full extraction→verification→
  scoring pipeline, multi-source campaigns, a real recurring scheduler, review queue, change
  detection, enrichment, analytics, exports, and now security hardening + a real test suite.
- **Real but only mock-provider-tested**: every AI classification/strategy/relevance call —
  the pipeline around them is proven, the actual model output quality isn't, pending a real
  `ANTHROPIC_API_KEY`.
- **Real but only fixture/local-tested**: the sitemap and RSS connectors' actual network calls
  — proven against local fixture servers and one real, unambiguously-safe smoke test
  (`example.com`), never against a real prospect business, per the compliance stance from
  Phase 1.
- **Written but unexecuted**: the CI workflow and Dockerfile, for lack of a runner/Docker in
  this environment.
- **Not built**: STATIC_WEB/API/BROWSER/USER_IMPORT/SEARCH_DISCOVERY connector types, structured
  address parsing, ML-based source ranking, a frontend.

Natural next steps if you continue: point a real `ANTHROPIC_API_KEY` at this and see what the
actual classifications look like; pick one real, permission-cleared source and run the sitemap
connector against it for real; or start the frontend, since the API surface is now broad enough
to build a UI against.
