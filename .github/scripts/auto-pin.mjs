import fs from "fs";

// ---- config ---------------------------------------------------------------
const GH_TOKEN = process.env.GH_TOKEN;
const USERNAME =
  process.env.GH_USERNAME ||
  (process.env.GITHUB_REPOSITORY || "").split("/")[0] ||
  "MA1002643";

const STATS_DOMAIN = (
  process.env.STATS_DOMAIN || "github-readme-stats.vercel.app"
).replace(/^https?:\/\//, "");

const WEIGHTS = {
  PushEvent: 5,
  PullRequestEvent: 4,
  PullRequestReviewEvent: 3,
  IssuesEvent: 3,
  IssueCommentEvent: 2,
  CommitCommentEvent: 2,
  ReleaseEvent: 3,
  CreateEvent: 1,
  ForkEvent: 1,
  WatchEvent: 1,
};

const README_PATH = "README.md";
const START_MARK = "<!-- PINNED: START -->";
const END_MARK = "<!-- PINNED: END -->";

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GH_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function fetchJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

async function fetchPublicEvents(user) {
  let events = [];
  for (let page = 1; page <= 3; page++) {
    const data = await fetchJson(
      `https://api.github.com/users/${encodeURIComponent(
        user
      )}/events/public?per_page=100&page=${page}`
    );
    if (!Array.isArray(data) || data.length === 0) break;
    events = events.concat(data);
  }
  return events;
}

async function fetchFallbackUpdatedRepos(user) {
  const data = await fetchJson(
    `https://api.github.com/users/${encodeURIComponent(
      user
    )}/repos?per_page=100&sort=updated&direction=desc`
  );
  return (data || []).map((r) => `${r.owner.login}/${r.name}`);
}

function cardUrls(owner, repo) {
  const showOwner = owner.toLowerCase() !== USERNAME.toLowerCase();
  const common = `username=${encodeURIComponent(
    owner
  )}&repo=${encodeURIComponent(
    repo
  )}&show_owner=${showOwner}&hide_border=false&title_color=ff652f&icon_color=FFE400&cache_seconds=21600`;
  return {
    dark: `https://${STATS_DOMAIN}/api/pin/?${common}&text_color=ffffff&bg_color=0D1117&border_color=30363D`,
    light: `https://${STATS_DOMAIN}/api/pin/?${common}&text_color=0c1a25&bg_color=ffffff&border_color=0c1a25`,
  };
}

// no leading spaces, to avoid code blocks
function col(owner, repo) {
  const { dark, light } = cardUrls(owner, repo);
  return `<span style="display:inline-block; width:49%; max-width:490px; min-width:260px; vertical-align:top; box-sizing:border-box; padding:4px;">
<a href="https://github.com/${owner}/${repo}">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="${dark}">
<img alt="${repo}" src="${light}" width="100%">
</picture>
</a>
</span>`;
}

async function main() {
  const events = await fetchPublicEvents(USERNAME);
  const counts = new Map();

  for (const ev of events) {
    const full = ev?.repo?.name;
    if (!full) continue;
    if (full.toLowerCase() === `${USERNAME}/${USERNAME}`.toLowerCase())
      continue;
    const w = WEIGHTS[ev.type] ?? 1;
    counts.set(full, (counts.get(full) || 0) + w);
  }

  let top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);

  if (top.length < 2) {
    const fallback = await fetchFallbackUpdatedRepos(USERNAME);
    for (const f of fallback) {
      if (f.toLowerCase() === `${USERNAME}/${USERNAME}`.toLowerCase()) continue;
      if (!top.includes(f)) top.push(f);
      if (top.length >= 2) break;
    }
  }

  top = top.slice(0, 2);
  if (top.length === 0) {
    console.warn("No repos to pin; leaving README unchanged.");
    return;
  }

  const cols = top
    .map((full) => {
      const [owner, repo] = full.split("/");
      return col(owner, repo);
    })
    .join("");

  const newBlock = `${START_MARK}
<h3 align="center" style="margin:0 0 10px; color:#FF652F; font-weight:800;">📌 Pinned Repositories</h3>
<div align="center" style="max-width:1000px; margin:0 auto;">
${cols}
</div>
${END_MARK}`;

  const readme = fs.readFileSync(README_PATH, "utf8");
  const i1 = readme.indexOf(START_MARK);
  const i2 = readme.indexOf(END_MARK);
  if (i1 === -1 || i2 === -1)
    throw new Error("PINNED markers not found in README.md");

  const updated =
    readme.slice(0, i1) + newBlock + readme.slice(i2 + END_MARK.length);
  if (updated !== readme) {
    fs.writeFileSync(README_PATH, updated);
    console.log("Pinned:", top.join(", "));
  } else {
    console.log("Pinned section unchanged.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
