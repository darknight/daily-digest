import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

type ContentSource = "readability" | "lightpanda" | "rss";

export interface ExtractionResult {
  content: string;
  source: ContentSource;
}

const FETCH_TIMEOUT = 15_000;

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

    return article.textContent.trim();
  } catch {
    return null;
  }
}

// ── L2: Lightpanda (headless browser) ───────────────────

async function extractWithLightpanda(url: string): Promise<string | null> {
  const wsUrl = process.env.LIGHTPANDA_URL;
  if (!wsUrl) return null;

  try {
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.connect({
      browserWSEndpoint: wsUrl,
    });

    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: FETCH_TIMEOUT });
      const html = await page.content();
      await page.close();

      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article?.textContent || article.textContent.trim().length < 100) {
        return null;
      }

      return article.textContent.trim();
    } finally {
      browser.disconnect();
    }
  } catch {
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

    // L2: Lightpanda
    const lpContent = await extractWithLightpanda(url);
    if (lpContent) {
      return { content: lpContent, source: "lightpanda" };
    }
  }

  // L3: RSS summary
  const rssText = extractFromRSS(rssSummary);
  return { content: rssText, source: "rss" };
}
