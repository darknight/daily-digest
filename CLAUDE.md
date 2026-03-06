# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

- All code comments, variable names, commit messages, and documentation must be in **English**.
- User-facing HTML content (UI labels, empty states, headings) stays in **Chinese**.
- Conversation with the user may be in Chinese.

## Commands

```bash
pnpm run fetch          # Step 1: pull unread articles from FreshRSS + full-text extraction
pnpm run summarize      # Step 2: batch AI summarization + mark as read
pnpm run render         # Step 3: generate static HTML pages
pnpm run update         # Run all 3 steps sequentially
pnpm run cf:preview     # Local preview via wrangler

# Testing
pnpm run fetch -- --dry-run   # Test FreshRSS connectivity without saving
NO_MARK_READ=1 pnpm run fetch # Skip marking articles as read (for repeated testing)
```

All scripts use `tsx --env-file=.env`, so a `.env` file is required for local runs. CI injects env vars via GitHub Secrets.

## Architecture

Three-stage TypeScript data pipeline, no framework:

```
fetch.ts → data/articles/YYYY-MM-DD.json
summarize.ts → data/summaries/YYYY-MM-DD.json
render.ts → dist/ (index.html, archive.html, daily/*.html)
```

### Key modules in `scripts/lib/`

- **`freshrss-client.ts`** — GReader API client (translated from Python `freshrss` skill). Auth via ClientLogin, pagination via continuation tokens.
- **`extractor.ts`** — Full-text extraction with 3-layer fallback: `@mozilla/readability` → Lightpanda headless browser → RSS summary strip.
- **`ai.ts`** — `resolveModel("provider:model")` factory supporting zhipu/openai/anthropic/google via Vercel AI SDK. Also exports `withConcurrency()` for parallel batch processing.
- **`types.ts`** — Shared interfaces: `RawArticle`, `DailyArticles`, `ArticleSummary`, `DailySummaries`.

### Design patterns

- **Idempotent**: `fetch.ts` skips if today's articles JSON exists; `summarize.ts` skips already-summarized articles (incremental).
- **Fair scheduling**: Articles grouped by feed, quota applied (MAX_TOTAL=100, MIN_PER_FEED=3, MAX_PER_FEED=10) to prevent high-volume feeds from dominating.
- **Failure recovery**: `summarize.ts` marks articles as read only after all summaries succeed. Failed batches can be recovered by re-running (incremental).
- **`NO_MARK_READ=1`**: Environment flag to disable marking articles as read in both `fetch.ts` and `summarize.ts`.

## AI Model

Default: `zhipu:glm-4.7-flash` (free tier). Format: `provider:model`. Set via `AI_MODEL` env var. Each provider requires its corresponding API key env var (e.g., `ZHIPU_API_KEY`).

## Git Rebase Conflict Resolution

**CRITICAL**: During `git rebase`, `--ours` and `--theirs` are SWAPPED compared to `git merge`:
- `git rebase`: `--ours` = the branch being rebased **onto** (upstream/remote), `--theirs` = your local commits
- `git merge`: `--ours` = your current branch, `--theirs` = the branch being merged in

When resolving conflicts during `git rebase`, use `git checkout --theirs <file>` to keep your local changes.

## Deployment

Cloudflare Pages via `wrangler`. Two GitHub Actions workflows:
- `daily-digest.yml` — cron UTC 00:00 (Beijing 08:00): fetch → summarize → render → commit data/ → deploy
- `deploy.yml` — push to main: render → deploy
