import crypto from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayClient } from "../../src/stores/play.js";

// Must match the private TOKEN_URL constant in src/stores/play.ts.
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(fromBase64Url(value).toString("utf8"));
}

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as Response;
}

function emptyResponse(status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => "" } as Response;
}

let clientEmail: string;
let privateKeyPem: string;
let publicKey: crypto.KeyObject;

beforeAll(() => {
  // The service account JSON carries an RSA key; generate a real one so the
  // RS256 signing path (and the OAuth2 exchange around it) runs for real.
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  publicKey = pub;
  clientEmail = "play-publisher@test-project.iam.gserviceaccount.com";
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

function client(packages: string[], overrides: Partial<{ clientEmail: string; privateKey: string }> = {}) {
  return new PlayClient({ clientEmail, privateKey: privateKeyPem, packages, ...overrides });
}

function tokenCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
}

/** One full getApp(): token exchange, open edit, read listing, delete edit. */
function queueGetApp(accessToken = "tok-1") {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(200, { access_token: accessToken, expires_in: 3600 }))
    .mockResolvedValueOnce(jsonResponse(200, { id: "edit-1" }))
    .mockResolvedValueOnce(jsonResponse(200, { listings: [{ language: "en-US", title: "Example App" }] }))
    .mockResolvedValueOnce(emptyResponse(204));
}

describe("PlayClient — OAuth2 token exchange", () => {
  it("signs an RS256 JWT assertion that verifies against the matching public key", async () => {
    queueGetApp();

    await client(["com.example.app"]).getApp("com.example.app");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TOKEN_URL);
    const assertion = (init.body as URLSearchParams).get("assertion")!;
    const [header, claim, signature] = assertion.split(".");

    expect(decodeJwtPart(header!)).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(decodeJwtPart(claim!)).toMatchObject({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: TOKEN_URL,
    });

    const verified = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claim}`),
      publicKey,
      fromBase64Url(signature!),
    );
    expect(verified).toBe(true);
  });

  it("reuses one cached token across edits for multiple packages", async () => {
    queueGetApp();
    queueGetApp(); // token call in here would be extra if caching failed

    await client(["com.example.app", "com.other.app"]).listApps();

    expect(tokenCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(7); // 1 token + 2×(edit + listing + delete)
  });

  it("mints a new token once the 60-second refresh skew is crossed", async () => {
    vi.useFakeTimers();
    queueGetApp("tok-1");
    queueGetApp("tok-2");

    const c = client(["com.example.app"]);
    await c.getApp("com.example.app");
    vi.setSystemTime(Date.now() + 3600_000 - 30_000); // TTL is 1h, skew is 60s
    await c.getApp("com.example.app");

    expect(tokenCalls()).toHaveLength(2);
  });

  it("does not re-wrap a signing failure as a generic request failure", async () => {
    const broken = client(["com.example.app"], { privateKey: "not a real PEM key" });

    // Regression: request()'s catch block used to wrap *any* thrown error,
    // turning "Could not sign a token…" into "Play request failed: StoreError: …".
    await expect(broken.getApp("com.example.app")).rejects.toThrow(/^Could not sign a token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PlayClient — the transient edit is never left uncommitted", () => {
  it("deletes the edit even when the nested read fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "edit-1" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: "internal error" } })) // tracks read fails
      .mockResolvedValueOnce(emptyResponse(204)); // cleanup DELETE must still fire

    await expect(client(["com.example.app"]).getReleases("com.example.app")).rejects.toThrow();

    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(deleteCall, "the edit must be deleted even though the read inside it failed").toBeDefined();
    expect((deleteCall![0] as string)).toContain("/edits/edit-1");
  });
});

describe("PlayClient — guards and error mapping", () => {
  it("rejects a package outside PLAY_PACKAGES before touching the network", async () => {
    await expect(client(["com.example.app"]).getReleases("com.unknown.app")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("PLAY_PACKAGES"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the Play error message with a 403 hint", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "tok-1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "edit-1" }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { message: "The caller does not have permission" } }))
      .mockResolvedValueOnce(emptyResponse(204));

    await expect(client(["com.example.app"]).getReleases("com.example.app")).rejects.toMatchObject({
      status: 403,
      message: "The caller does not have permission",
      hint: expect.stringContaining("Android Publisher API"),
    });
  });
});

describe("PlayClient — app list cache", () => {
  it("serves a second listApps() from cache without opening a new edit", async () => {
    queueGetApp();

    const c = client(["com.example.app"]);
    await c.listApps();
    await c.listApps();

    expect(fetchMock).toHaveBeenCalledTimes(4); // only the first call touched the network
  });
});
