import fs from "fs";

/**
 * Experience metric updater
 * -------------------------
 * Mirrors how ma.codes derives "years of experience": whole years elapsed from
 * the creation date of the FIRST repository on the GitHub account up to today.
 *
 * The first-repo date is a fixed historical fact, so it is stored here as a
 * single constant (the private repo `ChatWeb`, created 2022-04-04). No GitHub
 * API token or private-repo access is needed at runtime. If you ever create or
 * import an even older repository, update ONLY this one value (or set the
 * EXPERIENCE_ANCHOR env var).
 */
const ANCHOR = process.env.EXPERIENCE_ANCHOR || "2022-04-04T22:45:26Z";

const FILES = [
  "assets/metrics-strip-dark.svg",
  "assets/metrics-strip-light.svg",
];

// Whole (completed) years between `fromIso` and `now`, UTC — i.e. floor of the
// elapsed duration, so it ticks up on each anniversary of the first repo.
function wholeYears(fromIso, now) {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) throw new Error(`Invalid EXPERIENCE_ANCHOR: ${fromIso}`);
  let y = now.getUTCFullYear() - from.getUTCFullYear();
  const m = now.getUTCMonth() - from.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < from.getUTCDate())) y--;
  return y;
}

const years = wholeYears(ANCHOR, new Date());
const value = `${years} yrs`;

// Matches the EXPERIENCE tile's value text (tagged with data-metric="experience").
const RE = /(<text[^>]*\bdata-metric="experience"[^>]*>)([^<]*)(<\/text>)/;

let changed = 0;
for (const file of FILES) {
  const svg = fs.readFileSync(file, "utf8");
  if (!RE.test(svg)) {
    console.error(`ERROR: no data-metric="experience" marker found in ${file}`);
    process.exitCode = 1;
    continue;
  }
  const next = svg.replace(RE, (_, open, _old, close) => `${open}${value}${close}`);
  if (next !== svg) {
    fs.writeFileSync(file, next);
    console.log(`Updated ${file} -> "${value}"`);
    changed++;
  } else {
    console.log(`${file} already shows "${value}"`);
  }
}

console.log(`Experience: "${value}" (anchor ${ANCHOR}); ${changed} file(s) changed.`);
