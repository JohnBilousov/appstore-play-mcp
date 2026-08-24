# appstore-play-mcp

[![CI](https://github.com/JohnBilousov/appstore-play-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnBilousov/appstore-play-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/appstore-play-mcp)](https://www.npmjs.com/package/appstore-play-mcp)
[![license](https://img.shields.io/npm/l/appstore-play-mcp)](./LICENSE)

A **read-only** MCP server for App Store Connect and Google Play. One set of tools over
both stores, so you can ask "what's live, what's in review, and what are people
complaining about?" once instead of twice.

```
> Which of my apps have a release that isn't live yet?

  Pocket Herbarium (App Store)
    app-store: 2.1.0 (214) — in review
  Pocket Herbarium (Google Play)
    production: 2.0.3 (208) — rolling out at 20%
    beta: 2.1.0 (214) — live
```

Built for indie developers who ship to both stores and are tired of two consoles, two
auth schemes, and two vocabularies for the same thing.

**Nothing here writes.** No metadata edits, no submissions, no review replies. Every
tool is annotated `readOnlyHint`, and the test suite fails if that ever stops being true.

## Try it in 30 seconds

No Apple key, no Google service account:

```bash
npx -y appstore-play-mcp --demo
```

Demo mode serves fixtures for a fictional two-app developer — including a version stuck
in review and a staged rollout at 20%, because those are the states worth looking at.

```bash
npx @modelcontextprotocol/inspector npx -y appstore-play-mcp --demo
```

## Tools

| Tool | What it does |
|---|---|
| `stores_health` | Which stores are configured and whether their credentials work. |
| `list_apps` | Every reachable app, both stores, one list. |
| `get_app` | One app by App Store id, Play package name, or bundle id. |
| `get_releases` | What's live, in review, or mid-rollout — one app or the whole portfolio. |
| `get_reviews` | Recent reviews from both stores, merged and sorted. `maxRating: 2` to triage complaints. |

`appId` is optional on `get_releases` and `get_reviews`. Leave it out and the tool
sweeps every app you have — that's the portfolio view.

### One vocabulary for two stores

The App Store has `appStoreVersions` with an `appVersionState`; Play has tracks holding
releases with a `status` and a rollout fraction. Both are normalised:

| Normalised `state` | App Store | Google Play |
|---|---|---|
| `live` | `READY_FOR_DISTRIBUTION` | `completed` |
| `in_review` | `IN_REVIEW`, `WAITING_FOR_REVIEW` | — |
| `pending_developer_release` | `PENDING_DEVELOPER_RELEASE` | — |
| `rejected` | `REJECTED`, `METADATA_REJECTED` | — |
| `rolling_out` | — | `inProgress` with `userFraction < 1` |
| `halted` | — | `halted` |
| `draft` | `PREPARE_FOR_SUBMISSION` | `draft` |

Each store's own wording is preserved in `rawState`, so nothing is lost in translation.

Reviews get the same treatment, with one honest exception: the stores do not report the same
thing about where a review came from, so they do not share a field.

| Field | App Store | Google Play |
|---|---|---|
| `territory` | ISO country (`DEU`, `USA`) | — not exposed |
| `language` | — not exposed | reviewer's language (`pl`, `en`) |
| `device` | — not exposed | device model |
| `appVersion` | — not exposed | version reviewed |

Collapsing a language into a country field would have made the unified shape look tidier and
report something false, so each store fills only what it actually knows.

## Setup

Listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.JohnBilousov/appstore-play-mcp`, so clients that read the registry can find it on
their own.

Either store works on its own — configure one, both, or neither (fixtures).

<details open>
<summary><b>App Store Connect</b></summary>

In App Store Connect → **Users and Access → Integrations → App Store Connect API**,
create a key and download the `.p8` (Apple lets you download it once).

```bash
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export ASC_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
```

The server signs its own ES256 JWT — no fastlane, no extra dependency. `ASC_PRIVATE_KEY`
takes the key inline instead, for CI.

</details>

<details>
<summary><b>Google Play</b></summary>

Create a service account in Google Cloud, enable the **Android Publisher API** for its
project, then grant it access in Play Console → **Users and permissions**.

```bash
export PLAY_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
export PLAY_PACKAGES=com.example.app,com.example.other
```

`PLAY_PACKAGES` is not optional: **the Play API has no endpoint that lists a developer's
apps**, so the packages have to be declared. `PLAY_SERVICE_ACCOUNT_JSON` takes the JSON
inline instead, for CI.

</details>

<details>
<summary><b>MCP client config</b></summary>

```json
{
  "mcpServers": {
    "stores": {
      "command": "npx",
      "args": ["-y", "appstore-play-mcp"],
      "env": {
        "ASC_KEY_ID": "XXXXXXXXXX",
        "ASC_ISSUER_ID": "00000000-0000-0000-0000-000000000000",
        "ASC_KEY_PATH": "/path/to/AuthKey_XXXXXXXXXX.p8",
        "PLAY_SERVICE_ACCOUNT_PATH": "/path/to/service-account.json",
        "PLAY_PACKAGES": "com.example.app"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add stores -- npx -y appstore-play-mcp
```

</details>

## Platform limits worth knowing

These are the stores' constraints, not the server's:

- **Play cannot list your apps.** Hence `PLAY_PACKAGES`.
- **Play reviews go back about a week**, and only exist for apps that have reviews.
- **Play track data is only readable inside an "edit."** Every read here opens a
  transient edit and deletes it in a `finally` block. Nothing is ever committed, so your
  app is not modified — but that is why a read-only server makes a POST.
- **App Store reviews are per-territory** and can lag the store page by a few hours.

## Design notes

**Two credentials, one interface.** `AppStoreClient` and `PlayClient` both implement
`StoreClient`; a `DemoStoreClient` implements it a third time on fixtures. Tools never
branch on which store they are talking to.

**One store failing doesn't sink the call.** Reads fan out across stores and across apps, and
a failure on either axis is collected rather than thrown. If Play is down, App Store reviews
still come back — with the Play failure named in the text and listed in `unavailable`, so the
model can tell the user the answer is partial. An empty list and a broken credential must never
look the same; a test asserts they don't.

**Errors carry the fix.** A `403` from Play says the service account may lack access *or*
the Android Publisher API may be disabled for its project. A `404` says to call
`list_apps`. The model can usually recover without the user intervening.

**Tokens are cached and refreshed early.** ES256 for Apple (20 min), RS256 → OAuth2 for
Google (1 hour), both refreshed a minute before expiry so no call races the boundary. The Play
side also memoizes the in-flight exchange: `listApps()` opens an edit per package concurrently,
and without that, each concurrent caller would see no cached token yet and mint its own.

## Development

```bash
git clone https://github.com/JohnBilousov/appstore-play-mcp && cd appstore-play-mcp
npm install
npm run build
npm test          # tool surface + both auth clients against a mocked fetch, real key material throughout
npm run lint      # eslint
npm run format    # prettier --write
npm run inspect
```

CI runs `typecheck`, `lint`, `format:check`, `test`, and `build` on every push and pull request.

```
src/
  index.ts          CLI entry, stdio transport
  config.ts         env → Config; either store optional, fixtures as the floor
  server.ts         tools + the registry that fans reads across stores
  schemas.ts        zod input and output shapes
  format.ts         human-readable summaries next to structuredContent
  stores/
    types.ts        shared vocabulary + state normalisation
    appstore.ts     App Store Connect (ES256 JWT)
    play.ts         Google Play (service account → OAuth2)
    demo.ts         fixtures
test/
  server.test.ts    tool surface, state normalisation, portfolio sweeps — over a real MCP transport
  stores/
    appstore.test.ts  ES256 signing verified against the public key, token caching, error mapping
    play.test.ts       RS256/OAuth2 exchange, the transient-edit cleanup, the concurrency fix above
```

## Releasing

Bump the version in `package.json`, `server.json`, and `VERSION` in `src/server.ts` together (a
test asserts they can't drift), commit, push, then publish a GitHub Release with a matching
`vX.Y.Z` tag. That triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which runs the test suite and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements)
— the package page shows a verified link back to this exact commit and workflow run, not just a
name on the registry.

## Roadmap

- [ ] Sales and download reports from App Store Connect (needs a vendor number)
- [ ] Crash and ANR vitals from the Play Developer Reporting API
- [ ] TestFlight builds and tester groups
- [ ] Streamable HTTP transport alongside stdio

Contributions welcome — especially from anyone who ships to both stores and has hit a
limit worth documenting here.

## License

MIT © Ivan Bilousov
