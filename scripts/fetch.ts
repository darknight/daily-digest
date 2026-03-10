/**
 * Step 1: Fetch unread articles from FreshRSS + fair scheduling + full-text extraction
 *
 * Incremental: appends new articles to existing data/articles/YYYY-MM-DD.json
 * Fair scheduling: group by feed, quota MAX_TOTAL/MIN_PER_FEED/MAX_PER_FEED
 * Full-text extraction: readability -> Lightpanda -> RSS fallback chain
 * Excess articles marked as read
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FreshRSSClient, getArticleLink } from "./lib/freshrss-client.ts";
import { extractFullText } from "./lib/extractor.ts";
import { withConcurrency } from "./lib/ai.ts";
import type { Article, DailyArticles, RawArticle } from "./lib/types.ts";

// ── Config ──────────────────────────────────────────────

const MAX_TOTAL = Number(process.env.MAX_TOTAL ?? 100);
const MIN_PER_FEED = Number(process.env.MIN_PER_FEED ?? 3);
const MAX_PER_FEED = Number(process.env.MAX_PER_FEED ?? 10);
const EXTRACT_CONCURRENCY = 5;

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ARTICLES_DIR = join(ROOT, "data/articles");

// ── Fair Scheduling ─────────────────────────────────────

function fairSchedule(
  articlesByFeed: Map<string, Article[]>,
): { selected: Article[]; skipped: Article[] } {
  const selected: Article[] = [];
  const skipped: Article[] = [];

  // Round 1: give each feed up to MIN_PER_FEED
  const feedEntries = [...articlesByFeed.entries()];
  for (const [, articles] of feedEntries) {
    const take = articles.slice(0, MIN_PER_FEED);
    const rest = articles.slice(MIN_PER_FEED);
    selected.push(...take);
    if (rest.length > 0) {
      articlesByFeed.set(articles[0].origin?.streamId ?? "", rest);
    }
  }

  // Round 2: distribute remaining quota fairly
  let remaining = MAX_TOTAL - selected.length;
  if (remaining > 0) {
    const remainingFeeds = feedEntries
      .map(([feedId, articles]) => ({
        feedId,
        articles: articles.slice(MIN_PER_FEED, MAX_PER_FEED),
      }))
      .filter((f) => f.articles.length > 0);

    // Sort by least articles first for fairness
    remainingFeeds.sort((a, b) => a.articles.length - b.articles.length);

    for (const feed of remainingFeeds) {
      if (remaining <= 0) break;
      const take = feed.articles.slice(0, remaining);
      selected.push(...take);
      remaining -= take.length;
    }
  }

  // Everything not selected gets skipped
  const selectedIds = new Set(selected.map((a) => a.id));
  for (const [, articles] of feedEntries) {
    for (const a of articles) {
      if (!selectedIds.has(a.id)) {
        skipped.push(a);
      }
    }
  }

  return { selected, skipped };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const outPath = join(ARTICLES_DIR, `${today}.json`);
  const isDryRun = process.argv.includes("--dry-run");

  // Load existing articles for incremental mode
  let existingArticles: RawArticle[] = [];
  let existingSkippedIds: string[] = [];
  if (existsSync(outPath) && !isDryRun) {
    const existing: DailyArticles = JSON.parse(readFileSync(outPath, "utf-8"));
    existingArticles = existing.articles;
    existingSkippedIds = existing.skippedIds;
    console.log(`Loaded ${existingArticles.length} existing articles, fetching incrementally`);
  }

  // Validate env
  const apiUrl = process.env.FRESHRSS_API_URL;
  const username = process.env.FRESHRSS_USERNAME;
  const password = process.env.FRESHRSS_PASSWORD;

  if (!apiUrl || !username || !password) {
    console.error("Error: FRESHRSS_API_URL, FRESHRSS_USERNAME, FRESHRSS_PASSWORD env vars are required");
    process.exit(1);
  }

  const client = new FreshRSSClient({ apiUrl, username, password });

  console.log("Authenticating with FreshRSS...");
  await client.authenticate();
  console.log("Authenticated\n");

  console.log("Fetching unread articles...");
  const allArticles = await client.getAllUnreadArticles();
  console.log(`Fetched ${allArticles.length} unread articles\n`);

  if (isDryRun) {
    console.log("--dry-run mode, showing stats only\n");
    if (allArticles.length === 0) {
      console.log("No unread articles");
      return;
    }
    const byFeed = new Map<string, Article[]>();
    for (const a of allArticles) {
      const feedId = a.origin?.streamId ?? "unknown";
      if (!byFeed.has(feedId)) byFeed.set(feedId, []);
      byFeed.get(feedId)!.push(a);
    }
    for (const [feedId, articles] of byFeed) {
      const feedTitle = articles[0]?.origin?.title ?? feedId;
      console.log(`  ${feedTitle}: ${articles.length} articles`);
    }
    return;
  }

  // Filter out already-processed articles (incremental mode)
  const knownIds = new Set([
    ...existingArticles.map((a) => a.id),
    ...existingSkippedIds,
  ]);
  const newUnreadArticles = allArticles.filter((a) => !knownIds.has(a.id));
  console.log(`New articles after filtering known IDs: ${newUnreadArticles.length}`);

  if (newUnreadArticles.length === 0) {
    console.log("No new unread articles, skipping");
    return;
  }

  // Group by feed
  const byFeed = new Map<string, Article[]>();
  for (const a of newUnreadArticles) {
    const feedId = a.origin?.streamId ?? "unknown";
    if (!byFeed.has(feedId)) byFeed.set(feedId, []);
    byFeed.get(feedId)!.push(a);
  }

  console.log(`${byFeed.size} feeds, quota MAX_TOTAL=${MAX_TOTAL}, MIN=${MIN_PER_FEED}, MAX=${MAX_PER_FEED}`);

  // Fair schedule
  const { selected, skipped } = fairSchedule(byFeed);
  console.log(`Selected ${selected.length}, skipped ${skipped.length}\n`);

  // Full text extraction with concurrency
  console.log(`Extracting full text (concurrency ${EXTRACT_CONCURRENCY})...`);
  const rawArticles = await withConcurrency(
    selected,
    EXTRACT_CONCURRENCY,
    async (article, idx) => {
      const link = getArticleLink(article);
      const { content, source } = await extractFullText(
        link,
        article.summary?.content,
      );

      console.log(
        `  [${idx + 1}/${selected.length}] ${source.padEnd(12)} ${article.title.slice(0, 60)}`,
      );

      const raw: RawArticle = {
        id: article.id,
        title: article.title,
        link,
        published: article.published,
        feedId: article.origin?.streamId ?? "",
        feedTitle: article.origin?.title ?? "",
        summary: content,
        contentSource: source,
      };
      return raw;
    },
  );

  // Save (merge with existing articles in incremental mode)
  mkdirSync(ARTICLES_DIR, { recursive: true });
  const mergedArticles = [...existingArticles, ...rawArticles];
  const mergedSkippedIds = [...existingSkippedIds, ...skipped.map((a) => a.id)];
  const result: DailyArticles = {
    date: today,
    fetchedAt: new Date().toISOString(),
    articles: mergedArticles,
    skippedIds: mergedSkippedIds,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved ${mergedArticles.length} articles (${existingArticles.length} existing + ${rawArticles.length} new) to ${outPath}`);

  // Mark skipped articles as read
  if (skipped.length > 0 && !process.env.NO_MARK_READ) {
    console.log(`\nMarking ${skipped.length} excess articles as read...`);
    await client.markAsRead(skipped.map((a) => a.id));
    console.log("Done");
  } else if (skipped.length > 0) {
    console.log(`\nSkipped marking as read (NO_MARK_READ=1)`);
  }

  // Stats
  const sources = { readability: 0, lightpanda: 0, rss: 0 };
  for (const a of rawArticles) sources[a.contentSource]++;
  console.log(`\nExtraction stats: readability=${sources.readability}, lightpanda=${sources.lightpanda}, rss=${sources.rss}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
