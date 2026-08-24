import { z } from "zod";

export const storeFilter = z
  .enum(["appstore", "play", "both"])
  .optional()
  .describe("Which store to read. Defaults to every store that is configured");

export const appIdArg = z
  .string()
  .optional()
  .describe(
    "App Store numeric id, Play package name, or bundle id. Omit to cover every configured app",
  );

export const listAppsShape = { store: storeFilter };

export const getAppShape = {
  appId: z.string().describe("App Store numeric id, Play package name, or bundle id"),
  store: storeFilter,
};

export const getReleasesShape = { appId: appIdArg, store: storeFilter };

export const getReviewsShape = {
  appId: appIdArg,
  store: storeFilter,
  limit: z.number().int().min(1).max(100).optional().describe("Reviews per app, newest first (default 25)"),
  minRating: z.number().int().min(1).max(5).optional().describe("Only reviews at or above this star rating"),
  maxRating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Only reviews at or below this rating. Set to 2 to triage complaints"),
};

const appShape = z.object({
  store: z.string(),
  id: z.string(),
  bundleId: z.string(),
  name: z.string(),
  sku: z.string().optional(),
  primaryLocale: z.string().optional(),
  storeUrl: z.string().optional(),
});

export const listAppsOutput = { count: z.number(), apps: z.array(appShape) };

export const getReleasesOutput = {
  count: z.number(),
  releases: z.array(
    z.object({
      store: z.string(),
      appId: z.string(),
      appName: z.string().optional(),
      track: z.string(),
      versionName: z.string(),
      buildNumber: z.string().optional(),
      state: z.string(),
      rawState: z.string(),
      userFraction: z.number().optional(),
      releaseNotes: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
};

export const getReviewsOutput = {
  count: z.number(),
  averageRating: z.number().nullable(),
  reviews: z.array(
    z.object({
      store: z.string(),
      appId: z.string(),
      appName: z.string().optional(),
      id: z.string(),
      rating: z.number(),
      title: z.string().optional(),
      body: z.string(),
      author: z.string().optional(),
      territory: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
      createdAt: z.string().optional(),
      developerResponse: z.string().optional(),
    }),
  ),
};

export const healthOutput = {
  mode: z.string(),
  stores: z.array(z.object({ store: z.string(), ok: z.boolean(), detail: z.string() })),
};
