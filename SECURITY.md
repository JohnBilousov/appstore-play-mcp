# Security Policy

## Supported versions

Only the latest published version on [npm](https://www.npmjs.com/package/appstore-play-mcp) is
supported. Please upgrade before reporting an issue.

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/JohnBilousov/appstore-play-mcp/security/advisories/new)
(Security tab → "Report a vulnerability") rather than a public issue. You should get a response
within a few days.

## Scope and design notes

- **Credentials never leave the process except to their own API.** The App Store `.p8` key signs
  JWTs locally with `node:crypto`; the Play service account key does the same for its RS256
  assertion. Neither key is ever sent anywhere but `api.appstoreconnect.apple.com` and
  `oauth2.googleapis.com` respectively.
- **This server is read-only by design.** No tool edits metadata, submits a build for review, or
  replies to a review. The one place it writes anything is Google Play's edit workflow — reading
  track data requires opening a transient "edit," which is deleted again in a `finally` block
  whether the read succeeded or not, and is never committed. `annotations.readOnlyHint` is `true`
  on every registered tool, and a test asserts that stays true.
- **Review text is untrusted input.** A review's title and body are written by anonymous users of
  the app and returned verbatim to whichever model is calling this server — a natural prompt
  injection vector. `get_reviews`'s description carries an explicit warning, the schema fields are
  annotated, and every response wraps reviewer text in `« »` as a visible boundary. If you build on
  top of this server, don't strip that wrapping before the text reaches a model.
- **`PLAY_PACKAGES` and `ASC_KEY_ID`/`ASC_ISSUER_ID` are trusted input**, not attacker-controlled —
  they come from whoever configures the server, the same as the key material itself.
- Dependencies are limited to `@modelcontextprotocol/sdk` and `zod`; both auth clients use the
  platform `fetch` and `node:crypto` directly, no third-party HTTP or JWT library.
