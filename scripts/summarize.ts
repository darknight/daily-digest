/**
 * Step 2: AI batch summarization + mark as read
 *
 * Incremental processing: skip articles already summarized in existing summaries
 * Batch AI summarization: 5-10 articles per batch, 3 concurrent batches
 * After completion, mark all fetched articles as read
 */

import { generateText } from "ai";
import { resolveModel, getModelSpec, withConcurrency, sleep } from "./lib/ai.ts";
import { readJSON, writeJSON } from "./lib/r2.ts";
import { FreshRSSClient } from "./lib/freshrss-client.ts";
import type { DailyArticles, DailySummaries, ArticleSummary, RawArticle, PipelineStats } from "./lib/types.ts";

// ── Config ──────────────────────────────────────────────

const BATCH_SIZE = 5;
const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MIN_CONTENT_LENGTH = 50;

const articlesKey = (date: string) => `articles/${date}.json`;
const summariesKey = (date: string) => `summaries/${date}.json`;

// ── Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一位资深科技编辑，为忙碌的技术从业者撰写每日资讯摘要。

## 输出格式

返回严格的 JSON 数组（不要 markdown 代码块），每个元素：
[
  {
    "id": "文章 ID",
    "summary": "80-150字中文摘要",
    "tags": ["标签1", "标签2", "标签3"]
  }
]

## 摘要风格

- 直接切入核心信息，第一句话就传递最关键的内容
- 好的写法：「Rust 1.85 引入异步闭包语法，解决了长期困扰开发者的生命周期标注问题。新语法允许……」
- 禁止使用以下开头模式：「作者xxx」「这篇文章xxx」「介绍xxx」「本文xxx」「文章探讨了xxx」
- 用具体数据、名称、技术细节替代笼统描述
- 保持信息密度，避免空洞评价（如「值得关注」「意义重大」）

## 标签

- 3-5 个标签，优先使用具体技术名词（如 Rust, WebAssembly, GPT-5）
- 避免过于宽泛的标签（如「技术」「互联网」）

## 兜底

如果正文不足以理解文章，基于标题写一句简短的事实性描述即可。`;

function buildBatchPrompt(articles: RawArticle[]): string {
  const blocks = articles
    .map(
      (a, i) =>
        `[ARTICLE ${i + 1}]\nID: ${a.id}\nTitle: ${a.title}\nSource: ${a.feedTitle}\nContent:\n${a.summary.slice(0, 3000)}`,
    )
    .join("\n\n");

  return `请为以下 ${articles.length} 篇文章分别生成中文摘要和标签。返回一个 JSON 数组，按文章顺序一一对应。

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

  const dailyArticles = await readJSON<DailyArticles>(articlesKey(today));
  if (!dailyArticles) {
    console.error(`Articles not found in R2: ${articlesKey(today)}`);
    console.error("Please run pnpm run fetch first");
    process.exit(1);
  }
  console.log(`Loaded ${dailyArticles.articles.length} articles (${today})\n`);

  // Load existing summaries for incremental processing
  const existingSummaryIds = new Set<string>();
  let existingSummaries: ArticleSummary[] = [];

  const existingData = await readJSON<DailySummaries>(summariesKey(today));
  if (existingData) {
    existingSummaries = existingData.summaries;
    for (const s of existingData.summaries) {
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

  // Compute pipeline stats
  const extractionSources: Record<string, number> = {};
  for (const a of dailyArticles.articles) {
    extractionSources[a.contentSource] = (extractionSources[a.contentSource] ?? 0) + 1;
  }
  const stats: PipelineStats = {
    totalUnread: dailyArticles.totalUnread ?? dailyArticles.articles.length,
    fetched: dailyArticles.articles.length,
    skipped: dailyArticles.skippedIds.length,
    summarized: existingSummaries.length,
    failed: dailyArticles.articles.length - existingSummaries.length,
    extractionSources,
  };

  // Save summaries to R2
  const result: DailySummaries = {
    date: today,
    summarizedAt: new Date().toISOString(),
    model: getModelSpec(),
    summaries: existingSummaries,
    stats,
  };
  await writeJSON(summariesKey(today), result);
  console.log(`Saved to R2:${summariesKey(today)}`);

  // Mark all fetched articles as read
  const apiUrl = process.env.FRESHRSS_API_URL;
  const username = process.env.FRESHRSS_USERNAME;
  const password = process.env.FRESHRSS_PASSWORD;

  if (apiUrl && username && password && !process.env.NO_MARK_READ) {
    // Only mark articles that were successfully summarized as read
    const summarizedIds = new Set(existingSummaries.map((s) => s.id));
    const idsToMark = dailyArticles.articles
      .filter((a) => summarizedIds.has(a.id))
      .map((a) => a.id);
    const unsummarized = dailyArticles.articles.length - idsToMark.length;
    if (unsummarized > 0) {
      console.log(`\n${unsummarized} articles not summarized, keeping them unread for retry`);
    }
    if (idsToMark.length > 0) {
      console.log(`Marking ${idsToMark.length} summarized articles as read...`);
      const client = new FreshRSSClient({ apiUrl, username, password });
      await client.authenticate();
      await client.markAsRead(idsToMark);
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
