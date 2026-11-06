import "dotenv/config";
import express from "express";
import cors from "cors";


const app = express();
const PORT = process.env.PORT || 3001;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

app.use(cors());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripHtml = (html = "") =>
  html
    .replace(/<p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();

// Placeholder categorizer so the dashboard has something to group by.
// Replace with an LLM or classifier later.
const CATEGORY_HINTS = {
  Layoffs: ["layoff", "laid off", "cutting", "redundan", "fired", "downsiz"],
  Compensation: ["salary", "pay", "raise", "bonus", "equity", "offer", "compensation"],
  Management: ["manager", "director", "leadership", "management", "ceo", "boss"],
  Hiring: ["hiring", "recruit", "interview", "open roles", "resign", "quit"],
  "Workplace Culture": ["culture", "morale", "remote", "office", "burnout", "team"],
};

function categorize(text) {
  const t = text.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_HINTS)) {
    if (words.some((w) => t.includes(w))) return cat;
  }
  return "General";
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${new URL(url).hostname}`);
  return res.json();
}

// ---------- Reddit (public JSON endpoints, no API key) ----------
async function scrapeReddit(term, { postLimit = 15, commentPosts = 5, commentsPerPost = 10 } = {}) {
  const rows = [];
  const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(term)}&sort=new&t=month&limit=${postLimit}&raw_json=1`;
  const search = await getJson(searchUrl);
  const posts = search.data.children.map((c) => c.data);

  for (const p of posts) {
    rows.push({
      id: `reddit_${p.id}`,
      platform: "Reddit",
      source: `r/${p.subreddit}`,
      author: `u/${p.author}`,
      timestamp: new Date(p.created_utc * 1000).toISOString(),
      organization: term,
      text: `${p.title}${p.selftext ? "\n" + p.selftext : ""}`.slice(0, 2000),
      likes: p.score ?? 0,
      replies: p.num_comments ?? 0,
      url: `https://www.reddit.com${p.permalink}`,
      type: "post",
    });
  }

  // Pull top comments from the busiest posts: this is the actual conversation data
  const busiest = [...posts].sort((a, b) => b.num_comments - a.num_comments).slice(0, commentPosts);
  for (const p of busiest) {
    await sleep(1500); // stay under Reddit's unauthenticated rate limit
    try {
      const thread = await getJson(
        `https://www.reddit.com/comments/${p.id}.json?limit=${commentsPerPost}&depth=1&sort=top&raw_json=1`
      );
      const comments = thread[1]?.data?.children?.filter((c) => c.kind === "t1") ?? [];
      for (const { data: c } of comments.slice(0, commentsPerPost)) {
        if (!c.body || c.body === "[deleted]" || c.body === "[removed]") continue;
        rows.push({
          id: `reddit_${c.id}`,
          platform: "Reddit",
          source: `r/${p.subreddit}`,
          author: `u/${c.author}`,
          timestamp: new Date(c.created_utc * 1000).toISOString(),
          organization: term,
          text: c.body.slice(0, 2000),
          likes: c.score ?? 0,
          replies: c.replies?.data?.children?.length ?? 0,
          url: `https://www.reddit.com${c.permalink}`,
          parentId: `reddit_${p.id}`,
          type: "comment",
        });
      }
    } catch (err) {
      console.warn(`Reddit comments failed for ${p.id}: ${err.message}`);
    }
  }
  return rows;
}

// ---------- Hacker News (Algolia public API, no key) ----------
// async function scrapeHackerNews(term, { limit = 100 } = {}) {
//     const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(term)}&tags=comment&hitsPerPage=${limit}`;
//     const data = await getJson(url);
//     const exact = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
//     return data.hits

//     .filter((h) => h.comment_text)
//     .map((h) => ({
//       id: `hn_${h.objectID}`,
//       platform: "Hacker News",
//       source: h.story_title ? h.story_title.slice(0, 60) : "HN thread",
//       author: h.author,
//       timestamp: h.created_at,
//       organization: term,
//       text: stripHtml(h.comment_text).slice(0, 2000),
//       likes: h.points ?? 0,
//       replies: 0,
//       url: `https://news.ycombinator.com/item?id=${h.objectID}`,
//       parentId: `hn_${h.parent_id}`,
//       type: "comment",
//     }))
//     .filter((r) => exact.test(r.text));
// }


// ---------- LinkedIn (via a RapidAPI provider, public posts only) ----------
// ---------- LinkedIn (via RapidAPI provider, public post search) ----------
async function scrapeLinkedIn(term, { pages = 1 } = {}) {
    const host = process.env.LINKEDIN_API_HOST;
    const key = process.env.LINKEDIN_API_KEY;
    const base = process.env.LINKEDIN_API_URL; // full endpoint URL, no query string
    if (!host || !key || !base) throw new Error("Set LINKEDIN_API_HOST, LINKEDIN_API_KEY and LINKEDIN_API_URL");
  
    const rows = [];
    for (let page = 1; page <= pages; page++) {
      const url = `${base}?keyword=${encodeURIComponent(term)}&sort_by=date_posted&page=${page}`;
      const res = await fetch(url, { headers: { "x-rapidapi-host": host, "x-rapidapi-key": key } });
      if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.message || "LinkedIn API returned success=false");
  
      for (const p of json.data || []) {
        rows.push({
          id: `linkedin_${p.id}`,
          platform: "LinkedIn",
          source: p.author?.url?.includes("/company/") ? "Company page" : "Member post",
          author: p.author?.name || "unknown",
          authorType: p.author?.url?.includes("/company/") ? "company" : "person",
          timestamp: p.created_at,
          organization: term,
          text: String(p.title || "").slice(0, 2000),
          likes: p.activity?.num_likes ?? 0,
          replies: p.activity?.num_comments ?? 0,
          url: p.url,
          type: "post",
        });
      }
      if (!json.has_more) break;
      await sleep(500);
    }
    return rows.filter((r) => r.text);
  }


  // ---------- Facebook (via RapidAPI, public post search) ----------
// ---------- Facebook (via RapidAPI, public post search) ----------
async function scrapeFacebook(term, { pages = 1 } = {}) {
  const host = process.env.FACEBOOK_API_HOST;
  const key = process.env.FACEBOOK_API_KEY;
  const base = process.env.FACEBOOK_API_URL;
  if (!host || !key || !base) throw new Error("Set FACEBOOK_API_HOST, FACEBOOK_API_KEY and FACEBOOK_API_URL");

  const rows = [];
  let cursor = "";
  for (let page = 1; page <= pages; page++) {
    const url = `${base}?query=${encodeURIComponent(term)}${cursor ? `&end_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: { "x-rapidapi-host": host, "x-rapidapi-key": key } });
    if (!res.ok) throw new Error(`Facebook API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    const items = json.data?.items || [];

    for (const p of items) {
      const info = p.basic_info || {};
      const fb = p.feedback_details || {};
      const owner = p.owner_info || {};

      rows.push({
        id: `facebook_${info.post_id}`,
        platform: "Facebook",
        source: owner.owner_name || "Facebook",
        author: owner.owner_name || "unknown",
        // this endpoint returns no post date, so use the fetch time
        timestamp: new Date().toISOString(),
        organization: term,
        text: String(info.post_text || "").slice(0, 2000),
        likes: fb.reaction_count ?? 0,
        replies: fb.total_comments ?? 0,
        url: info.url,
        type: "post",
      });
    }

    cursor = json.data?.page_info?.cursor || "";
    if (!cursor || items.length === 0) break;
    await sleep(500);
  }
  return rows.filter((r) => r.text && r.id !== "facebook_undefined");
}

// ---------- X / Twitter (via RapidAPI, public post search) ----------
async function scrapeX(term, { pages = 1 } = {}) {
  const host = process.env.X_API_HOST;
  const key = process.env.X_API_KEY;
  const base = process.env.X_API_URL;
  if (!host || !key || !base) throw new Error("Set X_API_HOST, X_API_KEY and X_API_URL");

  const rows = [];
  let cursor = "";
  for (let page = 1; page <= pages; page++) {
    const url = `${base}?query=${encodeURIComponent(term)}&type=Top${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

    const res = await fetch(url, { headers: { "x-rapidapi-host": host, "x-rapidapi-key": key } });
    if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();

    const items = Array.isArray(json.data)
  ? json.data
  : json.data?.items || json.data?.tweets || json.tweets || [];
for (const item of items) {
  const c = item.content ?? item;
      if (!c?.id) continue;
      rows.push({
        id: `x_${c.id}`,
        platform: "X",
        source: `@${c.author?.username}`,
        author: c.author?.name || c.author?.username || "unknown",
        timestamp: c.createdAt,
        organization: term,
        text: String(c.text || "").slice(0, 2000),
        likes: c.likeCount ?? 0,
        replies: c.replyCount ?? 0,
        url: `https://x.com/${c.author?.username}/status/${c.id}`,
        type: c.type === "quote" ? "quote" : "post",
      });
    }

    cursor = json.pagination?.nextCursor || "";
    if (!cursor || items.length === 0) break;
    await sleep(500);
  }
  return rows.filter((r) => r.text);
}



const SCRAPERS = {
  linkedin: ["LinkedIn", scrapeLinkedIn],
  facebook: ["Facebook", scrapeFacebook],
  x: ["X", scrapeX],
};



// ---------- API ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// GET /api/collect?terms=Acme,Globex&sources=reddit,hn
// GET /api/collect?terms=AI,Nike&sources=linkedin,facebook
app.get("/api/collect", async (req, res) => {
  const terms = String(req.query.terms || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (terms.length === 0) {
    return res.status(400).json({ error: "Pass at least one term, e.g. ?terms=Acme,Globex" });
  }

  const sources = String(req.query.sources || "linkedin")
    .split(",")
    .map((s) => s.trim().toLowerCase());

  const pages = Math.min(Number(req.query.pages) || 1, 3);
  const rows = [];
  const errors = [];

  for (const term of terms) {
    const jobs = sources
      .filter((s) => SCRAPERS[s])
      .map((s) => [SCRAPERS[s][0], SCRAPERS[s][1](term, { pages })]);

    const results = await Promise.allSettled(jobs.map(([, p]) => p));
    results.forEach((r, i) => {
      const name = jobs[i][0];
      if (r.status === "fulfilled") rows.push(...r.value);
      else errors.push({ source: name, term, message: r.reason.message });
    });
  }

  const seen = new Set();
  const seenText = new Set();
  const data = rows
    .filter((r) => (seen.has(r.id) ? false : seen.add(r.id)))
    .filter((r) => {
      const key = r.text.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 100);
      return seenText.has(key) ? false : seenText.add(key);
    })
    .map((r) => ({ ...r, category: categorize(r.text) }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  res.json({ count: data.length, data, errors });
});


app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));