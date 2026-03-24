/**
 * Step 3: Generate static HTML pages
 *
 * Scan all data/summaries/*.json
 * Generate daily pages + archive page + index page
 * Full regeneration of all pages and navigation links
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJSON, listKeys } from "./lib/r2.ts";
import type { ArticleSummary, DailySummaries, PipelineStats } from "./lib/types.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST_DIR = join(ROOT, "dist");
const DAILY_DIR = join(DIST_DIR, "daily");

// ── CSS ─────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #ffffff;
  --card-bg: #f9f9f9;
  --text: #333333;
  --text-secondary: #666666;
  --border: #e0e0e0;
  --link: #1a73e8;
  --tag-bg: #e8f0fe;
  --tag-text: #1967d2;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a1a;
    --card-bg: #2d2d2d;
    --text: #e0e0e0;
    --text-secondary: #999999;
    --border: #404040;
    --link: #8ab4f8;
    --tag-bg: #303a4a;
    --tag-text: #8ab4f8;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  padding: 20px;
}

.container { max-width: 800px; margin: 0 auto; }

h1 { font-size: 1.5em; margin-bottom: 4px; }

.subtitle {
  color: var(--text-secondary);
  font-size: 0.9em;
  margin-bottom: 24px;
}

.subtitle a {
  color: var(--text-secondary);
  text-decoration: none;
  margin-left: 12px;
}

.subtitle a:hover { text-decoration: underline; }

.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 12px;
}

.card h2 { font-size: 1.05em; margin-bottom: 6px; }

.card h2 a { color: var(--link); text-decoration: none; }

.card h2 a:hover { text-decoration: underline; }

.meta {
  font-size: 0.8em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.tag {
  display: inline-block;
  background: var(--tag-bg);
  color: var(--tag-text);
  font-size: 0.75em;
  padding: 2px 8px;
  border-radius: 4px;
  margin-right: 6px;
}

.summary { font-size: 0.92em; color: var(--text); }

.pagination {
  display: flex;
  justify-content: space-between;
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.pagination a {
  color: var(--link);
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

.archive-list a:hover { color: var(--link); }

.archive-count {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 3rem 0;
}

.pipeline-stats {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.75em;
  color: var(--text-secondary);
  text-align: center;
}

@media (max-width: 600px) {
  body { padding: 12px; }
  h1 { font-size: 1.25em; }
  .card { padding: 12px 16px; }
}
`;

// ── Templates ───────────────────────────────────────────

function htmlLayout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="container">
${body}
</div>
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

function formatSummary(text: string): string {
  // Escape HTML first, then convert newline+bullet patterns to <br> for readability
  let safe = escapeHtml(text);
  // Convert lines starting with • or - into <br>• formatted bullets
  safe = safe.replace(/\n[•\-]\s*/g, "\n    <br>• ");
  // Convert remaining newlines to <br>
  safe = safe.replace(/\n/g, "<br>");
  return safe;
}

function renderArticleCard(article: ArticleSummary): string {
  const titleHtml = article.link
    ? `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener">${escapeHtml(article.title)}</a>`
    : escapeHtml(article.title);

  return `<div class="card">
  <h2>${titleHtml}</h2>
  <div class="meta"><span class="tag">${escapeHtml(article.feedTitle)}</span> ${formatDate(article.published)}</div>
  <div class="summary">${formatSummary(article.summary)}</div>
</div>`;
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

  const header = `<h1>RSS 每日摘要</h1>\n<p class="subtitle">${daily.date} · ${daily.summaries.length} 篇文章 <a href="/archive.html">归档</a></p>`;

  const statsHtml = renderPipelineStats(daily.stats);

  const body = daily.summaries.length > 0
    ? `${header}\n${cards}\n${pagination}\n${statsHtml}`
    : `${header}\n<div class="empty">当天没有文章</div>\n${statsHtml}`;

  return htmlLayout(`RSS 摘要 - ${daily.date}`, body);
}

function renderPipelineStats(stats?: PipelineStats): string {
  if (!stats) return "";

  const sources = Object.entries(stats.extractionSources)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");

  const parts = [
    `未读 ${stats.totalUnread}`,
    `抓取 ${stats.fetched}`,
    `摘要 ${stats.summarized}`,
  ];
  if (stats.failed > 0) parts.push(`失败 ${stats.failed}`);
  if (stats.skipped > 0) parts.push(`跳过 ${stats.skipped}`);

  return `<div class="pipeline-stats">${parts.join(" → ")} · 提取: ${sources}</div>`;
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

  const header = `<h1>RSS 每日摘要</h1>\n<p class="subtitle">历史归档</p>`;
  const body = dailies.length > 0
    ? `${header}\n<ul class="archive-list">\n${items}\n</ul>`
    : `${header}\n<div class="empty">暂无日报</div>`;

  return htmlLayout("RSS 摘要 - 归档", body);
}

function renderIndexPage(latest: DailySummaries | null): string {
  if (!latest || latest.summaries.length === 0) {
    return htmlLayout("RSS 每日摘要", `<h1>RSS 每日摘要</h1>\n<p class="subtitle">暂无日报，请稍后再来</p>`);
  }

  const cards = latest.summaries.map(renderArticleCard).join("\n");
  const header = `<h1>RSS 每日摘要</h1>\n<p class="subtitle">${latest.date} · ${latest.summaries.length} 篇文章 <a href="/archive.html">归档</a></p>`;
  return htmlLayout("RSS 每日摘要", `${header}\n${cards}`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const keys = await listKeys("summaries/");
  const jsonKeys = keys.filter((k) => k.endsWith(".json"));

  if (jsonKeys.length === 0) {
    console.log("No summaries found in R2, generating empty pages");
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(join(DIST_DIR, "index.html"), renderIndexPage(null));
    writeFileSync(join(DIST_DIR, "archive.html"), renderArchivePage([]));
    return;
  }

  const dailies: DailySummaries[] = [];
  for (const key of jsonKeys) {
    const data = await readJSON<DailySummaries>(key);
    if (data) dailies.push(data);
  }

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
