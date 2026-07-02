import fs from "fs";
import path from "path";

// ---- config ---------------------------------------------------------------
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const USERNAME =
  process.env.GH_USERNAME ||
  (process.env.GITHUB_REPOSITORY || "").split("/")[0] ||
  "MA1002643";

const DAYS = 30;
const MAX_ROWS = 8; // rows drawn on the card; the feed stays scannable
const README_PATH = "README.md";
const ACT_START = "<!--RECENT_ACTIVITY:start-->";
const ACT_END = "<!--RECENT_ACTIVITY:end-->";
const CACHE_PATH = ".github/activity-cache.json";
const ASSET_DIR = "assets";
const CARD_W = 1200;

// Same visual family as assets/ops-board-*.svg — the feed must read as one
// system with the rest of the profile artwork.
const THEMES = {
  dark: {
    bgStops: ["#0B1220", "#0D1117", "#0F172A"],
    grid: "#1E293B",
    gridOpacity: 0.22,
    glowOpacity: [0.07, 0.02],
    border: "#243042",
    keyline: "#243042",
    title: "#E5E7EB",
    desc: "#9DA9B8",
    muted: "#64748B",
    ownerMuted: "#7D8590",
    live: "#3FB950",
    accent: "#FF652F",
  },
  light: {
    bgStops: ["#FFFFFF", "#FBFCFD", "#F6F8FA"],
    grid: "#D8DEE4",
    gridOpacity: 0.35,
    glowOpacity: [0.04, 0.012],
    border: "#D0D7DE",
    keyline: "#D8DEE4",
    title: "#0C1A25",
    desc: "#4B5563",
    muted: "#6E7781",
    ownerMuted: "#6E7781",
    live: "#1A7F37",
    accent: "#E5531A",
  },
};

// Event taxonomy: chip label + per-theme color (GitHub semantic hues).
const KINDS = {
  push: { label: "PUSH", dark: "#FF652F", light: "#BC4C00" },
  merge: { label: "MERGE", dark: "#A371F7", light: "#8250DF" },
  "pr-open": { label: "OPEN PR", dark: "#3FB950", light: "#1A7F37" },
  "pr-closed": { label: "CLOSED PR", dark: "#F85149", light: "#CF222E" },
  review: { label: "REVIEW", dark: "#58A6FF", light: "#0969DA" },
  "issue-open": { label: "ISSUE", dark: "#3FB950", light: "#1A7F37" },
  "issue-closed": { label: "ISSUE", dark: "#A371F7", light: "#8250DF" },
  branch: { label: "BRANCH", dark: "#58A6FF", light: "#0969DA" },
  tag: { label: "TAG", dark: "#58A6FF", light: "#0969DA" },
  repo: { label: "NEW REPO", dark: "#FFC857", light: "#D98324" },
  delete: { label: "CLEANUP", dark: "#8B949E", light: "#6E7781" },
  star: { label: "STAR", dark: "#FFC857", light: "#D98324" },
  fork: { label: "FORK", dark: "#58A6FF", light: "#0969DA" },
  public: { label: "PUBLIC", dark: "#3FB950", light: "#1A7F37" },
  meta: { label: "META", dark: "#8B949E", light: "#6E7781" },
};

if (!GH_TOKEN) {
  console.error("Error: GH_TOKEN or GITHUB_TOKEN is required");
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GH_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

// ---- API helpers ------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}\n${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function pageQuery(query, vars, pickPage) {
  let after = null;
  const nodes = [];
  while (true) {
    const data = await graphql(query, { ...vars, after });
    const { page, pageInfo } = pickPage(data);
    if (page && page.length) nodes.push(...page);
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return nodes;
}

function getPRContribs(login, from, to) {
  const q = `
    query($login:String!, $from:DateTime!, $to:DateTime!, $after:String) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          pullRequestContributions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              occurredAt
              pullRequest { mergedAt state repository { nameWithOwner } }
            }
          }
        }
      }
    }`;
  return pageQuery(q, { login, from, to }, (d) => {
    const c = d.user.contributionsCollection.pullRequestContributions;
    return { page: c.nodes, pageInfo: c.pageInfo };
  });
}

function getReviewContribs(login, from, to) {
  const q = `
    query($login:String!, $from:DateTime!, $to:DateTime!, $after:String) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          pullRequestReviewContributions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { occurredAt pullRequest { repository { nameWithOwner } } }
          }
        }
      }
    }`;
  return pageQuery(q, { login, from, to }, (d) => {
    const c = d.user.contributionsCollection.pullRequestReviewContributions;
    return { page: c.nodes, pageInfo: c.pageInfo };
  });
}

function getIssueContribs(login, from, to) {
  const q = `
    query($login:String!, $from:DateTime!, $to:DateTime!, $after:String) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          issueContributions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { occurredAt issue { state repository { nameWithOwner } } }
          }
        }
      }
    }`;
  return pageQuery(q, { login, from, to }, (d) => {
    const c = d.user.contributionsCollection.issueContributions;
    return { page: c.nodes, pageInfo: c.pageInfo };
  });
}

function getOwnerRepos(login) {
  const q = `
    query($login:String!, $after:String) {
      user(login:$login) {
        repositories(ownerAffiliations: OWNER, first: 100,
                     orderBy: {field: UPDATED_AT, direction: DESC}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            nameWithOwner isFork createdAt updatedAt description
            repositoryTopics(first: 100) { nodes { topic { name } } }
          }
        }
      }
    }`;
  return pageQuery(q, { login }, (d) => {
    const c = d.user.repositories;
    return { page: c.nodes, pageInfo: c.pageInfo };
  });
}

async function getPublicEvents(user, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJson(
      `https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=100&page=${page}`
    );
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
  }
  return out;
}

// ---- gather ----------------------------------------------------------------

async function gather() {
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const within = (d) => {
    const dt = new Date(d);
    return dt >= from && dt <= now;
  };

  let cache = { repos: {} };
  try {
    if (fs.existsSync(CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    }
  } catch {
    cache = { repos: {} };
  }

  const items = [];
  // kind: KINDS key · verb composes as "<verb> <owner/repo>"
  const addItem = (date, key, kind, verb, repo) => {
    if (!date || !key || !kind || !repo) return;
    items.push({ date, key, kind, verb, repo });
  };

  const fromISO = from.toISOString();
  const toISO = now.toISOString();

  const [prNodes, reviewNodes, issueNodes, repos, events] = await Promise.all([
    getPRContribs(USERNAME, fromISO, toISO),
    getReviewContribs(USERNAME, fromISO, toISO),
    getIssueContribs(USERNAME, fromISO, toISO),
    getOwnerRepos(USERNAME),
    getPublicEvents(USERNAME, 3),
  ]);

  for (const n of prNodes) {
    if (!within(n.occurredAt)) continue;
    const repo = n.pullRequest?.repository?.nameWithOwner;
    if (!repo) continue;
    if (n.pullRequest.mergedAt) {
      addItem(n.occurredAt, `pr:${repo}:merge`, "merge", "Merged a pull request in", repo);
    } else if (n.pullRequest.state === "OPEN") {
      addItem(n.occurredAt, `pr:${repo}:open`, "pr-open", "Opened a pull request in", repo);
    } else {
      addItem(n.occurredAt, `pr:${repo}:closed`, "pr-closed", "Closed a pull request in", repo);
    }
  }

  for (const n of reviewNodes) {
    if (!within(n.occurredAt)) continue;
    const repo = n.pullRequest?.repository?.nameWithOwner;
    if (!repo) continue;
    addItem(n.occurredAt, `review:${repo}`, "review", "Reviewed a pull request in", repo);
  }

  for (const n of issueNodes) {
    if (!within(n.occurredAt)) continue;
    const repo = n.issue?.repository?.nameWithOwner;
    if (!repo) continue;
    if (n.issue.state === "OPEN") {
      addItem(n.occurredAt, `issue:${repo}:open`, "issue-open", "Opened an issue in", repo);
    } else {
      addItem(n.occurredAt, `issue:${repo}:closed`, "issue-closed", "Closed an issue in", repo);
    }
  }

  // REST events — strict, repo-only, no commit counts.
  const pushLatest = new Map();
  for (const ev of events) {
    const when = ev.created_at;
    if (!within(when)) continue;
    const repo = ev.repo?.name;
    if (!repo) continue;

    switch (ev.type) {
      case "PushEvent": {
        const prev = pushLatest.get(repo);
        if (!prev || new Date(when) > new Date(prev)) pushLatest.set(repo, when);
        break;
      }
      case "WatchEvent":
        addItem(when, `star:${repo}`, "star", "Starred", repo);
        break;
      case "ForkEvent":
        addItem(when, `fork:${repo}`, "fork", "Forked", repo);
        break;
      case "CreateEvent": {
        const rt = ev.payload?.ref_type;
        if (rt === "repository") {
          addItem(when, `create-repo:${repo}`, "repo", "Created repository", repo);
        } else if (rt === "branch") {
          addItem(when, `create:${repo}:branch`, "branch", "Created a branch in", repo);
        } else if (rt === "tag") {
          addItem(when, `create:${repo}:tag`, "tag", "Tagged a release in", repo);
        }
        break;
      }
      case "DeleteEvent": {
        const rt = ev.payload?.ref_type;
        if (rt === "branch") {
          addItem(when, `delete:${repo}:branch`, "delete", "Pruned a branch in", repo);
        } else if (rt === "tag") {
          addItem(when, `delete:${repo}:tag`, "delete", "Removed a tag in", repo);
        }
        break;
      }
      case "PublicEvent":
        addItem(when, `public:${repo}`, "public", "Open-sourced", repo);
        break;
      default:
        break;
    }
  }
  for (const [repo, latest] of pushLatest.entries()) {
    addItem(latest, `push:${repo}`, "push", "Pushed commits to", repo);
  }

  // Description/topic changes (vs cache).
  const arrEq = (a, b) => {
    const A = (a || []).slice().sort();
    const B = (b || []).slice().sort();
    return A.length === B.length && A.every((v, i) => v === B[i]);
  };
  const newCache = { repos: {} };
  for (const r of repos) {
    const full = r.nameWithOwner;
    const description = r.description || "";
    const topics = (r.repositoryTopics?.nodes || [])
      .map((n) => n?.topic?.name)
      .filter(Boolean);
    const prev = cache.repos[full] || { description: null, topics: null };

    if (within(r.updatedAt)) {
      if (prev.description !== null && prev.description !== description) {
        addItem(r.updatedAt, `desc:${full}:${r.updatedAt}`, "meta", "Updated the description of", full);
      }
      if (prev.topics !== null && !arrEq(prev.topics, topics)) {
        addItem(r.updatedAt, `topics:${full}:${r.updatedAt}`, "meta", "Updated topics on", full);
      }
    }
    newCache.repos[full] = { description, topics, updatedAt: r.updatedAt };
  }

  // Dedup by key (keep latest), newest first.
  const map = new Map();
  for (const it of items) {
    const existing = map.get(it.key);
    if (!existing || new Date(it.date) > new Date(existing.date)) map.set(it.key, it);
  }
  const unique = [...map.values()].sort((a, b) => new Date(b.date) - new Date(a.date));

  return { unique, newCache, now };
}

// ---- SVG rendering -----------------------------------------------------------

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Pin rendered text widths (fallback fonts differ per platform) — same
// technique as the other generated assets. JetBrains Mono advances 0.6em;
// Inter averages ≈0.48em with spaces.
const monoW = (s, size) => Math.max(1, Math.round(s.length * size * 0.6));
const interW = (s, size) => Math.max(1, Math.round(s.length * size * 0.48));

function timeAgo(date, now) {
  const s = Math.max(1, Math.floor((now - new Date(date)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function lastSyncLabel(now) {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${s} UTC`.toUpperCase();
}

function itemPlainText(it, now) {
  return `${it.verb} ${it.repo} (${timeAgo(it.date, now)})`;
}

function feedSvg(items, totalCount, themeName, now) {
  const t = THEMES[themeName];
  const rows = items.slice(0, MAX_ROWS);
  const n = Math.max(rows.length, 1);

  const yc0 = 104;
  const rowGap = 44;
  const ycLast = yc0 + (n - 1) * rowGap;
  const fy = ycLast + 32; // footer divider
  const H = fy + 46;

  const aria =
    `Recent GitHub activity for ${USERNAME}, refreshed daily. ` +
    (rows.length
      ? rows.map((it) => itemPlainText(it, now)).join(". ") + "."
      : "No public activity in the last 30 days.");

  const rowSvg = rows
    .map((it, i) => {
      const yc = yc0 + i * rowGap;
      const k = KINDS[it.kind] || KINDS.meta;
      const color = k[themeName];
      const begin = (0.3 + i * 0.09).toFixed(2);

      // Latest event gets a soft brand-orange wash + radar pulse on its node.
      const highlight =
        i === 0
          ? `<rect x="36" y="${yc - 18}" width="1128" height="36" rx="9" fill="${t.accent}" fill-opacity="${themeName === "dark" ? 0.05 : 0.04}" stroke="${t.accent}" stroke-opacity="0.18" stroke-width="1"/>`
          : "";
      const pulse =
        i === 0
          ? `<circle cx="56" cy="${yc}" r="7.5" fill="none" stroke="${color}" stroke-width="1.4">
        <animate attributeName="r" values="7.5;15" dur="2.4s" begin="1.2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.55;0" dur="2.4s" begin="1.2s" repeatCount="indefinite"/>
      </circle>`
          : "";

      const label = k.label;
      const chipTextLen = Math.round(label.length * 6.6);

      const verb = it.verb;
      const wVerb = interW(verb, 14.5);
      const xRepo = 200 + wVerb + 9;

      let full = it.repo.length > 58 ? it.repo.slice(0, 57) + "…" : it.repo;
      const slash = full.indexOf("/");
      const owner = slash === -1 ? "" : full.slice(0, slash + 1);
      const name = slash === -1 ? full : full.slice(slash + 1);
      const wRepo = monoW(full, 13.5);

      const ago = timeAgo(it.date, now);
      const wAgo = monoW(ago, 12);

      const leadX1 = xRepo + wRepo + 16;
      const leadX2 = 1160 - wAgo - 18;
      const leader =
        leadX2 - leadX1 > 24
          ? `<line x1="${leadX1}" y1="${yc}" x2="${leadX2}" y2="${yc}" stroke="${t.keyline}" stroke-width="1" stroke-dasharray="2 5"/>`
          : "";

      return `
    <g opacity="0" transform="translate(-10 0)">
      <animate attributeName="opacity" values="0;1" dur="0.45s" begin="${begin}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
      <animateTransform attributeName="transform" type="translate" values="-10 0;0 0" dur="0.45s" begin="${begin}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
      ${highlight}
      ${pulse}
      <circle cx="56" cy="${yc}" r="7.5" fill="${t.bgStops[1]}" stroke="${color}" stroke-width="1.6"/>
      <circle cx="56" cy="${yc}" r="2.8" fill="${color}"/>
      <rect x="84" y="${yc - 11}" width="88" height="22" rx="11" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.4" stroke-width="1"/>
      <text x="128" y="${yc + 4}" font-size="11" letter-spacing="1" fill="${color}" text-anchor="middle" textLength="${chipTextLen}" lengthAdjust="spacingAndGlyphs" font-family="'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace">${escapeXml(label)}</text>
      <text x="200" y="${yc + 5}" font-size="14.5" fill="${t.desc}" textLength="${wVerb}" lengthAdjust="spacingAndGlyphs">${escapeXml(verb)}</text>
      <text x="${xRepo}" y="${yc + 5}" font-size="13.5" textLength="${wRepo}" lengthAdjust="spacingAndGlyphs" font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">${owner ? `<tspan fill="${t.ownerMuted}">${escapeXml(owner)}</tspan>` : ""}<tspan fill="${t.title}">${escapeXml(name)}</tspan></text>
      ${leader}
      <text x="1160" y="${yc + 4}" font-size="12" fill="${t.muted}" text-anchor="end" textLength="${wAgo}" lengthAdjust="spacingAndGlyphs" font-family="'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace">${escapeXml(ago)}</text>
    </g>`;
    })
    .join("\n");

  const emptyState =
    rows.length === 0
      ? `<text x="56" y="${yc0 + 5}" font-size="14.5" font-style="italic" fill="${t.desc}">No public activity in the last 30 days — heads-down on longer-running work.</text>`
      : "";

  const rail =
    n >= 2
      ? `<line x1="56" y1="${yc0}" x2="56" y2="${ycLast}" stroke="${t.keyline}" stroke-width="1.5" opacity="0.9"/>`
      : "";

  const cmd = `$ gh api /users/${USERNAME}/events --window ${DAYS}d | render --svg --theme ${themeName}`;
  const cmdW = monoW(cmd, 11);
  const shown = Math.min(rows.length, totalCount);
  const footRight = `showing ${shown} of ${totalCount} events · refreshed daily 08:00 UTC`;

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(aria)}" viewBox="0 0 ${CARD_W} ${H}" width="${CARD_W}" height="${H}" preserveAspectRatio="xMidYMid meet" text-rendering="geometricPrecision">
  <title>Recent GitHub activity — live feed</title>
  <desc>Auto-generated event stream for @${escapeXml(USERNAME)}: color-coded timeline of pushes, pull requests, branches, and releases, re-rendered daily by a GitHub Action.</desc>

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${CARD_W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"  stop-color="${t.bgStops[0]}"/>
      <stop offset="55%" stop-color="${t.bgStops[1]}"/>
      <stop offset="100%" stop-color="${t.bgStops[2]}"/>
    </linearGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" fill="none" stroke="${t.grid}" stroke-width="0.6"/>
    </pattern>
    <radialGradient id="glow" cx="50%" cy="0%" r="70%">
      <stop offset="0%"  stop-color="#FF652F" stop-opacity="${t.glowOpacity[0]}"/>
      <stop offset="60%" stop-color="#FF652F" stop-opacity="${t.glowOpacity[1]}"/>
      <stop offset="100%" stop-color="#FF652F" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#FF652F"/>
      <stop offset="100%" stop-color="#FFC857"/>
    </linearGradient>
    <clipPath id="cardClip"><rect x="1" y="1" width="${CARD_W - 2}" height="${H - 2}" rx="16"/></clipPath>
    <style>@media (prefers-reduced-motion: reduce){ * { animation:none !important; transition:none !important } }</style>
  </defs>

  <g clip-path="url(#cardClip)">
    <rect x="1" y="1" width="${CARD_W - 2}" height="${H - 2}" fill="url(#bg)"/>
    <rect x="1" y="1" width="${CARD_W - 2}" height="${H - 2}" fill="url(#grid)" opacity="${t.gridOpacity}"/>
    <rect x="1" y="1" width="${CARD_W - 2}" height="${H - 2}" fill="url(#glow)"/>
  </g>
  <rect x="1" y="1" width="${CARD_W - 2}" height="${H - 2}" rx="16" fill="none" stroke="${t.border}" stroke-width="1.5"/>

  <!-- header -->
  <g opacity="0" font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">
    <animate attributeName="opacity" values="0;1" dur="0.5s" begin="0.15s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
    <circle cx="44" cy="41" r="4.5" fill="${t.live}">
      <animate attributeName="opacity" values="1;0.35;1" dur="2.2s" begin="1s" repeatCount="indefinite"/>
    </circle>
    <text x="58" y="45" font-size="11.5" letter-spacing="2" fill="${t.live}">LIVE</text>
    <text x="112" y="45" font-size="11" letter-spacing="1.5" fill="${t.muted}">· EVENT STREAM — @${escapeXml(USERNAME)}</text>
    <text x="1160" y="45" font-size="11" letter-spacing="1" fill="${t.muted}" text-anchor="end">LAST SYNC · ${escapeXml(lastSyncLabel(now))}</text>
    <line x1="40" y1="64" x2="1160" y2="64" stroke="${t.keyline}" stroke-width="1" opacity="0.8"/>
    <rect x="40" y="62.5" width="0" height="3" rx="1.5" fill="url(#acc)">
      <animate attributeName="width" values="0;96" dur="0.5s" begin="0.5s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1"/>
    </rect>
  </g>

  <!-- timeline -->
  <g opacity="0">
    <animate attributeName="opacity" values="0;1" dur="0.5s" begin="0.25s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
    ${rail}
  </g>

  <g font-family="Inter, 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif">
${rowSvg}
    ${emptyState}
  </g>

  <!-- footer -->
  <g opacity="0" font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace" font-size="11">
    <animate attributeName="opacity" values="0;1" dur="0.5s" begin="${(0.35 + n * 0.09).toFixed(2)}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
    <line x1="40" y1="${fy}" x2="1160" y2="${fy}" stroke="${t.keyline}" stroke-width="1" opacity="0.8"/>
    <text x="40" y="${fy + 26}" fill="${t.muted}" textLength="${cmdW}" lengthAdjust="spacingAndGlyphs">${escapeXml(cmd)}</text>
    <rect x="${40 + cmdW + 8}" y="${fy + 16}" width="7" height="13" fill="${t.accent}">
      <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.2s" repeatCount="indefinite"/>
    </rect>
    <text x="1160" y="${fy + 26}" fill="${t.muted}" text-anchor="end">${escapeXml(footRight)}</text>
  </g>
</svg>
`;
}

// ---- README injection ----------------------------------------------------------

function pictureBlock(alt) {
  // Single <picture> with theme-matched sources, same pattern as every other
  // generated card in this README.
  return `<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/activity-feed-dark.svg">
    <img src="./assets/activity-feed-light.svg" alt="${alt}" width="100%">
  </picture>
</div>`;
}

async function main() {
  const { unique, newCache, now } = await gather();
  const rows = unique.slice(0, MAX_ROWS);

  const alt = escapeXml(
    `Recent GitHub activity — refreshed daily: ` +
      (rows.length
        ? rows.map((it) => itemPlainText(it, now)).join("; ")
        : "no public activity in the last 30 days")
  );

  const dark = feedSvg(unique, unique.length, "dark", now);
  const light = feedSvg(unique, unique.length, "light", now);
  const block = `${ACT_START}\n${pictureBlock(alt)}\n${ACT_END}`;

  if (process.argv.includes("--dry-run")) {
    console.log("--- DRY RUN: generated activity block ---");
    console.log(block);
    console.log(`--- ${unique.length} events gathered, ${rows.length} rendered ---`);
    return;
  }

  fs.writeFileSync(path.join(ASSET_DIR, "activity-feed-dark.svg"), dark, "utf8");
  fs.writeFileSync(path.join(ASSET_DIR, "activity-feed-light.svg"), light, "utf8");

  const readme = fs.readFileSync(README_PATH, "utf8");
  const i1 = readme.indexOf(ACT_START);
  const i2 = readme.indexOf(ACT_END);
  if (i1 === -1 || i2 === -1)
    throw new Error("Markers not found: RECENT_ACTIVITY:start/end");
  const updated =
    readme.slice(0, i1) + block + readme.slice(i2 + ACT_END.length);

  if (updated !== readme) {
    fs.writeFileSync(README_PATH, updated, "utf8");
    console.log(`README updated (${rows.length}/${unique.length} events on card).`);
  } else {
    console.log("README block unchanged (card assets refreshed).");
  }

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache, null, 2), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
