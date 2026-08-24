# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning
follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-08-24

### Added
- Cursor pagination on `get_reviews`: both clients return `nextCursor` when more results exist —
  the App Store's `links.next` (a full URL, fetched as-is) and Play's `tokenPagination.nextPageToken`
  (round-tripped through a `token` query parameter). A cursor is rejected when it would apply to
  more than one resolved app, since "next page" isn't well-defined for a portfolio sweep.
- CI on Node 20, 22, and 24 (typecheck, lint, format check, test, build) on every push and pull
  request.
- A provenance-signed npm publish workflow, triggered by a GitHub Release.
- 41 network-layer tests for both auth clients: real EC/RSA keys generated per run, signatures
  verified against the matching public key with `node:crypto`, token caching and refresh-at-skew,
  HTTP error mapping, and the Play transient-edit cleanup.
- Review title and body are now explicitly marked as untrusted input: a `SECURITY` note on
  `get_reviews`'s description, annotated schema fields, and every response wraps the reviewer's own
  text in `« »` with a one-line reminder not to treat it as instructions.
- ESLint and Prettier, wired into CI.
- `CHANGELOG.md` and `SECURITY.md`. GitHub private vulnerability reporting is now enabled on the repo.

### Changed
- `Review.territory` (App Store, an ISO country) and `Review.language` (Play, the reviewer's
  language) are now separate fields — they used to share `territory`, silently mislabelling a
  language as a country on the Play side.

### Fixed
- `minRating`/`maxRating` are now actually applied on live data. Both parameters were accepted by
  the tool's input schema and threaded into both clients, but neither client read them — only the
  demo fixtures filtered by rating. The tool description has said "set maxRating to 2 to triage
  complaints" since 0.1.0; against a real backend it did nothing.
- A rejected/unreachable store no longer produces a silent partial answer indistinguishable from an
  app that genuinely has no data. `Registry.resolve()` used to swallow a `listApps()` failure;
  failures are now collected into a new `unavailable` field and named in the response text.
- Two bugs specific to Play, found while adding network-layer tests: a token-fetch race under
  concurrent `Promise.all` (each concurrent caller could see no cached token yet and mint its own),
  and `getApp()` swallowing a fully dead credential behind the same fallback used for "the listing
  title lookup failed" — meaning `listApps()` could return placeholder-named apps instead of
  throwing on a broken credential.
- An already-typed `StoreError` thrown from `bearer()` is no longer re-wrapped with a generic
  "request failed" message on either client, which used to leak the class name into text meant for
  a person.

## [0.1.2] - 2026-08-24

### Fixed
- Registry namespace corrected to `io.github.JohnBilousov/appstore-play-mcp` — the MCP Registry
  grants and verifies the namespace case-sensitively, and the lowercase form was rejected on both
  counts.

## [0.1.1] - 2026-08-24

### Added
- `server.json` for listing on the [MCP Registry](https://registry.modelcontextprotocol.io).

## [0.1.0] - 2026-08-24

Initial release.

### Added
- Five read-only tools unifying App Store Connect and Google Play: `stores_health`, `list_apps`,
  `get_app`, `get_releases`, `get_reviews`.
- Release state normalised across both stores (`live`, `in_review`, `rolling_out`, `rejected`,
  `draft`, `halted`, `pending_developer_release`), with the store's own wording kept in `rawState`.
- Zero-dependency auth for both stores: ES256 JWT signing for App Store Connect, RS256 service
  account → OAuth2 for Google Play.
- Demo mode (`STORES_DEMO=1` or no credentials set): fixtures for a two-app developer, including a
  version in review and a staged rollout.
