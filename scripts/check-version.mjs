// check-version.mjs: one version, four files.
//
// The download button broke because `download.astro` kept its own copy of the version. The
// URL it builds contains the version twice over — in the tag and in the asset filename — so
// any drift between the site and the release is a 404 on the one page that has to work.
//
// `apps/desktop/src-tauri/tauri.conf.json` is the source of truth, because that is what names
// the installer. This fails if anything disagrees with it.
//
//   node scripts/check-version.mjs            # the files agree with each other
//   node scripts/check-version.mjs v0.2.0     # ...and with the tag being released
//
// Runs in CI on every push, so a mismatch is a red build rather than a broken download page.

import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const truth = read("apps/desktop/src-tauri/tauri.conf.json").version;
if (!truth) throw new Error("tauri.conf.json has no version");

const found = {
  "apps/desktop/src-tauri/tauri.conf.json": truth,
  "apps/desktop/package.json": read("apps/desktop/package.json").version,
  // Cargo.toml is not JSON, and the version is the first `version = "…"` under [package].
  "apps/desktop/src-tauri/Cargo.toml": readFileSync(
    "apps/desktop/src-tauri/Cargo.toml",
    "utf8",
  ).match(/^version\s*=\s*"([^"]+)"/m)?.[1],
};

const tag = process.argv[2];
if (tag) {
  // `v0.2.0` -> `0.2.0`. A tag without the v is accepted; the workflow always passes one with.
  found["the git tag"] = tag.replace(/^v/, "");
}

const wrong = Object.entries(found).filter(([, version]) => version !== truth);

if (wrong.length > 0) {
  console.error(`Version mismatch. tauri.conf.json says ${truth}, but:\n`);
  for (const [where, version] of wrong) {
    console.error(`  ${where}: ${version ?? "not found"}`);
  }
  console.error(
    "\nBump every one of them together. The installer filename comes from tauri.conf.json,",
  );
  console.error("and the download page builds its URL from the same number.");
  process.exit(1);
}

console.log(`version ${truth} — ${Object.keys(found).length} places agree`);
