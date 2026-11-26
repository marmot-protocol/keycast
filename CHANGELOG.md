# Changelog

All components use one [SemVer](docs/development/releases.md) version.

## 2.1.0 — 2026-11-26

Stable release of the Keycast v2 remote signer with a redesigned operator workspace, end-to-end
security and reliability hardening, and updated Rust and JavaScript dependencies.

### Highlights

- Redesigned web workspace combining key-centric management with a cross-key **Connections** view, a
  unified **Signing Log & Diagnostics** view (durable audit trail plus bounded in-memory
  pre-admission drops), opt-in display of revoked/expired grants, and human-readable invitation and
  session labels.
- Fixed NIP-46 bunker and `nostrconnect://` sign-in persistence across page reloads using
  tab-scoped `sessionStorage` with a 12-hour TTL, strict handshake verification, and explicit
  sign-out zeroization, alongside tightened CSP, route protection, and key-import secret guards.
- Removed `wss://relay.damus.io` from default relays (keeping `wss://nos.lol` and
  `wss://relay.primal.net`), accepted `"params": null` in NIP-46 requests so `nak` `switch_relays`
  works cleanly, and added Bech32 `npub1...` support alongside 64-character hex pubkeys in
  `ALLOWED_PUBKEYS` and `KEYCAST_OPERATOR_PUBKEYS` (#13).
- Hardened signer admission, policy capability bounds, clock-skew-safe lifecycle timestamps,
  restore/backup verification, API gateway validation and `/ready` admission, host operations
  scripts, Dockerfile runtime separation (`api-runtime` no longer carries migrations or DB env),
  release-profile overflow checks, and least-privilege CI/Docker publishing workflows.
- Updated Rust, Bun (`1.4.5`), base images, and web dependencies (`applesauce-*` v7, SvelteKit
  `3.4.1`, `url 2.5.9`, `zeroize 1.9.2`), resolving `RUSTSEC-2026-0592` and `GHSA-fc5q-39xc-vjpf`.

### Installation and upgrades

Official artifacts are **Linux AMD64 containers** for Docker Compose. Use all three digests from
this release's `release.json`/`images.env`. Exact image tags are `v2.1.0`; as a stable release,
`v2` and `latest` advance to `v2.1.0`.

Upgrading from `2.0.0-rc.1` or recent v2 `master` builds is supported in place: back up before
upgrading, retain your previous three-image manifest, and run `sudo scripts/upgrade_preflight.sh`.
Additive migration `0006_remove_damus_default_relay.sql` removes the old default `relay.damus.io`
entry on instances that have not customized it while preserving existing custom relay sets and
grants. New installations initialized with `scripts/init.sh` store persistent state under `./state`
(`KEYCAST_STATE_DIR=./state`), while existing deployments omitting `KEYCAST_STATE_DIR` continue to
resolve to the checkout without disruption. `scripts/upgrade_preflight.sh` now fails closed if `gh`
is missing for provenance verification (pass `--skip-provenance` explicitly to bypass) and enforces
credential and database permissions even without `--fix-permissions`.

Original Keycast/V1 databases, encrypted keys, authorization rows, credentials, and bunker URLs
remain incompatible. An image rollback is safe only when the older release supports the resulting
database schema and configuration; [backup restoration](https://github.com/marmot-protocol/keycast/blob/v2.1.0/docs/backup-and-recovery.md#recovery-after-loss-or-rollback)
revokes old grants, invitations, and sessions and requires review and re-pairing. Never regenerate
an existing root credential to resolve an upgrade problem.

### Known limitations

Keycast targets a small, single-host instance and has not received an independent third-party
security audit. Remaining operational and compatibility items are tracked in
[TODO.md](https://github.com/marmot-protocol/keycast/blob/v2.1.0/TODO.md) and
[AUDIT.md](https://github.com/marmot-protocol/keycast/blob/v2.1.0/AUDIT.md). A release and its
automated checks do not establish the health of a deployed instance.

## 2.0.0-rc.1 — 2026-09-10

The first numbered release of the rebuilt Keycast remote signer. This is a release candidate for
self-hosters and early users; stable `2.0.0` follows feedback and the stable release checks.

### Highlights

- A single multiplexed NIP-46 signer with shared relays, per-key relay routing, durable request/reply
  handling, bounded resource admission, and readiness reporting.
- Team workspaces, encrypted key storage, invitations, sessions, and strict policies enforced by
  the signer. The public API communicates over a private Unix socket and cannot load the root key.
- A searchable policy editor with customizable use cases for notes and replies, long form publishing,
  NIP-17 direct messages, Marmot messaging, and many other Nostr capabilities. NIP-04 and NIP-44
  encryption/decryption permissions are separate controls. Existing saved policies retain their meaning.
- Sign-in/sign-out updates immediately, plus operator status, audit history, encrypted backup,
  recovery, and root-key rotation tools.
- Reorganized user, deployment, architecture, and contributor guides with real application screenshots.
- Numbered releases with version/commit metadata, provenance-verified image digests, and a matching
  deployment bundle. API, signer, and web are released together.

### Installation and upgrades

Official artifacts are **Linux AMD64 containers** for Docker Compose. No native binaries or additional
platform builds are distributed. Use all three digests from this release's `release.json`/`images.env`.
Exact image tags are `v2.0.0-rc.1`; this prerelease does not change `v2` or `latest`.

A fresh installation is recommended for evaluating the release candidate. Original Keycast/V1
storage, encrypted keys, authorization rows, credentials, and bunker URLs are incompatible; there
is no V1 migration. Existing deployments of the rebuilt V2 code should back up before upgrading,
review the additive migrations and [hardening steps](https://github.com/marmot-protocol/keycast/blob/v2.0.0-rc.1/docs/upgrading.md),
and retain their previous three-image manifest. Release metadata adds no database migration or
policy format change relative to the immediately preceding master build.

An image rollback is safe only when the older software supports the resulting database and configuration.
[Backup restoration](https://github.com/marmot-protocol/keycast/blob/v2.0.0-rc.1/docs/backup-and-recovery.md#recovery-after-loss-or-rollback)
revokes old grants, invitations, and sessions and requires review and re-pairing. Never regenerate
an existing root credential to resolve an upgrade problem.

### Known limitations

Keycast targets a small, single-host instance. It has not received an independent security audit.
Relay timeout/admission findings, real host fault recovery, and broader external-signer/client
compatibility checks remain tracked in [TODO.md](https://github.com/marmot-protocol/keycast/blob/v2.0.0-rc.1/TODO.md).
A release and its automated checks do not establish the health of a deployed instance.
