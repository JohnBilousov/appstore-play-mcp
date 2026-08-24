import crypto from "node:crypto";

import type { PlayCredentials } from "../config.js";
import {
  StoreError,
  normalizePlayState,
  type AppSummary,
  type Release,
  type Review,
  type ReviewQuery,
  type StoreClient,
} from "./types.js";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_SKEW_MS = 60_000;
const APP_CACHE_TTL_MS = 5 * 60_000;

function base64url(input: crypto.BinaryLike): string {
  return Buffer.from(input as never)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

interface PlayEdit {
  id: string;
}

interface PlayTrackRelease {
  name?: string;
  versionCodes?: string[];
  status?: string;
  userFraction?: number;
  releaseNotes?: Array<{ language?: string; text?: string }>;
}

/**
 * Google Play. Two quirks shape this client:
 *
 * 1. There is no endpoint that lists a developer's apps, so packages come from
 *    configuration.
 * 2. Track and listing data is only readable inside an "edit". Every read here
 *    opens a transient edit and deletes it again in a finally block — nothing
 *    is ever committed, so the app is not modified.
 */
export class PlayClient implements StoreClient {
  readonly store = "play" as const;
  private token?: { value: string; expiresAt: number };
  private appCache?: { at: number; apps: AppSummary[] };

  constructor(
    private readonly credentials: PlayCredentials,
    private readonly timeoutMs = 20_000,
  ) {}

  private async bearer(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > now) return this.token.value;

    const issuedAt = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({
        iss: this.credentials.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + TOKEN_TTL_SECONDS,
      }),
    );
    const signingInput = `${header}.${claim}`;

    let assertion: string;
    try {
      const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), this.credentials.privateKey);
      assertion = `${signingInput}.${base64url(signature)}`;
    } catch (error) {
      throw new StoreError(
        `Could not sign a token with the Play service account: ${error instanceof Error ? error.message : error}`,
        "play",
        0,
        "The service account JSON must contain the full private_key, newlines included.",
      );
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!payload.access_token) {
      throw new StoreError(
        `Play refused the service account: ${payload.error_description ?? payload.error ?? "no access_token"}`,
        "play",
        response.status,
        "Check that the service account is linked in Play Console under Users and permissions, and that the Android Publisher API is enabled for its project.",
      );
    }

    this.token = { value: payload.access_token, expiresAt: now + TOKEN_TTL_SECONDS * 1000 };
    return payload.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : String(error);
      throw new StoreError(`Play request failed: ${reason}`, "play");
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        (parsed as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
      throw new StoreError(message, "play", response.status, hintFor(response.status));
    }
    return parsed as T;
  }

  /** Opens an edit, runs the read, and always deletes the edit afterwards. */
  private async withEdit<T>(packageName: string, read: (editId: string) => Promise<T>): Promise<T> {
    const edit = await this.request<PlayEdit>("POST", `/applications/${encodeURIComponent(packageName)}/edits`, {});
    try {
      return await read(edit.id);
    } finally {
      await this.request("DELETE", `/applications/${encodeURIComponent(packageName)}/edits/${edit.id}`).catch(
        () => undefined,
      );
    }
  }

  private assertKnown(packageName: string): void {
    if (!this.credentials.packages.includes(packageName)) {
      throw new StoreError(
        `${packageName} is not in PLAY_PACKAGES`,
        "play",
        404,
        `The Play API cannot discover apps. Add it to PLAY_PACKAGES (currently: ${this.credentials.packages.join(", ") || "empty"}).`,
      );
    }
  }

  async describe(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.bearer();
      return {
        ok: true,
        detail: `${this.credentials.clientEmail} · ${this.credentials.packages.length} package(s)`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async listApps(): Promise<AppSummary[]> {
    const now = Date.now();
    if (this.appCache && now - this.appCache.at < APP_CACHE_TTL_MS) return this.appCache.apps;

    const apps = await Promise.all(this.credentials.packages.map((pkg) => this.getApp(pkg)));
    this.appCache = { at: now, apps };
    return apps;
  }

  async getApp(packageName: string): Promise<AppSummary> {
    this.assertKnown(packageName);
    // The store listing title is the only human-readable name Play exposes.
    const name = await this.withEdit(packageName, async (editId) => {
      const listings = await this.request<{ listings?: Array<{ language?: string; title?: string }> }>(
        "GET",
        `/applications/${encodeURIComponent(packageName)}/edits/${editId}/listings`,
      ).catch(() => ({ listings: [] }));
      return listings.listings?.[0]?.title;
    }).catch(() => undefined);

    return {
      store: "play",
      id: packageName,
      bundleId: packageName,
      name: name ?? packageName,
      storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
    };
  }

  async getReleases(packageName: string): Promise<Release[]> {
    this.assertKnown(packageName);
    const tracks = await this.withEdit(packageName, (editId) =>
      this.request<{ tracks?: Array<{ track?: string; releases?: PlayTrackRelease[] }> }>(
        "GET",
        `/applications/${encodeURIComponent(packageName)}/edits/${editId}/tracks`,
      ),
    );

    const releases: Release[] = [];
    for (const track of tracks.tracks ?? []) {
      for (const release of track.releases ?? []) {
        releases.push({
          store: "play",
          appId: packageName,
          track: track.track ?? "unknown",
          versionName: release.name ?? "—",
          buildNumber: release.versionCodes?.[0],
          state: normalizePlayState(release.status, release.userFraction),
          rawState: release.status ?? "unknown",
          userFraction: release.userFraction,
          releaseNotes: release.releaseNotes?.[0]?.text,
        });
      }
    }
    return releases;
  }

  async getReviews(packageName: string, query: ReviewQuery): Promise<Review[]> {
    this.assertKnown(packageName);
    const limit = Math.min(query.limit ?? 25, 100);
    const payload = await this.request<{
      reviews?: Array<{
        reviewId?: string;
        authorName?: string;
        comments?: Array<{
          userComment?: {
            text?: string;
            starRating?: number;
            reviewerLanguage?: string;
            device?: string;
            appVersionName?: string;
            lastModified?: { seconds?: string };
          };
          developerComment?: { text?: string };
        }>;
      }>;
    }>("GET", `/applications/${encodeURIComponent(packageName)}/reviews?maxResults=${limit}`);

    return (payload.reviews ?? []).map((review) => {
      const user = review.comments?.find((comment) => comment.userComment)?.userComment;
      const developer = review.comments?.find((comment) => comment.developerComment)?.developerComment;
      const seconds = user?.lastModified?.seconds ? Number(user.lastModified.seconds) : undefined;

      return {
        store: "play" as const,
        appId: packageName,
        id: review.reviewId ?? "",
        rating: user?.starRating ?? 0,
        body: user?.text ?? "",
        author: review.authorName || undefined,
        territory: user?.reviewerLanguage || undefined,
        device: user?.device || undefined,
        appVersion: user?.appVersionName || undefined,
        createdAt: seconds ? new Date(seconds * 1000).toISOString() : undefined,
        developerResponse: developer?.text || undefined,
      };
    });
  }
}

function hintFor(status: number): string {
  switch (status) {
    case 401:
      return "The OAuth token was rejected. Re-check the service account JSON.";
    case 403:
      return "The service account lacks access to this app, or the Android Publisher API is disabled for its Google Cloud project. The message above usually names which.";
    case 404:
      return "No such package, or the service account cannot see it. Check PLAY_PACKAGES and the Play Console permissions.";
    case 429:
      return "Play is rate limiting. Wait a moment before retrying.";
    default:
      return "See the message above from the Play API.";
  }
}
