// update-manifest.mjs: write the latest.json that tauri-plugin-updater reads.
//
// Run from the NSIS bundle directory after `tauri build`, with TAG (e.g. "v0.1.2") and
// DOWNLOAD_BASE in the environment. Emits latest.json next to the artifacts.
//
// DOWNLOAD_BASE is where the installer will actually be served from. It is not GitHub:
// this repo is private, and private releases 404 for anyone without a token — which an
// installed app never has. Downloads live on our own domain instead, which also keeps the
// business docs in this repo private and gives us download counts.
//
// Kept out of the workflow YAML so it can be run locally against a real build:
//
//   cd apps/desktop/src-tauri/target/release/bundle/nsis
//   TAG=v0.1.2 DOWNLOAD_BASE=https://downloads.hopshot.xyz node ../../../../../../scripts/update-manifest.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const tag = process.env.TAG;
// Trailing slashes would produce a double slash in the URL, which R2 treats as a different
// key and serves as 404.
const base = (process.env.DOWNLOAD_BASE ?? "").replace(/\/+$/, "");
if (!tag || !base) throw new Error("Set TAG and DOWNLOAD_BASE");

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
      /*
       * Version-qualified rather than a bare filename, so an older install downloading its
       * update can never be handed a newer binary than the manifest it read. The manifest
       * itself lives at the stable /latest.json.
       */
      url: `${base}/${tag}/${installer}`,
    },
  },
};

writeFileSync("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json -> ${manifest.version}`);
console.log(manifest.platforms["windows-x86_64"].url);
