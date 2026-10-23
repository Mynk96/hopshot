// update-manifest.mjs: write the latest.json that tauri-plugin-updater reads.
//
// Run from the NSIS bundle directory after `tauri build`, with TAG (e.g. "v0.1.2") and REPO
// ("owner/name") in the environment. Emits latest.json next to the artifacts.
//
// Kept out of the workflow YAML so it can be run locally against a real build:
//
//   cd apps/desktop/src-tauri/target/release/bundle/nsis
//   TAG=v0.1.2 REPO=Mynk96/hopshot node ../../../../../../scripts/update-manifest.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const tag = process.env.TAG;
const repo = process.env.REPO;
if (!tag || !repo) throw new Error("Set TAG and REPO");

/*
 * For NSIS, Tauri signs the installer itself — there is no separate archive. Confirmed
 * against a real `tauri build --bundles nsis`: the bundle directory holds exactly
 * `Hopshot_<version>_x64-setup.exe` and `…-setup.exe.sig`, nothing else.
 */
const installer = readdirSync(".").find((name) => name.endsWith("-setup.exe"));
if (!installer) {
  throw new Error("No *-setup.exe here. Run this from the NSIS bundle directory.");
}

/*
 * The detached minisign signature Tauri writes next to the archive. Its absence means the
 * signing key never reached the build — publishing a manifest without one would ship an
 * update that every install refuses, which is worse than shipping no update at all.
 */
let signature;
try {
  signature = readFileSync(`${installer}.sig`, "utf8").trim();
} catch {
  throw new Error(
    `No ${installer}.sig. Is TAURI_SIGNING_PRIVATE_KEY set in the repository secrets?`,
  );
}
if (!signature) throw new Error(`${installer}.sig is empty`);

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: "See the release notes.",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    // The only target Hopshot ships today. macOS joins this when it compiles at all.
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${installer}`,
    },
  },
};

writeFileSync("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json -> ${manifest.version}`);
console.log(manifest.platforms["windows-x86_64"].url);
