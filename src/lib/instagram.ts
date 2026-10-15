// Read-only Instagram numbers for the private stats page: the account, recent posts with their
// insights, and the latest comments. Server-side only; the token never reaches the browser.
//
// Uses the same Instagram User access token as the NEST auto-reply (IG_ACCESS_TOKEN). Post
// insights need the instagram_business_manage_insights permission on that token; without it
// the posts still list with likes and comment counts, and insights show as missing.

const GRAPH = "https://graph.instagram.com/v23.0";
const TOKEN = process.env.IG_ACCESS_TOKEN ?? "";

export interface IgPost {
  id: string;
  caption: string;
  permalink: string;
  timestamp: string;
  type: string; // REELS, FEED, ...
  likes: number;
  comments: number;
  views: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
}

export interface IgComment {
  username: string;
  text: string;
  timestamp: string;
  permalink: string;
}

export interface IgStats {
  username: string;
  followers: number;
  posts: IgPost[];
  latestComments: IgComment[];
  insightsMissing: boolean;
  error: string | null;
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

type Metric = { name: string; values?: { value: number }[]; total_value?: { value: number } };

async function insights(id: string): Promise<Record<string, number> | null> {
  try {
    const r = await get<{ data: Metric[] }>(`${id}/insights`, { metric: "views,reach,saved,shares" });
    const out: Record<string, number> = {};
    for (const m of r.data) out[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    return out;
  } catch {
    return null; // no insights permission, or a media type that has no insights
  }
}

// About 25 Graph API calls per load, so a successful result is kept for a few minutes: switching
// ranges or removing a visit on the stats page then reloads in a fraction of a second.
const KEEP_MS = 5 * 60 * 1000;
let cached: { at: number; data: IgStats } | null = null;

export async function loadInstagram(): Promise<IgStats | null> {
  if (!TOKEN) return null;
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.data;
  const data = await fetchInstagram();
  if (!data.error) cached = { at: Date.now(), data };
  return data;
}

async function fetchInstagram(): Promise<IgStats> {
  try {
    const [me, media] = await Promise.all([
      get<{ username: string; followers_count?: number }>("me", { fields: "username,followers_count" }),
      get<{
        data: { id: string; caption?: string; permalink: string; timestamp: string; media_product_type?: string; like_count?: number; comments_count?: number }[];
      }>("me/media", {
        fields: "id,caption,permalink,timestamp,media_product_type,like_count,comments_count",
        limit: "12",
      }),
    ]);

    // Insights and comments don't depend on each other, so both sets go out at once.
    const rowsP = Promise.all(
      media.data.map(async (m) => {
        const ins = await insights(m.id);
        const post: IgPost = {
          id: m.id,
          caption: (m.caption ?? "").split("\n")[0].slice(0, 80),
          permalink: m.permalink,
          timestamp: m.timestamp,
          type: m.media_product_type ?? "",
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          views: ins?.views ?? null,
          reach: ins?.reach ?? null,
          saves: ins?.saved ?? null,
          shares: ins?.shares ?? null,
        };
        return { post, gotInsights: ins !== null };
      }),
    );

    // Latest comments across the most recent posts that have any.
    const withComments = media.data.filter((m) => (m.comments_count ?? 0) > 0).slice(0, 5);
    const [rows, commentLists] = await Promise.all([rowsP, Promise.all(
      withComments.map(async (m) => {
        try {
          const c = await get<{ data: { username?: string; text?: string; timestamp: string }[] }>(`${m.id}/comments`, {
            fields: "username,text,timestamp",
            limit: "10",
          });
          return c.data.map((x) => ({ username: x.username ?? "", text: x.text ?? "", timestamp: x.timestamp, permalink: m.permalink }));
        } catch {
          return [];
        }
      }),
    )]);
    const latestComments = commentLists
      .flat()
      .filter((c) => c.username !== me.username)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 12);

    return {
      username: me.username,
      followers: me.followers_count ?? 0,
      posts: rows.map((r) => r.post),
      latestComments,
      insightsMissing: rows.length > 0 && rows.every((r) => !r.gotInsights),
      error: null,
    };
  } catch (e) {
    return {
      username: "",
      followers: 0,
      posts: [],
      latestComments: [],
      insightsMissing: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
