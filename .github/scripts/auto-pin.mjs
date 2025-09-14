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

// Change this to true if you prefer ALWAYS-STACKED layout (see alt output below)
const ALWAYS_STACKED = false;

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
  // hide_border=true removes the card frame
  const common = `username=${encodeURIComponent(
    owner
  )}&repo=${encodeURIComponent(
    repo
  )}&show_owner=${showOwner}&hide_border=true&title_color=ff652f&icon_color=FFE400&cache_seconds=21600`;
  return {
    dark: `https://${STATS_DOMAIN}/api/pin/?${common}&text_color=ffffff&bg_color=0D1117`,
    light: `https://${STATS_DOMAIN}/api/pin/?${common}&text_color=0c1a25&bg_color=ffffff`,
  };
}

function wrapCard(owner, repo) {
  const { dark, light } = cardUrls(owner, repo);
  // Wrap img in a padded container to add spacing around the card itself
  return `<a href="https://github.com/${owner}/${repo}">
<div style="padding:10px; box-sizing:border-box;">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="${dark}">
<img alt="${repo}" src="${light}" width="480" style="max-width:100%; height:auto; display:block;">
</picture>
</div>
</a>`;
}

function td(owner, repo) {
  return `<td align="center" valign="top" width="50%" style="padding:12px; border:0;">
${wrapCard(owner, repo)}
</td>`;
}

function trSingle(owner, repo) {
  return `<tr>
<td align="center" valign="top" style="padding:12px; border:0;">
${wrapCard(owner, repo)}
</td>
</tr>`;
}

async function main() {
  // Score recent activity
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

  // Fallback: most recently updated repos if needed
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

  const [r1Owner, r1Repo] = top[0].split("/");
  const [r2Owner, r2Repo] = (top[1] || top[0]).split("/"); // safeguard

  let body;
  if (ALWAYS_STACKED) {
    // One card per row (works the same on desktop & mobile)
    body = `<table align="center" cellspacing="0" cellpadding="0" border="0" style="border:0; border-collapse:separate; margin:0 auto;">
${trSingle(r1Owner, r1Repo)}
${trSingle(r2Owner, r2Repo)}
</table>`;
  } else {
    // Two columns side-by-side (desktop/laptop). On mobile, GitHub keeps it scrollable horizontally.
    body = `<table align="center" cellspacing="0" cellpadding="0" border="0" style="border:0; border-collapse:separate; margin:0 auto;">
<tr>
${td(r1Owner, r1Repo)}
${td(r2Owner, r2Repo)}
</tr>
</table>`;
  }

  const newBlock = `${START_MARK}
<h3 align="center" style="margin:0 0 12px; color:#FF652F; font-weight:800;">📌 Pinned Repositories</h3>
${body}
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
