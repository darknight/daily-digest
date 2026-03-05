import type { Article, StreamContents, Subscription, UnreadCount } from "./types.ts";

// ── GReader API state tags ──────────────────────────────

const STATE_READ = "user/-/state/com.google/read";
const STATE_READING_LIST = "user/-/state/com.google/reading-list";

// ── Client ──────────────────────────────────────────────

export class FreshRSSClient {
  private apiUrl: string;
  private username: string;
  private password: string;
  private authToken: string | null = null;
  private actionToken: string | null = null;

  constructor(opts: {
    apiUrl: string;
    username: string;
    password: string;
  }) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.username = opts.username;
    this.password = opts.password;
  }

  // ── Authentication ──────────────────────────────────

  async authenticate(): Promise<string> {
    const url = `${this.apiUrl}/accounts/ClientLogin`;
    const body = new URLSearchParams({
      Email: this.username,
      Passwd: this.password,
    });

    const res = await fetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (!res.ok) {
      throw new Error(`Authentication failed: ${res.status}`);
    }

    const text = await res.text();
    const authData: Record<string, string> = {};
    for (const line of text.trim().split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        authData[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }

    if (!authData.Auth) {
      throw new Error("Auth token not found in response");
    }

    this.authToken = authData.Auth;
    return this.authToken;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authToken) {
      await this.authenticate();
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.authToken) {
      headers["Authorization"] = `GoogleLogin auth=${this.authToken}`;
    }
    return headers;
  }

  async getToken(): Promise<string> {
    await this.ensureAuthenticated();
    const url = `${this.apiUrl}/reader/api/0/token`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to get token: ${res.status}`);
    }
    this.actionToken = (await res.text()).trim();
    return this.actionToken;
  }

  private async ensureActionToken(): Promise<string> {
    await this.getToken();
    return this.actionToken!;
  }

  // ── Subscriptions ───────────────────────────────────

  async getSubscriptions(): Promise<Subscription[]> {
    await this.ensureAuthenticated();
    const url = `${this.apiUrl}/reader/api/0/subscription/list?output=json`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to get subscriptions: ${res.status}`);
    }
    const data = await res.json();
    return data.subscriptions;
  }

  async getUnreadCounts(): Promise<Map<string, number>> {
    await this.ensureAuthenticated();
    const url = `${this.apiUrl}/reader/api/0/unread-count?output=json`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to get unread counts: ${res.status}`);
    }
    const data = await res.json();
    const counts = new Map<string, number>();
    for (const item of data.unreadcounts as UnreadCount[]) {
      counts.set(item.id, item.count);
    }
    return counts;
  }

  // ── Articles ────────────────────────────────────────

  async getStreamContents(opts: {
    streamId: string;
    count?: number;
    continuation?: string;
    excludeTarget?: string;
  }): Promise<StreamContents> {
    await this.ensureAuthenticated();
    const encodedId = encodeURIComponent(opts.streamId);
    const params = new URLSearchParams({
      output: "json",
      n: String(opts.count ?? 100),
    });
    if (opts.continuation) params.set("c", opts.continuation);
    if (opts.excludeTarget) params.set("xt", opts.excludeTarget);

    const url = `${this.apiUrl}/reader/api/0/stream/contents/${encodedId}?${params}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to get stream contents: ${res.status}`);
    }
    return await res.json();
  }

  async getUnreadArticles(limit = 100, feedId?: string): Promise<Article[]> {
    const streamId = feedId ?? STATE_READING_LIST;
    const articles: Article[] = [];
    let continuation: string | undefined;

    while (articles.length < limit) {
      const remaining = limit - articles.length;
      const batchSize = Math.min(remaining, 100);

      const stream = await this.getStreamContents({
        streamId,
        count: batchSize,
        continuation,
        excludeTarget: STATE_READ,
      });

      articles.push(...stream.items);

      if (!stream.continuation || stream.items.length < batchSize) {
        break;
      }
      continuation = stream.continuation;
    }

    return articles.slice(0, limit);
  }

  async getAllUnreadArticles(): Promise<Article[]> {
    const articles: Article[] = [];
    let continuation: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stream = await this.getStreamContents({
        streamId: STATE_READING_LIST,
        count: 1000,
        continuation,
        excludeTarget: STATE_READ,
      });

      articles.push(...stream.items);

      if (!stream.continuation || stream.items.length === 0) {
        break;
      }
      continuation = stream.continuation;
    }

    return articles;
  }

  // ── State Management ────────────────────────────────

  async markAsRead(articleIds: string[]): Promise<boolean> {
    return this.editTag(articleIds, { addTag: STATE_READ });
  }

  private async editTag(
    articleIds: string[],
    opts: { addTag?: string; removeTag?: string },
  ): Promise<boolean> {
    if (articleIds.length === 0) return true;

    await this.ensureAuthenticated();
    const token = await this.ensureActionToken();
    const url = `${this.apiUrl}/reader/api/0/edit-tag`;

    const params = new URLSearchParams();
    params.set("T", token);
    for (const id of articleIds) {
      params.append("i", id);
    }
    if (opts.addTag) params.set("a", opts.addTag);
    if (opts.removeTag) params.set("r", opts.removeTag);

    const res = await fetch(url, {
      method: "POST",
      body: params.toString(),
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to edit tags: ${res.status}`);
    }
    return (await res.text()).trim() === "OK";
  }
}

// ── Helper: get article link ────────────────────────────

export function getArticleLink(article: Article): string | null {
  if (article.canonical?.[0]?.href) return article.canonical[0].href;
  if (article.alternate?.[0]?.href) return article.alternate[0].href;
  return null;
}
