/**
 * Step 3: Generate static HTML pages
 *
 * Scan all data/summaries/*.json
 * Generate daily pages + archive page + index page
 * Full regeneration of all pages and navigation links
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArticleSummary, DailySummaries } from "./lib/types.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SUMMARIES_DIR = join(ROOT, "data/summaries");
const DIST_DIR = join(ROOT, "dist");
const DAILY_DIR = join(DIST_DIR, "daily");

// ── CSS ─────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #ffffff;
  --bg-card: #f9fafb;
  --text: #1a1a2e;
  --text-secondary: #6b7280;
  --border: #e5e7eb;
  --accent: #3b82f6;
  --tag-bg: #eff6ff;
  --tag-text: #1d4ed8;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --bg-card: #1e293b;
    --text: #e2e8f0;
    --text-secondary: #94a3b8;
    --border: #334155;
    --accent: #60a5fa;
    --tag-bg: #1e3a5f;
    --tag-text: #93c5fd;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  max-width: 800px;
  margin: 0 auto;
  padding: 1rem;
}

nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2rem;
}

nav a {
  color: var(--accent);
  text-decoration: none;
}

nav a:hover { text-decoration: underline; }

h1 { font-size: 1.5rem; }
h2 { font-size: 1.25rem; margin-bottom: 1rem; }

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}

.card-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.card-title a {
  color: var(--text);
  text-decoration: none;
}

.card-title a:hover {
  color: var(--accent);
  text-decoration: underline;
}

.card-meta {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.card-summary {
  font-size: 0.95rem;
  margin-bottom: 0.5rem;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.tag {
  font-size: 0.75rem;
  background: var(--tag-bg);
  color: var(--tag-text);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.pagination {
  display: flex;
  justify-content: space-between;
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.pagination a {
  color: var(--accent);
  text-decoration: none;
}

.pagination a:hover { text-decoration: underline; }

.archive-list {
  list-style: none;
}

.archive-list li {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border);
}

.archive-list a {
  color: var(--text);
  text-decoration: none;
  display: flex;
  justify-content: space-between;
}

.archive-list a:hover { color: var(--accent); }

.archive-count {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 3rem 0;
}

@media (max-width: 600px) {
  body { padding: 0.75rem; }
  h1 { font-size: 1.25rem; }
  .card { padding: 1rem; }
}
`;

// ── Templates ───────────────────────────────────────────

function htmlLayout(title: string, body: string, navExtra = ""): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${CSS}</style>
</head>
<body>
  <nav>
    <h1><a href="/">Daily Digest</a></h1>
    <div>${navExtra}<a href="/archive.html">归档</a></div>
  </nav>
  ${body}
</body>
</html>`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function renderArticleCard(article: ArticleSummary): string {
  const titleHtml = article.link
    ? `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener">${escapeHtml(article.title)}</a>`
    : escapeHtml(article.title);

  const tags = article.tags
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");

  return `<article class="card">
  <div class="card-title">${titleHtml}</div>
  <div class="card-meta">${escapeHtml(article.feedTitle)} · ${formatDate(article.published)}</div>
  <div class="card-summary">${escapeHtml(article.summary)}</div>
  <div class="tags">${tags}</div>
</article>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Page Generation ─────────────────────────────────────

function renderDailyPage(
  daily: DailySummaries,
  prevDate: string | null,
  nextDate: string | null,
): string {
  const cards = daily.summaries.map(renderArticleCard).join("\n");

  let pagination = '<div class="pagination">';
  pagination += prevDate
    ? `<a href="/daily/${prevDate}.html">&larr; ${prevDate}</a>`
    : "<span></span>";
  pagination += nextDate
    ? `<a href="/daily/${nextDate}.html">${nextDate} &rarr;</a>`
    : "<span></span>";
  pagination += "</div>";

  const body = daily.summaries.length > 0
    ? `<h2>${daily.date} · ${daily.summaries.length} 篇</h2>\n${cards}\n${pagination}`
    : `<div class="empty">当天没有文章</div>`;

  return htmlLayout(`Daily Digest - ${daily.date}`, body);
}

function renderArchivePage(
  dailies: { date: string; count: number }[],
): string {
  const items = dailies
    .map(
      (d) =>
        `<li><a href="/daily/${d.date}.html"><span>${d.date}</span><span class="archive-count">${d.count} 篇</span></a></li>`,
    )
    .join("\n");

  const body = dailies.length > 0
    ? `<h2>历史归档</h2>\n<ul class="archive-list">\n${items}\n</ul>`
    : `<div class="empty">暂无日报</div>`;

  return htmlLayout("Daily Digest - 归档", body);
}

function renderIndexPage(latest: DailySummaries | null): string {
  if (!latest || latest.summaries.length === 0) {
    return htmlLayout("Daily Digest", '<div class="empty">暂无日报，请稍后再来</div>');
  }

  const cards = latest.summaries.map(renderArticleCard).join("\n");
  const body = `<h2>最新日报 · ${latest.date} · ${latest.summaries.length} 篇</h2>\n${cards}`;
  return htmlLayout("Daily Digest", body);
}

// ── Main ────────────────────────────────────────────────

function main() {
  if (!existsSync(SUMMARIES_DIR)) {
    console.log("Summaries directory not found, generating empty pages");
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(join(DIST_DIR, "index.html"), renderIndexPage(null));
    writeFileSync(join(DIST_DIR, "archive.html"), renderArchivePage([]));
    return;
  }

  const files = readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort(); // chronological

  const dailies: DailySummaries[] = files.map((f) =>
    JSON.parse(readFileSync(join(SUMMARIES_DIR, f), "utf-8")),
  );

  console.log(`Found summary data for ${dailies.length} days\n`);

  // Ensure output dirs
  mkdirSync(DAILY_DIR, { recursive: true });

  // Generate daily pages
  for (let i = 0; i < dailies.length; i++) {
    const daily = dailies[i];
    const prevDate = i > 0 ? dailies[i - 1].date : null;
    const nextDate = i < dailies.length - 1 ? dailies[i + 1].date : null;

    const html = renderDailyPage(daily, prevDate, nextDate);
    const outPath = join(DAILY_DIR, `${daily.date}.html`);
    writeFileSync(outPath, html);
    console.log(`  Generated ${outPath} (${daily.summaries.length} articles)`);
  }

  // Generate archive page (newest first)
  const archiveData = dailies
    .map((d) => ({ date: d.date, count: d.summaries.length }))
    .reverse();
  writeFileSync(join(DIST_DIR, "archive.html"), renderArchivePage(archiveData));
  console.log(`  Generated archive.html`);

  // Generate index page (embed latest)
  const latest = dailies.length > 0 ? dailies[dailies.length - 1] : null;
  writeFileSync(join(DIST_DIR, "index.html"), renderIndexPage(latest));
  console.log(`  Generated index.html\n`);

  console.log("Render complete!");
}

main();
