import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

type ContentSource = "readability" | "browser-rendering" | "rss";

export interface ExtractionResult {
  content: string;
  source: ContentSource;
}

const FETCH_TIMEOUT = 15_000;
const BROWSER_RENDERING_TIMEOUT = 30_000;

// Patterns that indicate bot-blocking / challenge pages rather than real content
const BLOCK_PAGE_PATTERNS = [
  /browser not supported.*security verification/is,
  /enable javascript and cookies to continue/i,
  /just a moment.*cloudflare/is,
  /attention required.*cloudflare/is,
  /checking your browser before accessing/i,
];

function isBlockPage(text: string): boolean {
  return BLOCK_PAGE_PATTERNS.some((p) => p.test(text));
}

// ── L1: @mozilla/readability ────────────────────────────

async function extractWithReadability(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; DailyDigestBot/1.0; +https://github.com/daily-digest)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.textContent || article.textContent.trim().length < 100) {
      return null;
    }

    const text = article.textContent.trim();
    if (isBlockPage(text)) return null;

    return text;
  } catch (err) {
    console.warn(`[readability] ${url}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── L2: Cloudflare Browser Rendering (markdown endpoint) ─

async function extractWithBrowserRendering(url: string): Promise<string | null> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSER_RENDERING_TIMEOUT);

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          gotoOptions: { waitUntil: "networkidle0" },
        }),
      },
    );
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[browser-rendering] ${url}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as { success?: boolean; result?: string };
    if (!data.success || !data.result) return null;

    const text = data.result.trim();
    if (text.length < 100 || isBlockPage(text)) return null;
    return text;
  } catch (err) {
    console.warn(`[browser-rendering] ${url}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── L3: RSS summary fallback ────────────────────────────

function extractFromRSS(summary: string | undefined): string {
  if (!summary) return "";

  // Strip HTML tags from RSS summary
  const dom = new JSDOM(`<body>${summary}</body>`);
  const text = dom.window.document.body.textContent ?? "";
  return text.trim();
}

// ── Public API ──────────────────────────────────────────

export async function extractFullText(
  url: string | null,
  rssSummary: string | undefined,
): Promise<ExtractionResult> {
  // L1: readability
  if (url) {
    const content = await extractWithReadability(url);
    if (content) {
      return { content, source: "readability" };
    }

    // L2: Cloudflare Browser Rendering
    const brContent = await extractWithBrowserRendering(url);
    if (brContent) {
      return { content: brContent, source: "browser-rendering" };
    }
  }

  // L3: RSS summary
  const rssText = extractFromRSS(rssSummary);
  return { content: rssText, source: "rss" };
}
