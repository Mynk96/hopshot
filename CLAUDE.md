# CLAUDE.md — Hopshot

Hopshot is a small Mac + Windows screenshot app. Hotkey → region capture → floating **shelf** → drag into any app/website, copy, or send to a phone. Everything expires, and cloud copies are end-to-end encrypted.

## Read these first

- `PRD.md` — what to build and why (requirement IDs like F2.4 are referenced in tasks)
- `docs/ARCHITECTURE.md` — stack, folder layout, API, schemas, crypto format. **Follow it exactly unless told otherwise.**
- `docs/DESIGN.md` + `design/mockups.html` — tokens, components, states and copy. The mockups are the visual target.
- `BUILD_PLAN.md` — the current phase and its definition of done.

## Repo map

```
apps/desktop      Tauri v2 app (React UI in src/, Rust in src-tauri/)
apps/web          Astro site: landing, /d/:id viewer, /pair, /app PWA
services/api      Cloudflare Worker (Hono) + D1 + R2 + Durable Objects
packages/crypto   HOP1 envelope in TS + test-vectors.json (shared with Rust)
packages/shared   API types + limits loader
config/limits.json   ← the ONLY place plan limits live
marketing/           pre-launch landing page (static, deployed by Cloudflare Pages from marketing/site), demo assets, posts
```

`marketing/` is hand-maintained and live in production. Don't change it unless a task says so. The root `wrangler.jsonc` deploys `marketing/site` to hopshot.xyz on every push to `main`. Don't modify or replace it; the API Worker gets its own config in `services/api/`.

## Commands

```bash
pnpm i                                  # install all workspaces
pnpm -F desktop tauri dev               # run desktop app
pnpm -F desktop tauri build             # release build for this OS
pnpm -F api dev                         # wrangler dev (local D1/R2)
pnpm -F api test                        # vitest (workers pool)
pnpm -F api db:migrate:local            # apply D1 migrations locally
pnpm -F web dev                         # astro dev
pnpm -F web test                        # vitest + playwright
pnpm -F crypto test
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
pnpm lint && pnpm typecheck             # all TS packages
```

## Rules

1. **Privacy invariants (never break):**
   - Plaintext images, file names and keys never leave the device except as HOP1 ciphertext.
   - Keys only travel in URL **fragments** (`#…`). Never log `location.hash`, never put keys in query strings, headers, analytics or error reports.
   - The server stores only ciphertext plus hashed tokens.
2. **Limits come from `config/limits.json`.** No magic numbers for plan limits anywhere.
3. **Rust owns logic; the UI is thin.** `commands.rs` only validates input and delegates to modules. There is no business logic in React beyond view state.
4. **Cross-platform code** goes behind `platform/macos.rs` and `platform/windows.rs` with `#[cfg(target_os = …)]`. Every platform-specific change must compile for both targets (`cargo check --target x86_64-pc-windows-msvc` / `aarch64-apple-darwin` in CI).
5. **No new dependencies** without a one-line justification in the PR/commit message. Prefer official Tauri plugins.
6. **UI must match `docs/DESIGN.md` tokens.** Use the CSS variables and Tailwind theme mapped from them; no ad-hoc colors. Support light/dark and reduced motion.
7. **Errors:** Rust uses `thiserror` in modules and `anyhow` only at the edges. Errors shown to users use the microcopy in DESIGN.md §5. Never `unwrap()` outside tests.
8. **Tests are required** for: crop math, HOP1 crypto (must pass `packages/crypto/test-vectors.json`), expiry/capacity, every API route (happy path + limit + auth + expired).
9. **Keep it small.** If a task tempts you to add something from PRD §3.3 (non-goals), stop and ask.
10. **Secrets** go to the OS keychain via `secrets.rs`, never into `settings.json` or SQLite.

## Working style for each task

1. Read the relevant PRD requirement IDs and ARCHITECTURE sections.
2. For anything larger than one file, propose a short plan first (files to touch, approach, risks).
3. Implement in small commits. Run the relevant tests, `cargo clippy` and the TS typecheck before saying you're done.
4. Finish with: what changed, how to test it manually on **both** macOS and Windows, and any follow-ups.

## Known platform gotchas

- **macOS:** transparent windows need `macOSPrivateApi: true`. The overlay must sit at `NSScreenSaverWindowLevel` with `canJoinAllSpaces | fullScreenAuxiliary` to appear over full-screen apps and the menu bar. Check Screen Recording permission with `CGPreflightScreenCaptureAccess`; without it, captures come back as wallpaper only. macOS may re-prompt for this permission periodically.
- **macOS shelf** must not steal focus: use an NSPanel (non-activating), e.g. via `tauri-nspanel`, or equivalent style mask.
- **Windows:** per-monitor DPI differs between monitors, so always crop using that monitor's scale factor. The shelf needs `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`.
- **Drag-out:** use `@crabnebula/tauri-plugin-drag` with a real file in `drag/` that has a friendly name.
- **iOS PWA:** home-screen apps don't share storage with Safari, so pairing must be completed inside the installed app (built-in QR scanner).
- **Microsoft Store build:** Cargo feature `store` disables the updater; package as MSIX with the `winapp` CLI.
