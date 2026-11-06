# TODOS

## Licensing

### Phase 2: 7-day phone trial

**What:** Give every install a server-enforced 7-day trial of the phone features (send to phone, share links, vault, pairing), stored in a new additive `phone_trials` table.

**Why:** Phase 1 (free shelf) makes the phone feature $19 or nothing. A trial lets strangers feel the phone bridge, the part worth paying for, before they buy.

**Context:** Designed and eng-reviewed in `docs/designs/free-shelf-phone-trial.md` (2026-11-06). Approved: D3 (separate `phone_trials` table, no `licenses` rebuild), D4/E1 (vault owner from the token's bound install, never the `X-Hopshot-Install` header), D5/E2 (no token re-issue), T-REG (regression contract), D2 (no VaultHub 4402 close). Before implementing, resolve the outside-voice amendments listed under "Outside-voice findings: dispositions after D8" in that doc:
- #1: never overwrite a paid `LICENSE_TOKEN` (separate keychain slot, or skip registration when a token exists).
- #2: `deviceStatus` / `GET /license/status` need the trial fallback and `expiresAt`.
- #3: make registration idempotent with a client-generated secret.
- #4: clamp vault-item TTL for trials.
- #5: bucket IPv6 by /64 before hashing.
- #8, #9, #11, #12, #13, #15.
- #10: add a launch/periodic licence recheck in Rust.

E3 (when the trial clock starts) is reopened.

**Effort:** L
**Priority:** P2
**Depends on:** Phase 1 (free shelf) shipped, plus the day-7 answers from the founder's 6 comp users, or about 20 organic installs.

## Completed
