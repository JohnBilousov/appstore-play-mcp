import {
  StoreError,
  type AppSummary,
  type Release,
  type Review,
  type ReviewPage,
  type ReviewQuery,
  type Store,
  type StoreClient,
} from "./types.js";

/**
 * Fixtures for a fictional two-app indie developer. Deliberately shows the
 * states that are actually interesting to look at: a version sitting in
 * review, a staged rollout at 20%, and reviews across the rating range.
 */

const APPS: Record<Store, AppSummary[]> = {
  appstore: [
    {
      store: "appstore",
      id: "1234567890",
      bundleId: "com.example.pocketherbarium",
      name: "Pocket Herbarium",
      sku: "PH-IOS",
      primaryLocale: "en-US",
      storeUrl: "https://apps.apple.com/app/id1234567890",
    },
    {
      store: "appstore",
      id: "1234567891",
      bundleId: "com.example.tidepool",
      name: "Tidepool Timer",
      sku: "TT-IOS",
      primaryLocale: "en-US",
      storeUrl: "https://apps.apple.com/app/id1234567891",
    },
  ],
  play: [
    {
      store: "play",
      id: "com.example.pocketherbarium",
      bundleId: "com.example.pocketherbarium",
      name: "Pocket Herbarium",
      storeUrl: "https://play.google.com/store/apps/details?id=com.example.pocketherbarium",
    },
  ],
};

const RELEASES: Record<Store, Record<string, Release[]>> = {
  appstore: {
    "1234567890": [
      {
        store: "appstore",
        appId: "1234567890",
        track: "app-store",
        versionName: "2.1.0",
        buildNumber: "214",
        state: "in_review",
        rawState: "IN_REVIEW",
        createdAt: "2026-08-21T09:12:00-07:00",
      },
      {
        store: "appstore",
        appId: "1234567890",
        track: "app-store",
        versionName: "2.0.3",
        buildNumber: "208",
        state: "live",
        rawState: "READY_FOR_DISTRIBUTION",
        createdAt: "2026-07-30T11:40:00-07:00",
      },
    ],
    "1234567891": [
      {
        store: "appstore",
        appId: "1234567891",
        track: "app-store",
        versionName: "1.4.1",
        buildNumber: "77",
        state: "live",
        rawState: "READY_FOR_DISTRIBUTION",
        createdAt: "2026-06-02T08:05:00-07:00",
      },
    ],
  },
  play: {
    "com.example.pocketherbarium": [
      {
        store: "play",
        appId: "com.example.pocketherbarium",
        track: "production",
        versionName: "2.0.3 (208)",
        buildNumber: "208",
        state: "rolling_out",
        rawState: "inProgress",
        userFraction: 0.2,
        releaseNotes: "Offline plant identification and a faster camera.",
      },
      {
        store: "play",
        appId: "com.example.pocketherbarium",
        track: "beta",
        versionName: "2.1.0 (214)",
        buildNumber: "214",
        state: "live",
        rawState: "completed",
        releaseNotes: "Testing the new herbarium sync.",
      },
    ],
  },
};

const REVIEWS: Record<Store, Record<string, Review[]>> = {
  appstore: {
    "1234567890": [
      {
        store: "appstore",
        appId: "1234567890",
        id: "review-ios-1",
        rating: 5,
        title: "Finally identifies ferns properly",
        body: "Took it on a hike with no signal and it still worked. The offline mode is the whole reason I bought it.",
        author: "fernfriend",
        territory: "USA",
        createdAt: "2026-08-19T14:02:00-07:00",
      },
      {
        store: "appstore",
        appId: "1234567890",
        id: "review-ios-2",
        rating: 2,
        title: "Camera keeps freezing",
        body: "Every third photo the camera locks up and I have to restart the app. iPhone 13, latest iOS.",
        author: "m_kowalski",
        territory: "DEU",
        createdAt: "2026-08-17T07:41:00-07:00",
        developerResponse:
          "Thank you for the report — a fix is in the 2.1.0 build now under review.",
      },
      {
        store: "appstore",
        appId: "1234567890",
        id: "review-ios-3",
        rating: 4,
        title: "Good, wish it had a garden log",
        body: "Identification is accurate. I would pay for a way to keep a log of what is in my own garden.",
        author: "allotment_annie",
        territory: "GBR",
        createdAt: "2026-08-11T18:20:00-07:00",
      },
    ],
    "1234567891": [],
  },
  play: {
    "com.example.pocketherbarium": [
      {
        store: "play",
        appId: "com.example.pocketherbarium",
        id: "review-play-1",
        rating: 1,
        body: "Crashes on open since the last update. Pixel 7.",
        author: "T. Nowak",
        language: "pl",
        device: "Pixel 7",
        appVersion: "2.0.3",
        createdAt: "2026-08-20T10:15:00.000Z",
      },
      {
        store: "play",
        appId: "com.example.pocketherbarium",
        id: "review-play-2",
        rating: 5,
        body: "Better than the paid alternatives. Offline mode is excellent.",
        author: "Sara L.",
        language: "en",
        device: "Samsung Galaxy S24",
        appVersion: "2.0.3",
        createdAt: "2026-08-18T21:03:00.000Z",
      },
    ],
  },
};

export class DemoStoreClient implements StoreClient {
  constructor(readonly store: Store) {}

  async describe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `demo fixtures · ${APPS[this.store].length} app(s)` };
  }

  async listApps(): Promise<AppSummary[]> {
    return APPS[this.store];
  }

  async getApp(appId: string): Promise<AppSummary> {
    const app = APPS[this.store].find(
      (candidate) => candidate.id === appId || candidate.bundleId === appId,
    );
    if (!app)
      throw new StoreError(
        `No ${this.store} app with id ${appId}`,
        this.store,
        404,
        "Call list_apps first.",
      );
    return app;
  }

  async getReleases(appId: string): Promise<Release[]> {
    const app = await this.getApp(appId);
    return RELEASES[this.store][app.id] ?? [];
  }

  async getReviews(appId: string, query: ReviewQuery): Promise<ReviewPage> {
    const app = await this.getApp(appId);
    const all = REVIEWS[this.store][app.id] ?? [];
    const reviews = all
      .filter(
        (review) =>
          review.rating >= (query.minRating ?? 1) && review.rating <= (query.maxRating ?? 5),
      )
      .slice(0, query.limit ?? 25);
    // Fixture sets are small enough to always fit on one page.
    return { reviews };
  }
}
