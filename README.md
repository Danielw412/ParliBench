# ParliBench

**Benchmarking AI systems for Parliamentary Debate prep.** A deployable MVP with a React/TypeScript/Vite frontend on GitHub Pages and a Cloudflare Worker backed by D1.

**No AI APIs are called by this application.** There are no AI SDKs, inference endpoints, provider credentials, or Workers AI bindings. All model responses and AI judgments are produced elsewhere and imported. The integration test Worker denies outbound network requests. External systems can originally use any tools or search configuration; record that setup in their provenance.

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

The seed is deliberately fictional: four labeled demo systems, four motions (Serious and Informal), 80 run records, all four Arena types, linked fresh-context Opposition stages, two fictional AI judges with 192 judgments, and four human demo users with 48 votes each. Both human subgroups are represented. Demo PIN: **246810**, usernames `demo_debater`, `demo_observer`, `demo_debater_two`, and `demo_observer_two`. These are local demonstration accounts, not real people or evaluations. Seeding grants `demo_debater` administrator access locally, because importing the corpus is an administrator action.

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

The frontend stays on **GitHub Pages**. Cloudflare hosts only the API and D1 database. A custom backend domain is supported directly; `workers.dev` and preview URLs are disabled.

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

## Import workflow

Open `/admin` as an administrator, then choose:

- **Next run:** the scheduler names one benchmark run to execute next, starts it, and takes its response. See [Next run scheduling](#next-run-scheduling).
- **Manual entry:** systems, topics, responses, Opposition stages/pipelines, standardized rebuttal tasks, AI judges, and AI judgments. Reference fields use existing catalog records. All entries go through the same backend validation as JSON imports.
- **JSON import:** paste or select a local JSON file. A batch has up to 500 records and 2 MB. Use smaller batches (40 AI votes is a useful default) on restrictive query quotas. No partial import: validation errors, duplicate IDs/sample numbers, or invalid references roll back the whole batch.
- **Display editor:** select a response and update only `display_output`. Raw output is read-only. Every display revision is retained; already-issued Arena comparisons keep their snapshots.
- **Catalog:** activate/deactivate systems and topics. Inactive entries are not assigned to new judges; old votes remain in historical results. Metadata can also be updated with the protected system/topic PUT endpoints.
- **Ranking weights:** configure each task’s metric weights and the combined Human/AI shares. Each group must sum to 100%. Changes immediately affect derived rankings.
- **Administrators:** list every account with its type and join date, and grant or revoke administrator access. The last administrator cannot be demoted.

Top-level import keys (all optional arrays):

```json
{
  "systems": [],
  "topics": [],
  "standardized_rebuttal_tasks": [],
  "responses": [],
  "opposition_predictions": [],
  "opposition_rebuttals": [],
  "opposition_preps": [],
  "ai_judges": [],
  "ai_votes": []
}
```

See [`worker/validation.ts`](worker/validation.ts) for the authoritative field schemas and [`demo/benchmark.json`](demo/benchmark.json) for a complete importable example. The admin API accepts the JSON body at `POST /api/admin/import`. Supply `Content-Type: application/json` and the `Authorization: Bearer <session>` token of an administrator account.

### Next run scheduling

The **Next run** tab recommends exactly one run to execute next and shows only what is needed to execute it: the system configuration, the motion and category, the side and task, the sample number, the prompt earlier systems received for that motion and task, the shared Government case for a standardized rebuttal, and the stage text an Opposition continuation builds on. It does not explain its choice.

Candidates are derived from the database on every request: active systems x active topics x the tasks that pair can actually run now. Government and prediction are always available; a standardized rebuttal appears only where the topic has a shared case; a rebuttal appears only for a prediction that has none yet; a full preparation appears only for a linked prediction and fresh-context rebuttal. A recommendation is therefore always importable, and one always exists while an active system and an active topic do.

Ordering is recomputed from current coverage, never from a fixed list. Repeating a covered combination outweighs every other term, so untested combinations come first, and once everything has coverage the least-tested combination comes first. The remaining terms, in decreasing weight, are the model/topic pair, the model's total runs, the topic's total runs, the Government/Opposition balance within that model, and the same balance across the dataset. Sides are compared by density, because Government has one slot per topic and Opposition has several. A bounded random term distributes equally useful runs instead of always returning the same database row; **Another option** simply asks again.

Starting a run claims it. A claim is an in-progress run: it counts as coverage, reserves its sample number, and holds the stage it continues out of other recommendations until its response arrives or it is released. A unique index over open claims keeps two tabs from reserving the same sample. Claims persist, so a run started before the page was closed is still waiting under **In progress**.

Recording the response imports it through the same `bulkImport` path as every other record: blinding, provenance, pipeline relationships, and sample uniqueness are validated identically, and a rejected response leaves the run in progress. The response ID is derived from the run, the display text starts as a copy of the raw output until it is edited, and the provenance fields default to the stored system configuration. Nothing here calls a model; runs are still executed elsewhere and pasted back.

### Run provenance and Opposition

Every run stores `id`, `system_id`, `topic_id`, `task`, `raw_output`, `display_output`, `prompt`, ISO UTC `generated_at`, `interface`, nullable `reasoning`, `configuration`, optional `duration_ms`, positive `sample`, and `context_id`. The system is a **configuration**, not a model: two interfaces for the same model are separate IDs. Sample uniqueness is per system/topic/task/standardized-case. Import another sample to correct provenance; a database trigger prevents mutation of the raw run fields.

`raw_output` is stored exactly as supplied, including whitespace. Clean `display_output` offline to remove citations, source sections, tool traces/metadata, and identifying clues. The server removes common citation/HTML/source artifacts and rejects known system/provider/model/interface phrases. This is a defensive floor, not a semantic anonymity guarantee: administrators must inspect the text before use. Tool-enabled source runs remain allowed. The renderer only supports paragraphs, headings, bold text, and lists; it never executes imported HTML or loads imported links/images.

Opposition preparation is explicit:

1. Import a `prediction` run and an `opposition_predictions` record referencing it, in one batch.
2. In a **fresh external thread/context**, obtain a `rebuttal` run. Import it with `opposition_rebuttals: [{ response_id, prediction_response_id, fresh_context: 1 }]`. Context IDs must differ and topics must match. The server validates the claimed provenance; it cannot independently verify how an external tool opened its context.
3. Import a `full_opposition` run representing the complete pipeline configuration and any constructive material, plus `opposition_preps: [{ response_id, prediction_response_id, rebuttal_response_id }]`. The response display stores constructive material; the Arena assembles the complete prediction + fresh-context rebuttal + constructive text. If there is no constructive material, record “No additional constructive material.”

Stages may come from different systems. For cross-system pipelines, use a distinct system configuration identifying that complete pipeline; the ranking attributes the full prep to that configuration. Rebuttal-only stage runs are provenance records, not an additional Arena category. The three Opposition Arena types are prediction, standardized rebuttal, and full prep.

For standardized rebuttal, create a task with `id`, `topic_id`, `title`, `case_text`, and an optional `government_response_id`. Its case text is the exact shared case; when a Government response is referenced, it must have the same topic and Government task. Each standardized rebuttal run references `standardized_task_id`; different shared cases are never paired. The response prompt records exactly what each system received. Shared case text is displayed above both responses.

### AI judgments

An AI judge has its own unique ID and references a system configuration. Each imported AI vote specifies `judge_id`, `response_a`, `response_b`, `overall`, optional metric votes, `version`, ISO UTC `judged_at`, optional `explanation`, and **`snapshot_a` / `snapshot_b`**, the exact texts judged offline. The import normalizes pair order and vote direction. Historical versions remain; rankings use only the latest timestamp (then ID as deterministic tie-break) per judge and response pair. Multiple distinct AI judges can be selected individually or pooled.

Votes use `2` = A much better, `1` = A better, `0` = tie, `-1` = B better, `-2` = B much better. Metric skips are null or omitted; overall never allows skip. AI explanations and snapshots are admin data, not publicly browsable.

## Matchmaking and reconstructability

Matchups are unique canonical pairs of different-system responses with the same topic/task and standardized case. A/B swaps do not make a new pair. Every assignment has a secure random ID, orientation, full text snapshots, shared-case snapshot, user, and timestamp. A unique `(user_id, matchup_id)` constraint atomically prevents duplicates across tabs, including abandoned comparisons. Reloading or requesting another matchup consumes a new pair; only voting history reopens a judged pair.

Candidate priority combines globally under-judged system pairs, under-judged individual response pairs, the user’s per-system exposure, a penalty for any of the last three topics, and random exploration. All filters are applied before selection. Inactive topics/systems/runs are excluded. A/B randomization uses Web Crypto. There is no speculative next-match prefetch that could consume unseen assignments.

Human votes store the canonical orientation. Edits update one current vote, replace its metric rows, and append an audit revision within one D1 batch. Original display snapshots and all vote revisions remain. Rankings are recalculated on reads, so edits are reflected immediately without a background cache refresh.

## Ranking methodology

The replaceable `RankingEngine` interface lives in `worker/ranking.ts`. V1 uses regularized **Bradley–Terry**, not averaged numeric ratings:

`P(A beats B) = sigmoid(skill_A − skill_B)`.

Five-level preferences are fractional pairwise outcomes: `[0, 0.25, 0.5, 0.75, 1]` for `[B much better, B better, tie, A better, A much better]`. The likelihood is optimized with Newton updates and a weak zero-centered Gaussian prior (standard deviation 2). This yields finite estimates for undefeated systems and sparse comparison graphs. No 1–10 scoring is used.

- **Overall Preference:** only the required overall comparison.
- **Individual metric:** only non-skipped votes for that metric.
- **Weighted Benchmark:** separate pairwise observations for available metrics, weighted by the backend’s task-specific weights. Weights renormalize over judged metrics on that ballot. All metrics together contribute at most one ballot’s likelihood mass; a six-metric ballot is not six independent comparisons.
- **Personal profiles:** query only the selected user’s human votes. Global AI/human votes never leak into the personal calculation. These are not user-defined weights.
- **Combined:** normalize the human and AI likelihood masses to configured shares (default 50/50). Downweight the larger source instead of multiplying the smaller source into false precision. If a source is absent, the result uses the available nonzero-weight source and reports the missing source. Human subgroup filters affect only human observations; AI judge selection affects only AI observations.

Default task weights:

| Metric | Government | Prediction | Standard rebuttal | Full Opposition |
| --- | ---: | ---: | ---: | ---: |
| Argument Strength | 45% | 30% | 30% | 30% |
| Evidence / Examples | 20% | 10% | 15% | 10% |
| Creativity | 20% | 15% | 10% | 10% |
| Strategic Prioritization | 15% | 15% | 15% | 10% |
| Threat Identification | — | 30% | — | 15% |
| Rebuttal Quality | — | — | 30% | 25% |

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
| `GET /admin/next-run` | Admin | Recommended run and the in-progress queue |
| `POST /admin/runs` | Admin | Claim a recommended run |
| `POST /admin/runs/:id/response` | Admin | Import the response for an in-progress run |
| `POST /admin/runs/:id/release` | Admin | Return an in-progress run to the queue |
| `GET /admin/responses/:id`, `PATCH /admin/responses/:id` | Admin | Run inspection / display-only edits |
| `PUT /admin/systems/:id`, `PUT /admin/topics/:id` | Admin | Metadata and active status |
| `PUT /admin/weights` | Admin | Complete metric and source weight configuration |
| `PATCH /admin/users/:id` | Admin | Grant or revoke administrator access on an account |

Leaderboard query values: `source=human|ai|combined`; `subgroup=all|Parliamentary Debater|Non-Parliamentary Debater`; `category=all|Serious|Informal`; `task=all|government|opposition|prediction|standardized_rebuttal|full_opposition`; `metric=overall|weighted|argument|evidence|creativity|strategy|threat|rebuttal`; optional `judge=<id>`. Invalid enums return 400.

## Verification and MVP boundaries

Tests cover registration/login, unique usernames, PIN rules, hashing/sessions, the administrator bootstrap migration, admin authorization (including that the retired admin header grants nothing), role changes and the last-administrator guard, rate limits, CORS, duplicate and concurrent matchmaking, A/B randomization, category/task filters, full Opposition assembly, standardized shared cases, required overall votes, skips, edit ownership and audit history, immutable raw output, snapshot preservation, import rollback/references/duplicates, cross-system pipelines, multiple samples, run scheduling priorities and pipeline gating, run claims and response entry, AI versions, personal isolation, source weighting, Bradley–Terry, score conversions, and confidence intervals. Browser review covers desktop/mobile rendering and real local UI interactions.

This is a small-corpus MVP. Ranking fitting and import reference validation currently load the selected observations/catalog into memory; the full Hessian inversion is cubic in the number of systems. Before scaling to a large public benchmark, add incremental sufficient-statistic aggregation, bounded admin catalog pagination, and scheduled pruning of expired rate-limit rows. Matchup construction is quadratic per topic/task. Application-level blinding does not prevent inference attacks against tiny datasets; public live results and self-selected judge populations have methodological limits. Confidence intervals do not account for correlated judges, repeated topic content, or systematic dataset selection bias.

The app does not verify the empirical truth of imported arguments or prove external fresh-thread creation. Those remain corpus curation responsibilities. Future tags, domain, difficulty, and motion type fit in topic `metadata_json` initially, with normalized tables when filtering requirements become concrete.
