/**
 * Step 2: AI batch summarization + mark as read
 *
 * Incremental processing: skip articles already summarized in existing summaries
 * Batch AI summarization: 5-10 articles per batch, 3 concurrent batches
 * After completion, mark all fetched articles as read
 */

import { generateText } from "ai";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveModel, getModelSpec, withConcurrency, sleep } from "./lib/ai.ts";
import { FreshRSSClient } from "./lib/freshrss-client.ts";
import type { DailyArticles, DailySummaries, ArticleSummary, RawArticle } from "./lib/types.ts";

// ── Config ──────────────────────────────────────────────

const BATCH_SIZE = 8;
const MAX_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MIN_CONTENT_LENGTH = 50;

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ARTICLES_DIR = join(ROOT, "data/articles");
const SUMMARIES_DIR = join(ROOT, "data/summaries");

// ── Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional tech article summarization assistant. Your task is to generate concise Chinese summaries and tags for tech RSS articles.

## Output Format

You must return a strict JSON array (do not include markdown code block markers), with each element corresponding to one article:
[
  {
    "id": "article ID",
    "summary": "100-200 character Chinese summary",
    "tags": ["tag1", "tag2", "tag3"]
  }
]

## Requirements

- Summaries should be 100-200 Chinese characters, covering the core content and key insights of the article
- 3-5 tags, using Chinese or common technical terms (e.g., React, Rust, AI)
- If the article content is insufficient or incomprehensible, write the summary as "内容不足，无法生成摘要"
- Stay objective, do not add personal opinions`;

function buildBatchPrompt(articles: RawArticle[]): string {
  const blocks = articles
    .map(
      (a, i) =>
        `[ARTICLE ${i + 1}]\nID: ${a.id}\nTitle: ${a.title}\nSource: ${a.feedTitle}\nContent:\n${a.summary.slice(0, 3000)}`,
    )
    .join("\n\n");

  return `Generate Chinese summaries and tags for each of the following ${articles.length} articles. Return a JSON array, in the same order as the articles.

${blocks}`;
}

// ── Batch AI Call ───────────────────────────────────────

async function callBatchWithRetry(
  articles: RawArticle[],
): Promise<{ id: string; summary: string; tags: string[] }[]> {
  const model = resolveModel();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { text } = await generateText({
        model,
        maxOutputTokens: 8192,
        system: SYSTEM_PROMPT,
        prompt: buildBatchPrompt(articles),
      });

      const cleaned = text
        .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
        .replace(/\s*```[\s\S]*$/, "")
        .trim() || text.trim();

      let parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [parsed];

      if (parsed.length !== articles.length) {
        throw new SyntaxError(
          `Expected ${articles.length} results, got ${parsed.length}`,
        );
      }

      return parsed;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const isRetryable =
        lastError.message.includes("rate_limit") ||
        lastError.message.includes("overloaded") ||
        lastError.message.includes("429") ||
        lastError.message.includes("529") ||
        lastError.message.includes("500") ||
        lastError.message.includes("503");

      if ((isRetryable || lastError instanceof SyntaxError) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`  ⏳ Retrying (${attempt + 1}/${MAX_RETRIES}), waiting ${Math.round(delay)}ms...`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw lastError ?? new Error("Unknown error");
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const articlesPath = join(ARTICLES_DIR, `${today}.json`);
  const summariesPath = join(SUMMARIES_DIR, `${today}.json`);

  if (!existsSync(articlesPath)) {
    console.error(`Articles file not found: ${articlesPath}`);
    console.error("Please run pnpm run fetch first");
    process.exit(1);
  }

  const dailyArticles: DailyArticles = JSON.parse(readFileSync(articlesPath, "utf-8"));
  console.log(`Loaded ${dailyArticles.articles.length} articles (${today})\n`);

  // Load existing summaries for incremental processing
  const existingSummaryIds = new Set<string>();
  let existingSummaries: ArticleSummary[] = [];

  if (existsSync(summariesPath)) {
    const existing: DailySummaries = JSON.parse(readFileSync(summariesPath, "utf-8"));
    existingSummaries = existing.summaries;
    for (const s of existing.summaries) {
      existingSummaryIds.add(s.id);
    }
    console.log(`Found ${existingSummaryIds.size} existing summaries, processing incrementally\n`);
  }

  // Filter articles needing summarization
  const toSummarize = dailyArticles.articles.filter(
    (a) => !existingSummaryIds.has(a.id) && a.summary.length >= MIN_CONTENT_LENGTH,
  );

  const tooShort = dailyArticles.articles.filter(
    (a) => !existingSummaryIds.has(a.id) && a.summary.length < MIN_CONTENT_LENGTH,
  );

  if (tooShort.length > 0) {
    console.log(`Skipping ${tooShort.length} articles with content shorter than ${MIN_CONTENT_LENGTH} characters`);
  }

  if (toSummarize.length === 0) {
    console.log("No new articles to summarize");
  } else {
    const modelSpec = getModelSpec();
    console.log(`Using model: ${modelSpec}`);
    console.log(`To summarize: ${toSummarize.length} articles, ${BATCH_SIZE} per batch, concurrency ${MAX_CONCURRENCY}\n`);

    // Batch articles
    const batches: RawArticle[][] = [];
    for (let i = 0; i < toSummarize.length; i += BATCH_SIZE) {
      batches.push(toSummarize.slice(i, i + BATCH_SIZE));
    }

    const newSummaries: ArticleSummary[] = [];
    let processedBatches = 0;

    await withConcurrency(batches, MAX_CONCURRENCY, async (batch, _idx) => {
      try {
        const results = await callBatchWithRetry(batch);

        for (let i = 0; i < batch.length; i++) {
          const article = batch[i];
          const result = results[i];

          newSummaries.push({
            id: article.id,
            title: article.title,
            link: article.link,
            feedTitle: article.feedTitle,
            published: article.published,
            summary: result.summary,
            tags: result.tags,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Batch failed (${batch.length} articles): ${msg}`);
      }

      processedBatches++;
      console.log(
        `  Progress: ${processedBatches}/${batches.length} batches`,
      );
    });

    existingSummaries.push(...newSummaries);
    console.log(`\nAdded ${newSummaries.length} new summaries`);
  }

  // Save summaries
  mkdirSync(SUMMARIES_DIR, { recursive: true });
  const result: DailySummaries = {
    date: today,
    summarizedAt: new Date().toISOString(),
    model: getModelSpec(),
    summaries: existingSummaries,
  };
  writeFileSync(summariesPath, JSON.stringify(result, null, 2));
  console.log(`Saved to ${summariesPath}`);

  // Mark all fetched articles as read
  const apiUrl = process.env.FRESHRSS_API_URL;
  const username = process.env.FRESHRSS_USERNAME;
  const password = process.env.FRESHRSS_PASSWORD;

  if (apiUrl && username && password && !process.env.NO_MARK_READ) {
    const allArticleIds = dailyArticles.articles.map((a) => a.id);
    if (allArticleIds.length > 0) {
      console.log(`\nMarking ${allArticleIds.length} articles as read...`);
      const client = new FreshRSSClient({ apiUrl, username, password });
      await client.authenticate();
      await client.markAsRead(allArticleIds);
      console.log("Done");
    }
  } else if (process.env.NO_MARK_READ) {
    console.log("\nSkipping mark-as-read (NO_MARK_READ=1)");
  } else {
    console.log("\nFreshRSS credentials not configured, skipping mark-as-read");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
