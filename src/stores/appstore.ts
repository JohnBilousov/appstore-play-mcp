import crypto from "node:crypto";

import type { AppStoreCredentials } from "../config.js";
import {
  StoreError,
  normalizeAppStoreState,
  type AppSummary,
  type Release,
  type ReviewPage,
  type ReviewQuery,
  type StoreClient,
} from "./types.js";

const API = "https://api.appstoreconnect.apple.com";
const TOKEN_TTL_SECONDS = 20 * 60;
/** Refresh a minute early so a call never races the expiry. */
const TOKEN_SKEW_MS = 60_000;

function base64url(input: crypto.BinaryLike): string {
  return Buffer.from(input as never)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

interface JsonApiResponse {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  /** `next`, when present, is a full URL — fetch it as-is for the next page. */
  links?: { next?: string };
  errors?: Array<{ title?: string; detail?: string; status?: string }>;
}

/** App Store Connect, authenticated with an ES256 JWT signed from a .p8 key. */
export class AppStoreClient implements StoreClient {
  readonly store = "appstore" as const;
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly credentials: AppStoreCredentials,
    private readonly timeoutMs = 20_000,
  ) {}

  private bearer(): string {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > now) return this.token.value;

    const issuedAt = Math.floor(now / 1000);
    const header = base64url(
      JSON.stringify({ alg: "ES256", kid: this.credentials.keyId, typ: "JWT" }),
    );
    const payload = base64url(
      JSON.stringify({
        iss: this.credentials.issuerId,
        iat: issuedAt,
        exp: issuedAt + TOKEN_TTL_SECONDS,
        aud: "appstoreconnect-v1",
      }),
    );
    const signingInput = `${header}.${payload}`;

    let signature: Buffer;
    try {
      signature = crypto.sign("SHA256", Buffer.from(signingInput), {
        key: this.credentials.privateKey,
        dsaEncoding: "ieee-p1363",
      });
    } catch (error) {
      throw new StoreError(
        `Could not sign a token with the App Store key: ${error instanceof Error ? error.message : error}`,
        "appstore",
        0,
        "ASC_KEY_PATH must point at the .p8 file downloaded from App Store Connect, contents included.",
      );
    }

    const value = `${signingInput}.${base64url(signature)}`;
    this.token = { value, expiresAt: now + TOKEN_TTL_SECONDS * 1000 };
    return value;
  }

  private async get(path: string): Promise<JsonApiResponse> {
    // A pagination cursor from a previous response's links.next is already a
    // complete URL — fetching `${API}${path}` against it would double it up.
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.bearer()}` },
        signal: controller.signal,
      });
    } catch (error) {
      // bearer() already throws a StoreError with its own hint; re-wrapping it
      // would leak the class name into text meant for a person.
      if (error instanceof StoreError) throw error;
      const reason =
        error instanceof Error && error.name === "AbortError" ? "timed out" : String(error);
      throw new StoreError(`App Store request failed: ${reason}`, "appstore");
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => ({}))) as JsonApiResponse;
    if (!response.ok) {
      const first = body.errors?.[0];
      const message = first?.detail ?? first?.title ?? `HTTP ${response.status}`;
      throw new StoreError(message, "appstore", response.status, hintFor(response.status));
    }
    return body;
  }

  async describe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const apps = await this.listApps();
      return { ok: true, detail: `key ${this.credentials.keyId} · ${apps.length} app(s)` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async listApps(): Promise<AppSummary[]> {
    const body = await this.get("/v1/apps?limit=200");
    const data = Array.isArray(body.data) ? body.data : [];
    return data.map((resource) => toAppSummary(resource));
  }

  async getApp(appId: string): Promise<AppSummary> {
    const body = await this.get(`/v1/apps/${encodeURIComponent(appId)}`);
    const data = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!data) throw new StoreError(`No App Store app with id ${appId}`, "appstore", 404);
    return toAppSummary(data);
  }

  async getReleases(appId: string): Promise<Release[]> {
    const body = await this.get(
      `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?limit=5&include=build`,
    );
    const data = Array.isArray(body.data) ? body.data : [];
    const builds = new Map(
      (body.included ?? []).filter((r) => r.type === "builds").map((r) => [r.id, r]),
    );

    return data.map((version) => {
      const attributes = version.attributes ?? {};
      const rawState = String(attributes.appVersionState ?? attributes.appStoreState ?? "UNKNOWN");
      const buildId = version.relationships?.build?.data?.id;
      const buildNumber = buildId
        ? (builds.get(buildId)?.attributes?.version as string | undefined)
        : undefined;

      return {
        store: "appstore" as const,
        appId,
        track: "app-store",
        versionName: String(attributes.versionString ?? "—"),
        buildNumber,
        state: normalizeAppStoreState(rawState),
        rawState,
        createdAt: attributes.createdDate as string | undefined,
      };
    });
  }

  async getReviews(appId: string, query: ReviewQuery): Promise<ReviewPage> {
    const limit = Math.min(query.limit ?? 25, 200);
    // A cursor is already the full next-page URL; only build a fresh query on
    // the first page.
    const path =
      query.cursor ??
      `/v1/apps/${encodeURIComponent(appId)}/customerReviews?limit=${limit}&sort=-createdDate&include=response`;
    const body = await this.get(path);
    const data = Array.isArray(body.data) ? body.data : [];
    const responses = new Map(
      (body.included ?? [])
        .filter((r) => r.type === "customerReviewResponses")
        .map((r) => [r.id, String(r.attributes?.responseBody ?? "")]),
    );

    const minRating = query.minRating ?? 1;
    const maxRating = query.maxRating ?? 5;
    const reviews = data
      .map((review) => {
        const attributes = review.attributes ?? {};
        const responseId = review.relationships?.response?.data?.id;
        return {
          store: "appstore" as const,
          appId,
          id: review.id,
          rating: Number(attributes.rating ?? 0),
          title: (attributes.title as string) || undefined,
          body: String(attributes.body ?? ""),
          author: (attributes.reviewerNickname as string) || undefined,
          territory: (attributes.territory as string) || undefined,
          createdAt: attributes.createdDate as string | undefined,
          developerResponse: responseId ? responses.get(responseId) : undefined,
        };
      })
      // The API has no rating filter of its own; it's applied client-side,
      // same as the demo fixtures already did.
      .filter((review) => review.rating >= minRating && review.rating <= maxRating);

    return { reviews, nextCursor: body.links?.next };
  }
}

function toAppSummary(resource: JsonApiResource): AppSummary {
  const attributes = resource.attributes ?? {};
  return {
    store: "appstore",
    id: resource.id,
    bundleId: String(attributes.bundleId ?? ""),
    name: String(attributes.name ?? ""),
    sku: (attributes.sku as string) || undefined,
    primaryLocale: (attributes.primaryLocale as string) || undefined,
    storeUrl: `https://apps.apple.com/app/id${resource.id}`,
  };
}

function hintFor(status: number): string {
  switch (status) {
    case 401:
      return "The App Store token was rejected. Check ASC_KEY_ID, ASC_ISSUER_ID, and that the .p8 belongs to that key.";
    case 403:
      return "The key is valid but lacks permission for this resource. Check the API key's role in App Store Connect.";
    case 404:
      return "No such app or resource. Call list_apps to see what this key can reach.";
    case 429:
      return "App Store Connect is rate limiting. Wait a moment before retrying.";
    default:
      return "See the App Store Connect API status and the message above.";
  }
}
