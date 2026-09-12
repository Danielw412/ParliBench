# AGENTS.md — ParliBench

## What this repo is
ParliBench benchmarks AI systems for Pennsylvania High School Speech and Debate League (PHSSL) Parliamentary Debate prep.

Stack:
- Frontend: React + TypeScript + Vite on GitHub Pages
- Backend: Cloudflare Worker
- Database: Cloudflare D1
- Shared domain/types: `shared/`
- Tests: Vitest + Miniflare/SQLite

Do not rewrite the stack or replace D1/Worker/Vite unless explicitly asked.

## Core commands
```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run build:worker
npm run check
npm run db:migrate
```
Run `npm run check` after substantial changes.

## Important files

### Shared
- `shared/domain.ts` — task/metric names, labels, shared API types, run slot/plan types. Keep task/metric definitions centralized here.

### Frontend
- `src/App.tsx` — routing/app shell
- `src/NextRun.tsx` — next-run recommendation, run claiming, response recording
- `src/pages/Admin.tsx` — admin tools
- `src/pages/Arena.tsx` — human pairwise judging
- `src/pages/Leaderboards.tsx` — leaderboards
- `src/pages/System.tsx`, `Compare.tsx` — system detail/comparison
- `src/components.tsx` — shared UI/renderers
- `src/api.ts` — API client
- `src/styles.css` — existing visual system; preserve it unless redesign is requested

### Worker/backend
- `worker/index.ts` — routes
- `worker/scheduler.ts` — candidate generation, coverage, claims, recording
- `worker/importer.ts` — atomic import validation + inserts + matchup creation
- `worker/arena.ts` — Arena assignment/snapshots/voting
- `worker/ranking.ts`, `worker/statistics.ts` — scoring/leaderboards
- `worker/validation.ts` — Zod schemas
- `worker/auth.ts` — auth/admin enforcement
- `worker/sanitize.ts` — display blinding/sanitization
- `worker/db.ts` — DB helpers

### Database/tests
- `migrations/` — additive production migrations. Do not only edit old migrations for production changes.
- `tests/api.test.ts`
- `tests/ranking.test.ts`
- `tests/run-queue.test.ts`
- `tests/scheduler.test.ts`

## Existing invariants

### Run provenance
Responses store exact system/topic/task/prompt/raw output/display output/time/interface/reasoning/configuration/sample/context.
Raw output and prompt provenance are historical records; do not mutate them in place. Display text may be revised separately.

### Admin
Admin access is account-based (`users.is_admin`). Every `/api/admin` route must be protected server-side.

### Arena
Comparisons are blinded. Do not expose system/model/provider identity. Assignments snapshot what the judge saw so later edits do not rewrite history.

### Imports
Bulk imports are validated and atomic.

### Scheduler
Open run claims count as coverage and survive reload. Recommend executable work only. Concurrent tabs must not reserve the same slot/sample.

## Target benchmark architecture
Active tasks:
1. `government` — Government case generation
2. `opposition` — Opposition case generation
3. `rebuttal` — Opposition rebuttal against a fixed Government case, with access to that tested system's own Opposition case for cross-application

Retire the active `prediction -> rebuttal -> full_opposition` pipeline. Legacy rows may remain historical, but new scheduling/ranking/UI should focus on the three tasks above.

### Case generation
Government and Opposition case generation are nearly symmetric and receive only the motion. Opposition case generation does not receive Government definitions/case.

### Rebuttal
A rebuttal references:
- one fixed Government response on the same motion
- one Opposition response from the same tested system on the same motion

Every tested system should eventually rebut the same frozen Government source cases for a motion. Arena rebuttal comparisons must share the same Government source response.

The **rebuttal prompt text itself is intentionally deferred** and will be supplied later. Implement the data model, relationships, scheduling, prompt-template support, and placeholders needed for rebuttal, but do not invent or finalize a rebuttal prompt unless explicitly asked.

## Prompt system
Current seed files:
```text
prompts/government.txt
prompts/opposition.txt
```

Use these files as default seed content; runtime edits should create DB-backed prompt revisions.

Current case-generation placeholder:
- Government: `{MOTION}`
- Opposition: `{MOTION}`

The future rebuttal template should support motion + structured Government/Opposition case inputs, but its exact wording and placeholder format will be finalized later.

Validate required/unknown placeholders. When a run starts, snapshot the fully rendered prompt so later template edits cannot change in-progress or historical provenance. `NextRun` should show the rendered prompt and a one-click Copy prompt action.

## Structured case data
Benchmark models return readable Markdown/text, not JSON.

After Government/Opposition output is recorded:
1. preserve raw output
2. parse deterministic headings where possible
3. optionally use a separate extractor model (e.g. Gemini) if needed
4. validate strict JSON
5. store it as derived data

Extraction must not rewrite/improve debate content. Failure must not reject/delete the original run; allow retry/manual correction. API keys stay server-side, never in `VITE_*`.

Suggested schema:
```json
{
  "schema_version": 1,
  "motion_interpretation": "...",
  "contentions": [
    {
      "number": 1,
      "title": "...",
      "claim": "...",
      "warrants": ["..."],
      "impact": "...",
      "comparative": "...",
      "likely_response": "...",
      "defense": "..."
    }
  ],
  "round_priorities": "..."
}
```

For rebuttal input, centrally derive only:
- contention title
- claim
- warrants
- impact

Do not pass likely response, defense, round priorities, or model/provider identity. Keep this transformation in one helper.

## Frozen Government rebuttal pool
Government rebuttal sources are frozen, not resolved live from the leaderboard for every run.
Admins should be able to snapshot/freeze the current top Government systems/cases. Once frozen, source response IDs must not silently change. If a source is unavailable, show that instead of silently substituting another model.

## UI direction
Integrate into the existing Admin/Next Run flow. Useful admin surfaces:
- Next Run
- Prompts
- Rebuttal Pool
- existing manual/import/display/catalog/weights/admin tabs

Keep the existing restrained visual style. Do not create a parallel admin app or add a new UI framework.

## Implementation rules
- Centralize task/metric definitions.
- Centralize prompt rendering/placeholder validation.
- Centralize structured-case schemas.
- Centralize the core-case-for-rebuttal transformation.
- Preserve historical data where practical.
- Use additive D1 migrations.
- Update tests, seed/demo data, and README with behavior changes.
- Keep `Admin.tsx` and `NextRun.tsx` from becoming more monolithic; split focused helpers/components.
- Do not hardcode prompt text in multiple places.
- Do not let legacy prediction/full-opposition tasks leak into new active scheduling/rankings.
- Do not dynamically change the Government source case for an existing rebuttal run.
- Do not expose source-system identity to judges.

## Definition of done
Substantial work must be complete end-to-end through:
- D1 migration/schema
- shared domain/types
- backend validation/routes
- scheduler/importer/Arena/ranking as relevant
- frontend admin/public UI as relevant
- demo/seed data
- tests
- README/docs

Finish with:
```bash
npm run check
```
and fix failures before handoff.
