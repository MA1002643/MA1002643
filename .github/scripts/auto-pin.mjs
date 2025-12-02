import fs from "fs";

// ---- config ---------------------------------------------------------------
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const USERNAME =
  process.env.GH_USERNAME ||
  (process.env.GITHUB_REPOSITORY || "").split("/")[0] ||
  "MA1002643";

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

// layout knobs
const GAP_BETWEEN_CARDS = 24; // pixels for the middle gutter
const OUTER_CELL_PAD_TB = 12; // top/bottom padding per cell
const INNER_CARD_PAD = 10; // inner padding around each card image

if (!GH_TOKEN) {
  console.error("Error: GH_TOKEN or GITHUB_TOKEN is required");
  process.exit(1);
}

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

function opengraphCard(owner, repo) {
  const ogLight = `https://opengraph.githubassets.com/1/${owner}/${repo}`;
  const ogDark = `${ogLight}?theme=dark`;
  // Render a picture element that prefers a dark opengraph image in dark mode,
  // and include a caption showing only the repository name (no owner).
  // Caption color chosen to match the repo's light theme; dark-mode image will be used when available.
  return `<a href="https://github.com/${owner}/${repo}"><div style="padding:${INNER_CARD_PAD}px; box-sizing:border-box;"><picture><source media="(prefers-color-scheme: dark)" srcset="${ogDark}"><img alt="${repo}" src="${ogLight}" width="480" style="max-width:100%; height:auto; display:block; border-radius:6px;"></picture></div><div style="text-align:center; margin-top:8px; font-weight:600; color:#0C1A25;">${repo}</div></a>`;
}

// side: "left" | "right"
function td(owner, repo, side) {
  const leftPad = side === "right" ? GAP_BETWEEN_CARDS : 0; // gap on left of right card
  const rightPad = side === "left" ? GAP_BETWEEN_CARDS : 0; // gap on right of left card
  return `<td align="center" valign="top" width="50%" style="padding:${OUTER_CELL_PAD_TB}px ${rightPad}px ${OUTER_CELL_PAD_TB}px ${leftPad}px; border:0;">\n${opengraphCard(
    owner,
    repo
  )}\n</td>`;
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

  const [o1, r1] = top[0].split("/");
  const [o2, r2] = (top[1] || top[0]).split("/");

  const body = `<table align="center" cellspacing="0" cellpadding="0" border="0" style="border:0; border-collapse:separate; margin:0 auto;">\n<tr>\n${td(
    o1,
    r1,
    "left"
  )}\n${td(o2, r2, "right")}\n</tr>\n</table>`;

  const newBlock = `${START_MARK}\n<h3 align="center" style="margin:0 0 12px; color:#FF652F; font-weight:800;">📌 Pinned Repositories</h3>\n${body}\n${END_MARK}`;

  const readme = fs.readFileSync(README_PATH, "utf8");
  const i1 = readme.indexOf(START_MARK);
  const i2 = readme.indexOf(END_MARK);
  if (i1 === -1 || i2 === -1)
    throw new Error("PINNED markers not found in README.md");

  const updated =
    readme.slice(0, i1) + newBlock + readme.slice(i2 + END_MARK.length);

  const dry = process.argv.includes("--dry-run");
  if (dry) {
    console.log("--- DRY RUN: generated pinned block ---");
    console.log(newBlock);
    console.log("--- end generated block ---");
    console.log("Dry run complete. README was NOT modified.");
    return;
  }

  const preview = process.argv.includes("--preview");
  if (preview) {
    // Write a minimal HTML file to preview the generated block locally
    const previewPath = ".github/scripts/preview.html";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pinned Repos Preview</title></head><body style="font-family:system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; padding:24px;">${newBlock}</body></html>`;
    fs.writeFileSync(previewPath, html, "utf8");
    console.log("Preview written to", previewPath);
    console.log("Open it in your browser to inspect the pinned section.");
    return;
  }

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
