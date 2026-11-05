// update-manifest.mjs: write the latest.json that tauri-plugin-updater reads.
//
// One manifest serves every platform, so it is written once, after both builds, from their
// bundle directories:
//
//   TAG=v0.1.6 DOWNLOAD_BASE=https://downloads.hopshot.xyz \
//   WINDOWS_DIR=dist/windows MACOS_DIR=dist/macos \
//   node scripts/update-manifest.mjs
//
// Writes latest.json into the current directory (or OUT, if set).
//
// DOWNLOAD_BASE is where the installers will actually be served from. It is not GitHub:
// this repo is private, and private releases 404 for anyone without a token — which an
// installed app never has. Downloads live on our own domain instead, which also keeps the
// business docs in this repo private and gives us download counts.
//
// Both platforms are required. A manifest missing one would tell every install on that
// platform there is nothing new, silently — better to fail the release than to strand them.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.env.TAG;
// Trailing slashes would produce a double slash in the URL, which R2 treats as a different
// key and serves as 404.
const base = (process.env.DOWNLOAD_BASE ?? "").replace(/\/+$/, "");
const windowsDir = process.env.WINDOWS_DIR;
const macosDir = process.env.MACOS_DIR;
if (!tag || !base || !windowsDir || !macosDir) {
  throw new Error("Set TAG, DOWNLOAD_BASE, WINDOWS_DIR and MACOS_DIR");
}

/**
 * The update payload in `dir` and its detached minisign signature.
 *
 * Its signature's absence means the signing key never reached the build — publishing a
 * manifest without one would ship an update that every install refuses, which is worse than
 * shipping no update at all.
 */
function payload(dir, suffix, what) {
  const file = readdirSync(dir).find((name) => name.endsWith(suffix));
  if (!file) throw new Error(`No *${suffix} in ${dir}. Is that the ${what} bundle directory?`);

  let signature;
  try {
    signature = readFileSync(join(dir, `${file}.sig`), "utf8").trim();
  } catch {
    throw new Error(`No ${file}.sig. Is TAURI_SIGNING_PRIVATE_KEY set in the repository secrets?`);
  }
  if (!signature) throw new Error(`${file}.sig is empty`);

  /*
   * Version-qualified rather than a bare filename, so an older install downloading its
   * update can never be handed a newer binary than the manifest it read. The manifest itself
   * lives at the stable /latest.json.
   */
  return { signature, url: `${base}/${tag}/${file}` };
}

/*
 * Windows: for NSIS, Tauri signs the installer itself — there is no separate archive. The
 * bundle directory holds exactly `Hopshot_<version>_x64-setup.exe` and its `.sig`.
 *
 * macOS: the updater cannot use the .dmg. It swaps the app bundle in place from
 * `Hopshot.app.tar.gz`, which Tauri writes (with its `.sig`) when createUpdaterArtifacts is on.
 */
const windows = payload(windowsDir, "-setup.exe", "NSIS");
const macos = payload(macosDir, ".app.tar.gz", "macOS");

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: "See the release notes.",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": windows,
    // One universal binary runs on both, so both architectures get the same archive.
    "darwin-aarch64": macos,
    "darwin-x86_64": macos,
  },
};

const out = process.env.OUT ?? "latest.json";
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${out} -> ${manifest.version}`);
for (const [platform, { url }] of Object.entries(manifest.platforms)) {
  console.log(`  ${platform}: ${url}`);
}
