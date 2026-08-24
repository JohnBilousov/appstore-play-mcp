import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Config } from "./config.js";
import { formatApps, formatReleases, formatReviews } from "./format.js";
import {
  getAppShape,
  getReleasesOutput,
  getReleasesShape,
  getReviewsOutput,
  getReviewsShape,
  healthOutput,
  listAppsOutput,
  listAppsShape,
} from "./schemas.js";
import { AppStoreClient } from "./stores/appstore.js";
import { DemoStoreClient } from "./stores/demo.js";
import { PlayClient } from "./stores/play.js";
import { StoreError, type AppSummary, type Release, type Review, type Store, type StoreClient } from "./stores/types.js";

export const VERSION = "0.1.1";

export type StoreFilter = "appstore" | "play" | "both" | undefined;

export function createClients(config: Config): StoreClient[] {
  if (config.demo) return [new DemoStoreClient("appstore"), new DemoStoreClient("play")];
  const clients: StoreClient[] = [];
  if (config.appStore) clients.push(new AppStoreClient(config.appStore, config.timeoutMs));
  if (config.play) clients.push(new PlayClient(config.play, config.timeoutMs));
  return clients;
}

function toErrorResult(error: unknown): CallToolResult {
  if (error instanceof StoreError) {
    const where = error.store === "config" ? "Configuration" : error.store === "play" ? "Google Play" : "App Store";
    const hint = error.hint ? `\n${error.hint}` : "";
    return { isError: true, content: [{ type: "text", text: `${where} error${error.status ? ` (${error.status})` : ""}: ${error.message}${hint}` }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Unexpected failure: ${message}` }] };
}

async function run(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return toErrorResult(error);
  }
}

/**
 * Fans a read out across the configured stores. One store failing does not
 * sink the whole call — the failure comes back as a note alongside whatever
 * the other store returned, because a Play outage should not hide App Store
 * reviews.
 */
class Registry {
  constructor(private readonly clients: StoreClient[]) {}

  select(filter: StoreFilter): StoreClient[] {
    if (!filter || filter === "both") return this.clients;
    const matched = this.clients.filter((client) => client.store === filter);
    if (matched.length === 0) {
      throw new StoreError(
        `The ${filter === "play" ? "Google Play" : "App Store"} side is not configured.`,
        "config",
        0,
        filter === "play"
          ? "Set PLAY_SERVICE_ACCOUNT_PATH and PLAY_PACKAGES."
          : "Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH.",
      );
    }
    return matched;
  }

  get stores(): Store[] {
    return this.clients.map((client) => client.store);
  }

  async each<T>(
    filter: StoreFilter,
    read: (client: StoreClient) => Promise<T[]>,
  ): Promise<{ items: T[]; notes: string[] }> {
    const results = await Promise.allSettled(this.select(filter).map((client) => read(client)));
    const items: T[] = [];
    const notes: string[] = [];
    results.forEach((result, index) => {
      const client = this.select(filter)[index]!;
      if (result.status === "fulfilled") items.push(...result.value);
      else {
        const reason = result.reason;
        notes.push(`${client.store}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    });
    if (items.length === 0 && notes.length > 0) {
      throw new StoreError(notes.join(" · "), "config");
    }
    return { items, notes };
  }

  /** Resolves an id, package name, or bundle id to concrete apps. */
  async resolve(filter: StoreFilter, appId?: string): Promise<Array<{ client: StoreClient; app: AppSummary }>> {
    const pairs: Array<{ client: StoreClient; app: AppSummary }> = [];
    for (const client of this.select(filter)) {
      const apps = await client.listApps().catch(() => [] as AppSummary[]);
      for (const app of apps) {
        if (!appId || app.id === appId || app.bundleId === appId) pairs.push({ client, app });
      }
    }
    if (pairs.length === 0) {
      throw new StoreError(
        appId ? `Nothing matched "${appId}".` : "No apps are reachable with the current credentials.",
        "config",
        404,
        "Call list_apps to see what is visible. On Play, apps must be named in PLAY_PACKAGES.",
      );
    }
    return pairs;
  }
}

export function createServer(config: Config, clients: StoreClient[] = createClients(config)): McpServer {
  const registry = new Registry(clients);

  const server = new McpServer(
    { name: "appstore-play-mcp", version: VERSION },
    {
      instructions: [
        "Read-only access to App Store Connect and Google Play through one set of tools.",
        "Release state and reviews are normalised across both stores, so ask once and get both sides.",
        "Nothing here writes: no metadata edits, no submissions, no replies.",
        config.demo ? "Running on demo fixtures — no real store is being contacted." : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
  );

  server.registerTool(
    "stores_health",
    {
      title: "Check store credentials",
      description:
        "Report which stores are configured and whether their credentials work. Call this first when something returns nothing.",
      outputSchema: healthOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const stores = await Promise.all(
          clients.map(async (client) => ({ store: client.store, ...(await client.describe()) })),
        );
        const text = stores.length
          ? stores.map((entry) => `${entry.ok ? "ok" : "failing"}  ${entry.store}: ${entry.detail}`).join("\n")
          : "No store is configured.";
        return {
          content: [{ type: "text", text: `${config.demo ? "Demo mode.\n" : ""}${text}` }],
          structuredContent: { mode: config.demo ? "demo" : "live", stores },
        };
      }),
  );

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description:
        "Every app reachable with the configured credentials, from both stores. The App Store side is discovered automatically; the Play side comes from PLAY_PACKAGES, because the Play API cannot enumerate a developer's apps.",
      inputSchema: listAppsShape,
      outputSchema: listAppsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ store }) =>
      run(async () => {
        const { items, notes } = await registry.each(store, (client) => client.listApps());
        const text = [formatApps(items), ...notes.map((note) => `\n(unavailable — ${note})`)].join("");
        return { content: [{ type: "text", text }], structuredContent: { count: items.length, apps: items } };
      }),
  );

  server.registerTool(
    "get_app",
    {
      title: "Get one app",
      description: "Details for a single app, found by App Store id, Play package name, or bundle id.",
      inputSchema: getAppShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appId, store }) =>
      run(async () => {
        const pairs = await registry.resolve(store, appId);
        const apps = pairs.map((pair) => pair.app);
        return {
          content: [{ type: "text", text: formatApps(apps) }],
          structuredContent: { count: apps.length, apps },
        };
      }),
  );

  server.registerTool(
    "get_releases",
    {
      title: "Get release state",
      description:
        "What is live, what is in review, and what is mid-rollout — for one app or the whole portfolio. States are normalised across stores: 'live', 'in_review', 'pending_developer_release', 'rejected', 'draft', 'rolling_out', 'halted'. The store's own wording is kept in rawState. Reading Play tracks opens a temporary edit and deletes it again; nothing is committed.",
      inputSchema: getReleasesShape,
      outputSchema: getReleasesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appId, store }) =>
      run(async () => {
        const pairs = await registry.resolve(store, appId);
        const settled = await Promise.allSettled(
          pairs.map(async ({ client, app }) =>
            (await client.getReleases(app.id)).map((release) => ({ ...release, appName: app.name })),
          ),
        );
        const releases: Array<Release & { appName: string }> = [];
        const notes: string[] = [];
        settled.forEach((result, index) => {
          if (result.status === "fulfilled") releases.push(...result.value);
          else notes.push(`${pairs[index]!.app.name}: ${String(result.reason?.message ?? result.reason)}`);
        });

        const text = [formatReleases(releases), ...notes.map((note) => `\n(unavailable — ${note})`)].join("");
        return { content: [{ type: "text", text }], structuredContent: { count: releases.length, releases } };
      }),
  );

  server.registerTool(
    "get_reviews",
    {
      title: "Get user reviews",
      description:
        "Recent user reviews from both stores in one list, newest first. Omit appId to sweep the whole portfolio, and set maxRating to 2 to triage complaints. Note the platform limits: Google Play only returns reviews from roughly the last week, and only for apps that have any.",
      inputSchema: getReviewsShape,
      outputSchema: getReviewsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appId, store, limit, minRating, maxRating }) =>
      run(async () => {
        const pairs = await registry.resolve(store, appId);
        const settled = await Promise.allSettled(
          pairs.map(async ({ client, app }) =>
            (await client.getReviews(app.id, { limit, minRating, maxRating })).map((review) => ({
              ...review,
              appName: app.name,
            })),
          ),
        );

        const reviews: Array<Review & { appName: string }> = [];
        const notes: string[] = [];
        settled.forEach((result, index) => {
          if (result.status === "fulfilled") reviews.push(...result.value);
          else notes.push(`${pairs[index]!.app.name}: ${String(result.reason?.message ?? result.reason)}`);
        });

        reviews.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        const average =
          reviews.length > 0 ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;

        const text = [formatReviews(reviews), ...notes.map((note) => `\n(unavailable — ${note})`)].join("");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            count: reviews.length,
            averageRating: average === null ? null : Math.round(average * 100) / 100,
            reviews,
          },
        };
      }),
  );

  return server;
}
