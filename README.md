# ParliBench

**Benchmarking AI systems for Parliamentary Debate prep.** A deployable MVP with a React/TypeScript/Vite frontend on GitHub Pages and a Cloudflare Worker backed by D1.

Benchmark model executions and AI judgments are produced externally. An optional server-side Gemini extractor converts recorded case text into derived structured data; it never generates benchmark responses. Local development and deterministic extraction work without any AI credentials.

## Quick start

Requires Node.js 22.12+ (Node 24 also works) and npm. All commands run from the repository root.

```sh
npm ci
npm run setup          # generates the local-only PIN pepper in .dev.vars
npm run db:migrate     # initializes local D1
npm run dev            # Vite :5173 and Worker :8787
```

In a second terminal:

```sh
npm run db:seed
```

Open [the local application](http://127.0.0.1:5173). The Vite development proxy sends `/api` to the local Worker. No frontend environment file is needed locally.

The seed is deliberately fictional: four labeled demo systems, four motions (Serious and Informal), 32 case records, independent Government/Opposition tasks, two fictional AI judges with 96 judgments, and four human demo users with 48 votes each. Both human subgroups are represented. Demo PIN: **246810**, usernames `demo_debater`, `demo_observer`, `demo_debater_two`, and `demo_observer_two`. These are local demonstration accounts, not real people or evaluations. Seeding grants `demo_debater` administrator access locally, because importing the corpus is an administrator action.

Seeding is local-only and preserves an existing corpus. Re-running tops up each demo account to 48 votes. `npx tsx scripts/seed.ts --export-only` regenerates the importable [demo corpus](demo/benchmark.json), without contacting any services. The JSON includes fake AI judgments but no user credentials. Importing this corpus remotely is an explicit admin action; never present it as real benchmark evidence.

## Commands and structure

```sh
npm run typecheck       # frontend, shared types, Worker, scripts, tests
npm test               # statistical unit tests + Worker/D1 integration tests
npm run build          # dist/, including GitHub Pages 404.html and .nojekyll
npm run build:worker   # Wrangler production bundle dry run; does not deploy
npm run check          # all of the above
npm run types          # regenerate Worker environment types after config changes
```

| Path | Purpose |
| --- | --- |
| `src/` | React application, accessible native controls, self-hosted fonts |
| `worker/` | HTTP API, auth, matchmaking, imports, statistics, ranking engine |
| `shared/` | Metric, task, vote, and API response types |
| `migrations/` | Versioned D1 SQL schema and default ranking weights |
| `scripts/` | Local secrets, fake corpus/seed, admin bootstrap, Pages output, deployment configuration |
| `tests/` | Vitest statistical tests and real Miniflare/SQLite API tests |
| `.github/workflows/` | Validation, GitHub Pages frontend, manual Worker deployment |

On restricted Windows environments, Vite, Wrangler, Vitest, and tsx need permission to spawn their bundled local subprocesses. No external AI access is needed.

## Cloudflare D1 and Worker deployment

The frontend stays on **GitHub Pages**. Cloudflare hosts only the API and D1 database. The configured deployment uses `workers.dev`; a custom backend domain is also supported.

1. Authenticate with `npx wrangler login`, or provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the environment. The API token needs Worker script editing, D1 editing, and the permissions needed to bind a Workers custom domain in the selected zone.
2. Create the database:

   ```sh
   npx wrangler d1 create parlibench
   ```

3. Configure `wrangler.jsonc`. Replace the placeholder database ID with the returned UUID, set `ENVIRONMENT` to `production`, and set `ALLOWED_ORIGINS` to the exact frontend origin, such as `https://danielw412.github.io`. Origins do **not** include `/ParliBench`, a trailing slash, or any other path. Multiple permitted origins may be comma separated. Remove local origins in production.
4. Add the custom domain, in a Cloudflare-managed zone you control:

   ```json
   "routes": [{ "pattern": "api.your-domain.com", "custom_domain": true }]
   ```

   Use a subdomain dedicated to this Worker, without a conflicting DNS record. Cloudflare provisions the domain binding and TLS certificate. The hostname is a deployment input; this repository does not claim ownership of a domain or require `workers.dev`.
5. Apply migrations, then provision a **cryptographically random secret of at least 32 characters**. Migrations must run before the Worker deploys, because the backend reads `users.is_admin`:

   ```sh
   npx wrangler d1 migrations apply parlibench --remote
   npx wrangler secret put PIN_PEPPER
   npm run deploy:worker
   ```

   If the Worker does not yet exist when adding the secret, Wrangler can create it; otherwise deploy once, add the secret, then deploy again. Authentication fails closed until the pepper is configured. Do not reuse local demo secrets in production. Back up the PIN pepper securely: changing it invalidates existing PIN verification, and there is deliberately no recovery flow.

   Upgrading from the retired admin-key release: the migration promotes the founding account, after which `npx wrangler secret delete ADMIN_SECRET` removes the unused secret from the Worker. Delete the matching GitHub environment secret too. Nothing reads it once this version is deployed.
6. Verify `https://api.your-domain.com/api/health` returns `status: "ok"` and `generation: false`.

Alternatively, set `D1_DATABASE_ID`, `BACKEND_DOMAIN`, and `FRONTEND_ORIGIN` as environment variables and run `node scripts/configure-production.mjs`. This validates inputs and writes those deployment values into `wrangler.jsonc`. Keep separate working copies or restore local configuration before returning to local development.

For GitHub Actions backend deployment, create a `production` environment and configure:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Scoped deployment token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| Secret | `PIN_PEPPER` | Dedicated random PIN pepper |
| Variable | `D1_DATABASE_ID` | Created D1 UUID |
| Variable | `BACKEND_DOMAIN` | `api.your-domain.com` |
| Variable | `FRONTEND_ORIGIN` | `https://danielw412.github.io`, or the custom Pages origin |

Run **Deploy Cloudflare backend** manually. It runs checks, configures the domain, applies migrations, and deploys the Worker and secrets. The workflow never seeds production automatically. Add GitHub environment protection rules if your deployment process requires review.

Reference: [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## GitHub Pages frontend deployment

1. In repository Settings → Pages, choose **GitHub Actions** as the build source.
2. Set repository variable **`VITE_API_URL`** to the full API base, e.g. `https://api.your-domain.com/api`. This is public configuration, not a secret. A production build without it shows an explicit configuration error; it never silently falls back to fake API results.
3. Push to `main` or run **Deploy frontend to GitHub Pages** manually. The workflow tests the app, obtains the repository/custom-domain base path from `actions/configure-pages`, builds, and deploys `dist`.

For this repository, the default URL is `https://danielw412.github.io/ParliBench/`. The build base becomes `/ParliBench/`, and React Router uses the same basename. For a custom Pages domain the base is `/`. `dist/404.html` is a copy of the built SPA shell with base-prefixed assets, so refreshing `/ParliBench/arena` or `/ParliBench/profile/alice` loads the application correctly. GitHub Pages still returns HTTP 404 for such direct navigation; this is the static host’s limitation, while the app itself renders the correct route. Links inside the SPA use normal client-side navigation. `.nojekyll` prevents asset processing.

For a manual frontend build, copy `.env.example` to `.env.local` and set `VITE_API_URL` and `VITE_BASE_PATH`. Do not put secrets in any `VITE_` variable. Changes require rebuilding the frontend.

## User flow, privacy, and security

- Registration accepts a case-insensitive unique username (3–24 letters, digits, underscores), an exact 4- or 6-digit PIN, and a debater type. Registration enters the Arena immediately. There are no guests, email addresses, OAuth, or recovery.
- PINs use PBKDF2-SHA256 with 100,000 iterations, a random per-account salt, and a server-only pepper. Short PINs have low entropy, so account and IP attempt limits are essential. D1 stores fixed-window counters, including a 10-attempt account limit per 15 minutes. Registration is capped per IP. The deployment should retain Cloudflare’s normal edge protections.
- Sessions are 256-bit random bearer tokens, stored as SHA-256 hashes in D1, valid for 30 days, and revoked on logout. The frontend stores its token in localStorage for persistent login across unrelated Pages/backend domains without third-party cookie dependencies. As with any bearer token, script access can expose it; the app renders responses without HTML, remote media, or executable Markdown and contains no third-party analytics scripts.
- CORS uses an exact allowlist, handles preflight, and never uses a wildcard. All API responses use `no-store`; tokens and secrets never appear in URLs. Mutations are parameterized and validated with Zod. Request bodies are streamed into a bounded 2 MB buffer.
- Administrator access is a property of a user account (`users.is_admin`), not a shared password. Every `/api/admin` request re-reads the account behind the session bearer token, so a revoked role applies immediately to sessions that are already open. There is no admin header, admin secret, or admin-only credential to leak, and the frontend never holds one.
- Public profiles expose identity, debater type, aggregate counts, and personal rankings. Individual voting history is private to its owner. Public system pages never expose run text, raw outputs, prompts, or responses by ID.
- The Arena assigns complete responses to authenticated users. System metadata, response IDs, raw output, and tool provenance are withheld from its payload. It does not truncate responses. “Reveal system names after voting” defaults off and is saved server-side. This prevents direct identity disclosure, not statistical inference by an adversarial user who recognizes response style or correlates live ranking changes.

## Administrator accounts

Administrator access is a role on a user account. Sign in normally, then open `/admin`; the link appears in the footer for administrators. Non-administrators get an explicit refusal, and the server rejects every `/api/admin` request from an account without the role, so hiding the link is presentation only.

- **Initial administrator.** Migration [`0003_account_admins.sql`](migrations/0003_account_admins.sql) adds `users.is_admin` and promotes the existing `dannywang` account, but only when the database has no administrator yet. It is a no-op on a database where that account does not exist or an administrator already does, so re-running migrations never changes an established deployment.
- **Granting and revoking.** An administrator opens the **Administrators** tab in `/admin` to view every account and switch its role. Revoking applies immediately to sessions the other person already holds.
- **Last administrator.** The backend refuses any change that would leave zero administrators, including an administrator revoking their own access. Promote a replacement first.
- **Recovery.** If a deployment somehow has no administrator, grant one straight in D1 with `npm run admin:grant -- <username> --remote` (omit `--remote` for the local database). This needs Cloudflare credentials, so it is not a path an application user can take.

## Admin workflow

The existing Admin area provides **Next Run, Prompts, Rebuttal Pool, Manual Entry, JSON Import, Display Editor, Catalog, Ranking Weights, and Administrators**. Every endpoint is protected by account-based administrator authorization.

### Next Run scheduling

Choose **All systems** for global coverage balancing, or an active system to restrict recommendations. The selection persists in session storage. **Another option** respects that filter and excludes the current option when alternatives exist. An inactive or otherwise unavailable selected system produces an explicit empty state.

Government Case and Opposition Case are independent active-system × active-topic tasks. Each receives only the motion. Recommendations show system configuration, task, motion, sample, and the fully rendered prompt. Copy it, start the run, execute it externally, paste the raw response, and save. The backend snapshots the latest rendered prompt and revision when **Start this run** is clicked. Use the started run's Copy prompt action if a template changed after the recommendation appeared.

Open claims count as coverage and survive reload. Uncovered combinations come first; then the least-covered combinations are balanced by system, topic, pair, and side. Samples stay unique across concurrent tabs and direct imports. Claim resolution and response insertion are one atomic transaction. A failed import keeps the claim open. Claims snapshot system/topic metadata as well as the exact prompt, so in-progress work remains inspectable after a catalog change.

### Versioned prompts

[`prompts/government.txt`](prompts/government.txt) and [`prompts/opposition.txt`](prompts/opposition.txt) are the only default prompt sources. The Worker bundles them as text and seeds version 1 into D1 on first prompt/scheduler access. Runtime edits insert immutable `prompt_revisions` rows. Required `{MOTION}` placeholders are replaced in one pass; missing and unknown placeholders are rejected. Prompt revision edits cannot mutate started claims or historical response prompts.

No Rebuttal prompt is seeded. Its wording is deferred. The provisional template contract accepts `{MOTION}`, `{GOVERNMENT_CASE}`, and `{OPPOSITION_CASE}`; that contract can be changed when the final prompt is supplied. Saving a valid Rebuttal template enables otherwise executable Rebuttal recommendations.

### Structured results and optional Gemini

Raw output stays exact and canonical, including whitespace. After the response import commits, deterministic parsing recognizes the supplied case headings and validates [`shared/cases.ts`](shared/cases.ts). Derived JSON and revision history live separately in `structured_cases` and `structured_case_revisions`. Failure never rolls back or deletes the benchmark response. Next Run, Display Editor, and Rebuttal Pool expose extraction status, retry, and manual JSON correction.

The parser is conservative: missing core arguments, unrecognized preambles, and ambiguous headings trigger fallback instead of guessing. When Gemini is configured, the server tries these models in order:

1. `gemini-3.8-flash`
2. `gemini-3.7-flash`
3. `gemini-3.6-flash`
4. `gemini-3.5-flash-lite`

These are the requested model IDs. Availability depends on the Gemini API/account; unavailable models are recorded as failures and the next model is tried. No different model is silently substituted. `GEMINI_EXTRACTOR_MODELS` can override the comma-separated IDs. Each attempt has a six-second deadline; automatic fallback runs after saving via `waitUntil`. For large bulk imports, failed cases can be retried individually. Extraction is instructed to copy verbatim, with strict JSON validation and a mechanical wording-preservation check. It must not improve, fact-check, paraphrase, or invent debate content. Review derived data where needed.

To enable Gemini in production, create a key in [Google AI Studio](https://aistudio.google.com/apikey), then run:

```sh
npx wrangler secret put GEMINI_API_KEY
```

Paste the key into Wrangler's prompt. For local use, add `GEMINI_API_KEY=your-key` to the ignored `.dev.vars` file and restart `npm run dev`. Never use `VITE_*` for this key. With no key, parsing and manual correction still work. The Worker deployment workflow preserves separately configured secrets.

Arena uses the structured representation as readable headings, paragraphs, and subtle separation when it can be safely blinded. Missing/invalid structure falls back to validated display text. Explicit display edits take precedence. Each assignment snapshots exactly the rendered text and shared context shown to its judge; subsequent edits never rewrite the assignment.

### Frozen Rebuttal Pool

Admins select exact Government response IDs from the pool list. Freezing stores the response ID, topic, administrator, time, and a compact case snapshot. Neither the source nor its frozen content changes when rankings, extraction, or display text change. An inactive response or missing structured case is clearly marked unavailable; another source is never substituted.

A future Rebuttal run requires an active topic and tested system, a Rebuttal prompt revision, an available frozen Government source on that topic, and that tested system's own structured Opposition response on the topic. Government can come from another system. The scheduler chooses the earliest available Opposition sample deterministically. Every tested system is eligible to answer the same frozen sources.

[`coreCaseForRebuttal`](shared/cases.ts) centrally derives only contention `title`, `claim`, `warrants`, and `impact`. Comparative analysis, likely responses, defenses, round priorities, and system identity are excluded. Claims and responses retain immutable source IDs and exact compact input snapshots. Rebuttal Arena and AI comparisons require the same topic and frozen Government response and different tested systems; each system may use its own Opposition case.

### Imports, provenance, and history

Manual Entry handles systems, topics, independent cases, AI judges, and votes. JSON imports accept up to 500 records / 2 MB atomically; split large vote batches where appropriate. Main keys are `systems`, `topics`, `responses`, `ai_judges`, and `ai_votes`. See [`worker/validation.ts`](worker/validation.ts) and [`demo/benchmark.json`](demo/benchmark.json).

Every run retains system, topic, task, exact prompt/raw output, time, interface, reasoning, configuration, duration, sample, and context. Database triggers protect provenance. Display and structure revisions are separate. New Rebuttals additionally require Government/Opposition source IDs and compact input snapshots; prefer Next Run to assemble these safely.

Prediction, Standardized Rebuttal, Full Opposition, and old pipeline Rebuttals remain stored but are excluded from new scheduling, active rankings, and Arena filters. Historical relationship arrays remain accepted for archival imports; they are not offered in normal Manual Entry. Legacy assignments and vote snapshots remain accessible in judgment history.

Migration `0005_three_capabilities.sql` rebuilds the constrained response/claim tables while retaining historical rows and checks actual foreign-key integrity before committing. Legacy open claims without prompt snapshots are retained as released history; restart those runs with an explicit prompt version.

### AI judgments

An AI judge has its own unique ID and references a system configuration. Each imported AI vote specifies `judge_id`, `response_a`, `response_b`, `overall`, optional metric votes, `version`, ISO UTC `judged_at`, optional `explanation`, and **`snapshot_a` / `snapshot_b`**, the exact texts judged offline. The import normalizes pair order and vote direction. Historical versions remain; rankings use only the latest timestamp (then ID as deterministic tie-break) per judge and response pair. Multiple distinct AI judges can be selected individually or pooled.

Votes use `2` = A much better, `1` = A better, `0` = tie, `-1` = B better, `-2` = B much better. Metric skips are null or omitted; overall never allows skip. AI explanations and snapshots are admin data, not publicly browsable.

## Matchmaking and reconstructability

Matchups are unique canonical pairs of different-system responses with the same topic/task and, for Rebuttal, frozen Government source. A/B swaps do not make a new pair. Every assignment has a secure random ID, orientation, full text snapshots, shared-case snapshot, user, and timestamp. A unique `(user_id, matchup_id)` constraint atomically prevents duplicates across tabs, including abandoned comparisons. Reloading or requesting another matchup consumes a new pair; only voting history reopens a judged pair.

Candidate priority combines globally under-judged system pairs, under-judged individual response pairs, the user’s per-system exposure, a penalty for any of the last three topics, and random exploration. All filters are applied before selection. Inactive topics/systems/runs are excluded. A/B randomization uses Web Crypto. There is no speculative next-match prefetch that could consume unseen assignments.

Human votes store the canonical orientation. Edits update one current vote, replace its metric rows, and append an audit revision within one D1 batch. Original display snapshots and all vote revisions remain. Rankings are recalculated on reads, so edits are reflected immediately without a background cache refresh.

## Ranking methodology

The replaceable `RankingEngine` interface lives in `worker/ranking.ts`. V1 uses regularized **Bradley–Terry**, not averaged numeric ratings:

`P(A beats B) = sigmoid(skill_A − skill_B)`.

Five-level preferences are fractional pairwise outcomes: `[0, 0.25, 0.5, 0.75, 1]` for `[B much better, B better, tie, A better, A much better]`. The likelihood is optimized with Newton updates and a weak zero-centered Gaussian prior (standard deviation 2). This yields finite estimates for undefeated systems and sparse comparison graphs. No 1–10 scoring is used.

- **Overall Preference:** only the required overall comparison.
- **Individual metric:** only non-skipped votes for that metric.
- **Weighted Benchmark:** separate pairwise observations for available metrics, weighted by the backend’s task-specific weights. Weights renormalize over judged metrics on that ballot. All metrics together contribute at most one ballot’s likelihood mass; a five-metric ballot is not five independent comparisons.
- **Personal profiles:** query only the selected user’s human votes. Global AI/human votes never leak into the personal calculation. These are not user-defined weights.
- **Combined:** normalize the human and AI likelihood masses to configured shares (default 50/50). Downweight the larger source instead of multiplying the smaller source into false precision. If a source is absent, the result uses the available nonzero-weight source and reports the missing source. Human subgroup filters affect only human observations; AI judge selection affects only AI observations.

Default task weights:

| Metric | Government Case | Opposition Case | Rebuttal |
| --- | ---: | ---: | ---: |
| Argument Strength | 45% | 45% | 30% |
| Evidence / Examples | 20% | 20% | 15% |
| Creativity | 20% | 20% | 10% |
| Strategic Prioritization | 15% | 15% | 15% |
| Rebuttal Quality | — | — | 30% |

Threat Identification is excluded from active scoring and filters.

Reported values:

- Score: `100 × sigmoid(skill)`, predicted preference against a zero-skill reference. Not an absolute quality grade.
- Elo-style rating: `1500 + (400 / ln(10)) × skill`.
- Win share: weighted fractional outcomes, including ties and preference strength.
- Comparisons: unique contributing ballots, not number of metrics. Zero-observation systems remain visible and unranked.
- 95% intervals: inverse of the full penalized Hessian, centered to account for covariance between opponents, transformed to score/rating space. These are approximate regularized model intervals, not guarantees of population-level accuracy.
- Low confidence: fewer than 20 ballots, effective likelihood mass below 10, wide uncertainty, or a disconnected comparison graph. Disconnected components cannot be reliably ordered against each other even if the prior supplies a numerical score.

Head-to-head uses direct pairs only, requires at least 5 ballots and effective mass of 3 for each breakdown, and reports fractional win shares with weighted Wilson interval approximations. Inadequate slices explicitly say “Insufficient data.”

## API overview

All routes have an `/api` prefix. Every route uses the same `Authorization: Bearer <session>` credential; `/api/admin/*` additionally requires the session's account to be an administrator.

| Method / route | Access | Purpose |
| --- | --- | --- |
| `POST /auth/register`, `POST /auth/login` | Public, rate limited | Account + session |
| `GET /auth/me`, `POST /auth/logout`, `PATCH /settings` | User | Session and reveal preference |
| `POST /arena/next?category=&task=` | User | Reserve one unseen blind pair |
| `POST /judgments/:id`, `PUT /judgments/:id` | Owner | Submit / edit vote |
| `GET /judgments?offset=`, `GET /judgments/:id` | Owner | Paged history / original snapshots |
| `GET /leaderboard` | Public | Filtered rankings |
| `GET /profiles/:username[/leaderboard]` | Public | Counts / isolated personal rankings |
| `GET /systems`, `GET /systems/:id` | Public | Metadata and performance only |
| `GET /compare/:a/:b`, `GET /ai-judges`, `GET /stats`, `GET /health` | Public | Comparisons and catalog summaries |
| `GET /admin/catalog`, `POST /admin/import` | Admin | Private catalog, accounts and roles / atomic imports |
| `GET /admin/next-run?system=&exclude=` | Admin | Recommended run and the in-progress queue |
| `GET /admin/prompts`, `POST /admin/prompts` | Admin | List history / create prompt revision |
| `GET /admin/rebuttal-pool`, `POST /admin/rebuttal-pool` | Admin | Inspect sources / freeze exact `response_ids` |
| `GET /admin/responses/:id/structure`, `PUT /admin/responses/:id/structure` | Admin | Inspect / correct derived JSON |
| `POST /admin/responses/:id/structure/retry` | Admin | Retry deterministic and optional model extraction |
| `POST /admin/runs` | Admin | Claim a recommended run |
| `POST /admin/runs/:id/response` | Admin | Import the response for an in-progress run |
| `POST /admin/runs/:id/release` | Admin | Return an in-progress run to the queue |
| `GET /admin/responses/:id`, `PATCH /admin/responses/:id` | Admin | Run inspection / display-only edits |
| `PUT /admin/systems/:id`, `PUT /admin/topics/:id` | Admin | Metadata and active status |
| `PUT /admin/weights` | Admin | Complete metric and source weight configuration |
| `PATCH /admin/users/:id` | Admin | Grant or revoke administrator access on an account |

Leaderboard query values: `source=human|ai|combined`; `subgroup=all|Parliamentary Debater|Non-Parliamentary Debater`; `category=all|Serious|Informal`; `task=all|government|opposition|rebuttal`; `metric=overall|weighted|argument|evidence|creativity|strategy|rebuttal`; optional `judge=<id>`. Invalid enums return 400.

## Verification and MVP boundaries

Tests cover auth, imports, immutable provenance, prompt rendering/version snapshots, system filters, deterministic extraction and model fallback, manual revisions, frozen source fairness, Rebuttal relationships, concurrent claims/saves, historical-task exclusion, populated migration integrity, and ranking statistics. Integration tests forbid real model network requests; extractor tests inject mocked Gemini responses.

This is a small-corpus MVP. Ranking fitting and import reference validation currently load the selected observations/catalog into memory; the full Hessian inversion is cubic in the number of systems. Before scaling to a large public benchmark, add incremental sufficient-statistic aggregation, bounded admin catalog pagination, and scheduled pruning of expired rate-limit rows. Matchup construction is quadratic per topic/task. Application-level blinding does not prevent inference attacks against tiny datasets; public live results and self-selected judge populations have methodological limits. Confidence intervals do not account for correlated judges, repeated topic content, or systematic dataset selection bias.

The app does not verify the empirical truth of imported arguments or prove external fresh-thread creation. Those remain corpus curation responsibilities. Future tags, domain, difficulty, and motion type fit in topic `metadata_json` initially, with normalized tables when filtering requirements become concrete.
