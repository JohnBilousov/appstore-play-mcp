/**
 * One vocabulary for two stores. App Store Connect and Google Play model the
 * same concepts differently — an "appStoreVersion" with an `appStoreState`
 * versus a "track" holding "releases" with a `status` — so everything is
 * normalised here and the store-specific payload is kept under `raw` for
 * anyone who needs the original.
 */

export type Store = "appstore" | "play";

export interface AppSummary {
  store: Store;
  /** ASC: numeric app id. Play: the package name. */
  id: string;
  bundleId: string;
  name: string;
  sku?: string;
  primaryLocale?: string;
  storeUrl?: string;
}

export type ReleaseState =
  | "live"
  | "in_review"
  | "pending_developer_release"
  | "rejected"
  | "draft"
  | "rolling_out"
  | "halted"
  | "other";

export interface Release {
  store: Store;
  appId: string;
  /** ASC: "app-store". Play: "production" | "beta" | "alpha" | "internal". */
  track: string;
  versionName: string;
  buildNumber?: string;
  /** Normalised state — see `rawState` for the store's own wording. */
  state: ReleaseState;
  rawState: string;
  /** Staged rollout share on Play, 0-1. Absent on the App Store. */
  userFraction?: number;
  releaseNotes?: string;
  createdAt?: string;
}

export interface Review {
  store: Store;
  appId: string;
  id: string;
  rating: number;
  title?: string;
  body: string;
  author?: string;
  /** ISO country the review was left in. App Store only — Play does not expose it. */
  territory?: string;
  /** Language the review was written in. Play only — reported instead of a country. */
  language?: string;
  device?: string;
  appVersion?: string;
  createdAt?: string;
  developerResponse?: string;
}

export interface ReviewQuery {
  limit?: number;
  minRating?: number;
  maxRating?: number;
}

export interface StoreClient {
  readonly store: Store;
  /** Human-readable identity of the credentials in use, for the health tool. */
  describe(): Promise<{ ok: boolean; detail: string }>;
  listApps(): Promise<AppSummary[]>;
  getApp(appId: string): Promise<AppSummary>;
  getReleases(appId: string): Promise<Release[]>;
  getReviews(appId: string, query: ReviewQuery): Promise<Review[]>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly store: Store | "config",
    readonly status = 0,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Maps an ASC appStoreState / appVersionState onto the shared vocabulary. */
export function normalizeAppStoreState(state: string | undefined): ReleaseState {
  switch (state) {
    case "READY_FOR_SALE":
    case "READY_FOR_DISTRIBUTION":
      return "live";
    case "IN_REVIEW":
    case "WAITING_FOR_REVIEW":
    case "WAITING_FOR_EXPORT_COMPLIANCE":
      return "in_review";
    case "PENDING_DEVELOPER_RELEASE":
      return "pending_developer_release";
    case "REJECTED":
    case "DEVELOPER_REJECTED":
    case "METADATA_REJECTED":
    case "INVALID_BINARY":
      return "rejected";
    case "PREPARE_FOR_SUBMISSION":
    case "DEVELOPER_REMOVED_FROM_SALE":
      return "draft";
    default:
      return "other";
  }
}

/** Maps a Play release status (plus rollout share) onto the shared vocabulary. */
export function normalizePlayState(status: string | undefined, userFraction?: number): ReleaseState {
  switch (status) {
    case "completed":
      return "live";
    case "inProgress":
      return userFraction !== undefined && userFraction < 1 ? "rolling_out" : "live";
    case "halted":
      return "halted";
    case "draft":
      return "draft";
    default:
      return "other";
  }
}
