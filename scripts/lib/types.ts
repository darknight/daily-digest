// ── FreshRSS GReader API Types ──────────────────────────

export interface Category {
  id: string;
  label: string;
}

export interface Subscription {
  id: string;
  title: string;
  url: string;
  htmlUrl: string;
  iconUrl?: string;
  categories: Category[];
}

export interface ArticleOrigin {
  streamId: string;
  title: string;
  htmlUrl: string;
}

export interface ArticleSummaryContent {
  content: string;
}

export interface Article {
  id: string;
  title: string;
  published: number; // Unix timestamp
  updated?: number;
  canonical?: { href: string }[];
  alternate?: { href: string }[];
  summary?: ArticleSummaryContent;
  origin?: ArticleOrigin;
}

export interface StreamContents {
  id: string;
  title?: string;
  updated?: number;
  items: Article[];
  continuation?: string;
}

export interface UnreadCount {
  id: string;
  count: number;
  newestItemTimestampUsec: string;
}

// ── Data Pipeline Types ─────────────────────────────────

export interface RawArticle {
  id: string;
  title: string;
  link: string | null;
  published: number;
  feedId: string;
  feedTitle: string;
  summary: string; // RSS summary or full text
  contentSource: "readability" | "browser-rendering" | "rss";
}

export interface DailyArticles {
  date: string; // YYYY-MM-DD
  fetchedAt: string; // ISO timestamp
  articles: RawArticle[];
  skippedIds: string[]; // article IDs marked read due to quota overflow
}

export interface ArticleSummary {
  id: string;
  title: string;
  link: string | null;
  feedTitle: string;
  published: number;
  summary: string; // AI-generated Chinese summary
  tags: string[];
}

export interface DailySummaries {
  date: string;
  summarizedAt: string;
  model: string;
  summaries: ArticleSummary[];
}
