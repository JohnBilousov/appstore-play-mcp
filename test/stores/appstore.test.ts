import crypto from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppStoreClient } from "../../src/stores/appstore.js";
import { StoreError } from "../../src/stores/types.js";

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(fromBase64Url(value).toString("utf8"));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let keyId: string;
let issuerId: string;
let privateKeyPem: string;
let publicKey: crypto.KeyObject;

beforeAll(() => {
  // A real .p8 is a PKCS8 EC private key on the P-256 curve — generate one so
  // the ES256 signing path runs for real instead of being mocked away.
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = pub;
  keyId = "TESTKEY001";
  issuerId = "11111111-2222-3333-4444-555555555555";
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client(overrides: Partial<{ keyId: string; issuerId: string; privateKey: string }> = {}) {
  return new AppStoreClient({ keyId, issuerId, privateKey: privateKeyPem, ...overrides });
}

describe("AppStoreClient — token signing", () => {
  it("signs an ES256 JWT that verifies against the matching public key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await client().listApps();

    const [, init] = fetchMock.mock.calls[0]!;
    const auth = (init.headers as Record<string, string>).Authorization;
    const [header, payload, signature] = auth.replace(/^Bearer /, "").split(".");

    expect(decodeJwtPart(header!)).toMatchObject({ alg: "ES256", kid: keyId, typ: "JWT" });
    expect(decodeJwtPart(payload!)).toMatchObject({ iss: issuerId, aud: "appstoreconnect-v1" });

    const verified = crypto.verify(
      "SHA256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      fromBase64Url(signature!),
    );
    expect(verified).toBe(true);
  });

  it("reuses the same token across calls inside the TTL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

    const c = client();
    await c.listApps();
    await c.listApps();

    const [firstAuth] = fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization);
    const [secondAuth] = fetchMock.mock.calls.slice(1).map(([, init]) => (init.headers as Record<string, string>).Authorization);
    expect(firstAuth).toBe(secondAuth);
    expect(fetchMock).toHaveBeenCalledTimes(2); // two HTTP calls, one signature
  });

  it("mints a new token once the 60-second refresh skew is crossed", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

    const c = client();
    await c.listApps();
    const first = (fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization;

    // Token TTL is 20 minutes; cross the 60s-early refresh boundary.
    vi.setSystemTime(Date.now() + 20 * 60_000 - 30_000);
    await c.listApps();
    const second = (fetchMock.mock.calls[1]![1].headers as Record<string, string>).Authorization;

    expect(second).not.toBe(first);
  });

  it("does not re-wrap a signing failure with a generic network message", async () => {
    const broken = client({ privateKey: "not a real PEM key" });

    await expect(broken.listApps()).rejects.toMatchObject({
      name: "StoreError",
      status: 0,
    });
    // The finding this guards against: get()'s catch block used to wrap
    // *any* thrown error, turning "Could not sign a token…" into
    // "App Store request failed: StoreError: Could not sign a token…".
    await expect(broken.listApps()).rejects.toThrow(/^Could not sign a token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AppStoreClient — HTTP error mapping", () => {
  it("extracts the detail message and a hint from a 401 response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { errors: [{ status: "401", title: "Unauthenticated", detail: "The token is expired" }] }),
    );

    await expect(client().listApps()).rejects.toMatchObject({
      name: "StoreError",
      status: 401,
      message: "The token is expired",
    });
  });

  it("falls back to a bare status when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    await expect(client().listApps()).rejects.toMatchObject({ status: 500, message: "HTTP 500" });
  });

  it("reports a timeout distinctly from a signature or HTTP failure", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const promise = client(undefined).listApps();
    const settled = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  });
});

describe("AppStoreClient — response parsing", () => {
  it("resolves a release's build number through the included builds relationship", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: "v1",
            type: "appStoreVersions",
            attributes: { versionString: "2.1.0", appVersionState: "READY_FOR_DISTRIBUTION" },
            relationships: { build: { data: { id: "b1", type: "builds" } } },
          },
        ],
        included: [{ id: "b1", type: "builds", attributes: { version: "214" } }],
      }),
    );

    const [release] = await client().getReleases("123");
    expect(release).toMatchObject({ versionName: "2.1.0", buildNumber: "214", state: "live" });
  });

  it("resolves a developer's reply through the included response relationship", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: "r1",
            type: "customerReviews",
            attributes: { rating: 2, body: "Crashes on launch" },
            relationships: { response: { data: { id: "resp1", type: "customerReviewResponses" } } },
          },
        ],
        included: [
          { id: "resp1", type: "customerReviewResponses", attributes: { responseBody: "Fixed in 2.1.1, thanks!" } },
        ],
      }),
    );

    const [review] = await client().getReviews("123", {});
    expect(review!.developerResponse).toBe("Fixed in 2.1.1, thanks!");
  });
});
