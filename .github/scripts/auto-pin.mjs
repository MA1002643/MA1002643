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
const FEAT_START = "<!-- FEATURED: START -->";
const FEAT_END = "<!-- FEATURED: END -->";

// The two pinned cards are bespoke SVGs generated here on every run, in the
// same visual family as assets/featured-card-*.svg, and written to stable
// paths under assets/ (position 1 and 2, dark and light). GitHub strips
// style attributes (and applies its own bordered styling to <table>/<td>)
// in README HTML, so all styling must live inside the SVGs themselves.
const ASSET_DIR = "assets";
const CARD_W = 600;
const CARD_H = 190;
const FEAT_W = 1200;
const FEAT_H = 260;

// GitHub linguist colors for languages likely to appear; neutral fallback.
const LANG_COLORS = {
  JavaScript: "#F1E05A",
  TypeScript: "#3178C6",
  "C#": "#178600",
  HTML: "#E34C26",
  CSS: "#563D7C",
  SCSS: "#C6538C",
  Vue: "#41B883",
  Python: "#3572A5",
  Java: "#B07219",
  Shell: "#89E051",
  PowerShell: "#012456",
  Go: "#00ADD8",
  Rust: "#DEA584",
  PHP: "#4F5D95",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  Dart: "#00B4AB",
  "C++": "#F34B7D",
  C: "#555555",
  Razor: "#512BE4",
  Dockerfile: "#384D54",
  "Jupyter Notebook": "#DA5B0B",
};

const THEMES = {
  dark: {
    bgStops: ["#0B1220", "#0D1117", "#0F172A"],
    grid: "#1E293B",
    gridOpacity: 0.22,
    glowOpacity: [0.09, 0.025],
    border: "#243042",
    title: "#E5E7EB",
    desc: "#9DA9B8",
    keyline: "#243042",
    stat: "#C9D1D9",
    statMuted: "#94A3B8",
    star: "#FFC857",
    link: "#58A6FF",
    chipFill: "#111827",
    chipStroke: "#243042",
  },
  light: {
    bgStops: ["#FFFFFF", "#FBFCFD", "#F6F8FA"],
    grid: "#D8DEE4",
    gridOpacity: 0.35,
    glowOpacity: [0.05, 0.015],
    border: "#D0D7DE",
    title: "#0C1A25",
    desc: "#4B5563",
    keyline: "#D8DEE4",
    stat: "#334155",
    statMuted: "#57606A",
    star: "#D98324",
    link: "#0969DA",
    chipFill: "#F6F8FA",
    chipStroke: "#D0D7DE",
  },
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

// ---- SVG card generation ---------------------------------------------------

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// SVG text has no wrapping: split the description into at most two lines,
// ellipsizing anything that does not fit.
function wrapTwoLines(text, budget = 78) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  let l1 = "";
  let l2 = "";
  let onSecond = false;
  for (const w of words) {
    if (!onSecond) {
      const cand = l1 ? `${l1} ${w}` : w;
      if (cand.length <= budget) {
        l1 = cand;
        continue;
      }
      onSecond = true;
    }
    const cand = l2 ? `${l2} ${w}` : w;
    if (cand.length <= budget) {
      l2 = cand;
    } else {
      l2 = `${l2}…`;
      break;
    }
  }
  return [l1, l2];
}

const fmtCount = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

function cardSvg(meta, themeName) {
  const t = THEMES[themeName];
  const title = `~/${meta.name}`;
  // Pin the title's rendered width (mono fallback fonts differ per platform)
  // and compress long repo names into the padded column instead of clipping.
  const titleLength = Math.min(Math.round(title.length * 11.8), 536);
  const [descL1, descL2] = wrapTwoLines(
    meta.description || "A work in progress — description coming soon."
  );
  const langColor = LANG_COLORS[meta.language] || "#8B949E";

  const langGroup = meta.language
    ? `<circle cx="39" cy="153.5" r="5" fill="${langColor}"/>
      <text x="52" y="158" font-size="12.5" fill="${t.stat}">${escapeXml(meta.language)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(
    `${meta.name}. ${meta.description || "No description."} ${meta.language || ""}. ${meta.stars} stars, ${meta.forks} forks.`
  )}" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid meet" text-rendering="geometricPrecision">
  <title>${escapeXml(meta.name)}</title>

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${CARD_W}" y2="${CARD_H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"  stop-color="${t.bgStops[0]}"/>
      <stop offset="55%" stop-color="${t.bgStops[1]}"/>
      <stop offset="100%" stop-color="${t.bgStops[2]}"/>
    </linearGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" fill="none" stroke="${t.grid}" stroke-width="0.6"/>
    </pattern>
    <radialGradient id="glow" cx="12%" cy="0%" r="65%">
      <stop offset="0%"  stop-color="#FF652F" stop-opacity="${t.glowOpacity[0]}"/>
      <stop offset="60%" stop-color="#FF652F" stop-opacity="${t.glowOpacity[1]}"/>
      <stop offset="100%" stop-color="#FF652F" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#FF652F"/>
      <stop offset="100%" stop-color="#FFC857"/>
    </linearGradient>
    <clipPath id="cardClip"><rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" rx="14"/></clipPath>
    <style>@media (prefers-reduced-motion: reduce){ * { animation:none !important; transition:none !important } }</style>
  </defs>

  <g clip-path="url(#cardClip)">
    <rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" fill="url(#bg)"/>
    <rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" fill="url(#grid)" opacity="${t.gridOpacity}"/>
    <rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" fill="url(#glow)"/>
  </g>
  <rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" rx="14" fill="none" stroke="${t.border}" stroke-width="1.5"/>

  <g font-family="Inter, 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif" opacity="0">
    <animate attributeName="opacity" values="0;1" dur="0.5s" begin="0.15s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>

    <text x="32" y="48" font-size="19" font-weight="600" fill="${t.title}" textLength="${titleLength}" lengthAdjust="spacingAndGlyphs"
          font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">${escapeXml(title)}</text>

    <line x1="32" y1="64" x2="568" y2="64" stroke="${t.keyline}" stroke-width="1" opacity="0.8"/>
    <rect x="32" y="62.5" width="0" height="3" rx="1.5" fill="url(#acc)">
      <animate attributeName="width" values="0;80" dur="0.5s" begin="0.5s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1"/>
    </rect>

    <g font-size="13.5" fill="${t.desc}">
      <text x="32" y="94">${escapeXml(descL1)}</text>
      ${descL2 ? `<text x="32" y="116">${escapeXml(descL2)}</text>` : ""}
    </g>

    <g>
      ${langGroup}
      <text x="400" y="158" font-size="13" fill="${t.star}">★</text>
      <text x="418" y="158" font-size="12.5" fill="${t.stat}">${fmtCount(meta.stars)}</text>
      <g stroke="${t.statMuted}" stroke-width="1.6" fill="none">
        <circle cx="478" cy="147" r="2.6"/>
        <circle cx="490" cy="147" r="2.6"/>
        <circle cx="484" cy="159" r="2.6"/>
        <path d="M478 149.6 v1.4 a3 3 0 0 0 3 3 h6 a3 3 0 0 0 3 -3 v-1.4 M484 154 v2.4"/>
      </g>
      <text x="500" y="158" font-size="12.5" fill="${t.stat}">${fmtCount(meta.forks)}</text>
    </g>
  </g>
</svg>
`;
}

// Full-width featured banner in the same visual family as the pinned cards
// (and the retired hand-made featured-card artwork it replaces). Content is
// entirely repo-driven: name, description, language, topics, stars, push date.
function featuredSvg(meta, themeName) {
  const t = THEMES[themeName];
  const [descL1, descL2] = wrapTwoLines(
    meta.description || "A work in progress — description coming soon.",
    105
  );
  const langColor = LANG_COLORS[meta.language] || "#8B949E";
  const slug = `~/${meta.name}`;
  const slugLength = Math.min(Math.round(slug.length * 8.1), 700);

  // Chip row: language first, then up to four topics. textLength pins label
  // widths so the pill padding holds on every platform's fallback font.
  const chipDefs = [];
  if (meta.language) chipDefs.push({ label: meta.language, dot: langColor });
  for (const topic of (meta.topics || []).slice(0, 4)) {
    chipDefs.push({ label: topic, dot: "#FF652F" });
  }
  let cx = 48;
  const chips = chipDefs
    .map(({ label, dot }) => {
      const textLen = Math.ceil(label.length * 7.2);
      const w = textLen + 41;
      if (cx + w > 860) return "";
      const chip = `<rect x="${cx}" y="202" width="${w}" height="28" rx="14" fill="${t.chipFill}" stroke="${t.chipStroke}" stroke-width="1"/>
        <circle cx="${cx + 17.5}" cy="216" r="3.5" fill="${dot}"/>
        <text x="${cx + 29}" y="220.5" textLength="${textLen}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`;
      cx += w + 10;
      return chip;
    })
    .join("\n        ");

  const pushed = meta.pushed
    ? new Date(meta.pushed).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
  const statLine = [`★ ${fmtCount(meta.stars)}`, pushed && `updated ${pushed}`]
    .filter(Boolean)
    .join("  ·  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(
    `Featured project: ${meta.name}. ${meta.description || "No description."} ${meta.language || ""}. ${meta.stars} stars.`
  )}" viewBox="0 0 ${FEAT_W} ${FEAT_H}" width="${FEAT_W}" height="${FEAT_H}" preserveAspectRatio="xMidYMid meet" text-rendering="geometricPrecision">
  <title>Featured Project — ${escapeXml(meta.name)}</title>
  <desc>${themeName === "dark" ? "Dark" : "Light"} featured-project card, auto-generated weekly from the most active repository.</desc>

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${FEAT_W}" y2="${FEAT_H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"  stop-color="${t.bgStops[0]}"/>
      <stop offset="55%" stop-color="${t.bgStops[1]}"/>
      <stop offset="100%" stop-color="${t.bgStops[2]}"/>
    </linearGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" fill="none" stroke="${t.grid}" stroke-width="0.6"/>
    </pattern>
    <radialGradient id="glow" cx="18%" cy="0%" r="60%">
      <stop offset="0%"  stop-color="#FF652F" stop-opacity="${t.glowOpacity[0]}"/>
      <stop offset="60%" stop-color="#FF652F" stop-opacity="${t.glowOpacity[1]}"/>
      <stop offset="100%" stop-color="#FF652F" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#FF652F"/>
      <stop offset="100%" stop-color="#FFC857"/>
    </linearGradient>
    <clipPath id="cardClip"><rect x="1" y="1" width="${FEAT_W - 2}" height="${FEAT_H - 2}" rx="16"/></clipPath>
    <style>@media (prefers-reduced-motion: reduce){ * { animation:none !important; transition:none !important } }</style>
  </defs>

  <g clip-path="url(#cardClip)">
    <rect x="1" y="1" width="${FEAT_W - 2}" height="${FEAT_H - 2}" fill="url(#bg)"/>
    <rect x="1" y="1" width="${FEAT_W - 2}" height="${FEAT_H - 2}" fill="url(#grid)" opacity="${t.gridOpacity}"/>
    <rect x="1" y="1" width="${FEAT_W - 2}" height="${FEAT_H - 2}" fill="url(#glow)"/>
  </g>
  <rect x="1" y="1" width="${FEAT_W - 2}" height="${FEAT_H - 2}" rx="16" fill="none" stroke="${t.border}" stroke-width="1.5"/>

  <g font-family="Inter, 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif" opacity="0">
    <animate attributeName="opacity" values="0;1" dur="0.6s" begin="0.2s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>

    <text x="48" y="44" font-size="11" letter-spacing="1.5" fill="#FF652F"
          font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">FEATURED · MOST ACTIVE BUILD</text>

    <text x="48" y="80" font-size="27" font-weight="800" fill="${t.title}">${escapeXml(meta.name)}</text>
    <text x="1152" y="80" font-size="14" font-weight="500" fill="${t.link}" text-anchor="end" opacity="0">View repository →
      <animate attributeName="opacity" values="0;0.9" dur="0.5s" begin="0.9s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
    </text>
    <text x="48" y="105" font-size="13.5" fill="${t.statMuted}" textLength="${slugLength}" lengthAdjust="spacingAndGlyphs"
          font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">${escapeXml(slug)}</text>

    <line x1="48" y1="120" x2="1152" y2="120" stroke="${t.keyline}" stroke-width="1" opacity="0.9"/>
    <rect x="48" y="118.5" width="0" height="3" rx="1.5" fill="url(#acc)">
      <animate attributeName="width" values="0;120" dur="0.55s" begin="0.6s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1"/>
    </rect>

    <g font-size="16" fill="${t.desc}">
      <text x="48" y="152">${escapeXml(descL1)}</text>
      ${descL2 ? `<text x="48" y="178">${escapeXml(descL2)}</text>` : ""}
    </g>

    <g opacity="0">
      <animate attributeName="opacity" values="0;1" dur="0.5s" begin="0.75s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1"/>
      <g font-size="13" font-weight="500" fill="${t.stat}">
        ${chips}
      </g>
      <text x="1152" y="220.5" font-size="12.5" fill="${t.statMuted}" text-anchor="end"
            font-family="'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace">${escapeXml(statLine)}</text>
    </g>
  </g>
</svg>
`;
}

function featuredBlock(meta) {
  const alt = escapeXml(
    `Featured project: ${meta.name} — ${[
      meta.description,
      meta.language,
      `★ ${fmtCount(meta.stars)}`,
    ]
      .filter(Boolean)
      .join(" · ")}`
  );
  return `<a href="https://github.com/${meta.owner}/${meta.name}"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/featured-card-dark.svg"><img alt="${alt}" src="./assets/featured-card-light.svg" width="100%"></picture></a>`;
}

// The whole anchor stays on one line with no whitespace text nodes inside it:
// GitHub underlines README links, so a stray space or newline inside <a>
// renders as a blue underline hanging off the card.
function pinCard(meta, position) {
  const alt = escapeXml(
    `${meta.name} — ${[meta.language, `★ ${fmtCount(meta.stars)}`].filter(Boolean).join(" · ")}`
  );
  return `  <a href="https://github.com/${meta.owner}/${meta.name}"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/pinned-${position}-dark.svg"><img alt="${alt}" src="./assets/pinned-${position}-light.svg" width="49%"></picture></a>`;
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

  // Rank #1 becomes the featured project; the next two fill the pinned
  // cards, so the featured repo never repeats one card below itself.
  // Fallback: most recently updated repos if activity alone can't fill 3.
  if (top.length < 3) {
    const fallback = await fetchFallbackUpdatedRepos(USERNAME);
    for (const f of fallback) {
      if (f.toLowerCase() === `${USERNAME}/${USERNAME}`.toLowerCase()) continue;
      if (!top.includes(f)) top.push(f);
      if (top.length >= 3) break;
    }
  }

  top = top.slice(0, 3);
  if (top.length === 0) {
    console.warn("No repos to pin; leaving README unchanged.");
    return;
  }
  while (top.length < 3) top.push(top[top.length - 1]);

  const metas = [];
  for (const full of top) {
    const [owner, name] = full.split("/");
    const r = await fetchJson(`https://api.github.com/repos/${owner}/${name}`);
    metas.push({
      owner,
      name,
      description: r.description || "",
      language: r.language || "",
      stars: r.stargazers_count || 0,
      forks: r.forks_count || 0,
      topics: r.topics || [],
      pushed: r.pushed_at || "",
    });
  }

  const [featured, pin1, pin2] = metas;
  const featBody = featuredBlock(featured);
  const body = `<div align="center">\n${pinCard(pin1, 1)}\n${pinCard(
    pin2,
    2
  )}\n</div>`;

  // Only include the card markup inside the marker blocks. The visible
  // headers are kept outside the markers in README.md so we don't
  // overwrite them when the script runs.
  const newBlock = `${START_MARK}\n${body}\n${END_MARK}`;
  const newFeatBlock = `${FEAT_START}\n${featBody}\n${FEAT_END}`;

  const readme = fs.readFileSync(README_PATH, "utf8");
  const i1 = readme.indexOf(START_MARK);
  const i2 = readme.indexOf(END_MARK);
  if (i1 === -1 || i2 === -1)
    throw new Error("PINNED markers not found in README.md");
  const f1 = readme.indexOf(FEAT_START);
  const f2 = readme.indexOf(FEAT_END);
  if (f1 === -1 || f2 === -1)
    throw new Error("FEATURED markers not found in README.md");

  let updated =
    readme.slice(0, i1) + newBlock + readme.slice(i2 + END_MARK.length);
  updated =
    updated.slice(0, updated.indexOf(FEAT_START)) +
    newFeatBlock +
    updated.slice(updated.indexOf(FEAT_END) + FEAT_END.length);

  const dry = process.argv.includes("--dry-run");
  if (dry) {
    console.log("--- DRY RUN: generated featured block ---");
    console.log(newFeatBlock);
    console.log("--- DRY RUN: generated pinned block ---");
    console.log(newBlock);
    console.log("--- end generated blocks ---");
    console.log("Dry run complete. README and assets were NOT modified.");
    return;
  }

  for (const theme of ["dark", "light"]) {
    fs.writeFileSync(
      `${ASSET_DIR}/featured-card-${theme}.svg`,
      featuredSvg(featured, theme),
      "utf8"
    );
  }
  for (const [i, meta] of [pin1, pin2].entries()) {
    for (const theme of ["dark", "light"]) {
      fs.writeFileSync(
        `${ASSET_DIR}/pinned-${i + 1}-${theme}.svg`,
        cardSvg(meta, theme),
        "utf8"
      );
    }
  }

  const preview = process.argv.includes("--preview");
  if (preview) {
    // Write a minimal HTML file to preview the generated block locally
    const previewPath = ".github/scripts/preview.html";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pinned Repos Preview</title></head><body style="font-family:system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; padding:24px;">${newBlock.replaceAll(
      "./assets/",
      "../../assets/"
    )}</body></html>`;
    fs.writeFileSync(previewPath, html, "utf8");
    console.log("Preview written to", previewPath);
    console.log("Open it in your browser to inspect the pinned section.");
    return;
  }

  if (updated !== readme) {
    fs.writeFileSync(README_PATH, updated);
    console.log("Pinned:", top.join(", "));
  } else {
    console.log("Pinned section unchanged (card assets refreshed).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
