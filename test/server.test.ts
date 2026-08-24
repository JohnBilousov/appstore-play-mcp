import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../src/config.js";
import { VERSION, createServer } from "../src/server.js";
import { normalizeAppStoreState, normalizePlayState } from "../src/stores/types.js";

async function connectDemoClient() {
  const config = loadConfig({ STORES_DEMO: "1" } as NodeJS.ProcessEnv);
  const server = createServer(config);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("config", () => {
  it("runs on fixtures when no credential is present", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).demo).toBe(true);
  });

  it("accepts one store on its own", () => {
    const config = loadConfig({
      ASC_KEY_ID: "K",
      ASC_ISSUER_ID: "I",
      ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----",
    } as NodeJS.ProcessEnv);
    expect(config.demo).toBe(false);
    expect(config.appStore).toBeDefined();
    expect(config.play).toBeUndefined();
  });

  it("names the missing half instead of failing vaguely", () => {
    expect(() => loadConfig({ ASC_KEY_ID: "K" } as NodeJS.ProcessEnv)).toThrow(/ASC_ISSUER_ID/);
    expect(() =>
      loadConfig({ PLAY_SERVICE_ACCOUNT_JSON: '{"client_email":"a","private_key":"b"}' } as NodeJS.ProcessEnv),
    ).toThrow(/PLAY_PACKAGES/);
    expect(() => loadConfig({ PLAY_PACKAGES: "com.a" } as NodeJS.ProcessEnv)).toThrow(/service account/i);
  });
});

describe("state normalisation", () => {
  it("maps both stores onto one vocabulary", () => {
    expect(normalizeAppStoreState("READY_FOR_DISTRIBUTION")).toBe("live");
    expect(normalizeAppStoreState("IN_REVIEW")).toBe("in_review");
    expect(normalizeAppStoreState("METADATA_REJECTED")).toBe("rejected");
    expect(normalizePlayState("completed")).toBe("live");
    expect(normalizePlayState("inProgress", 0.2)).toBe("rolling_out");
    expect(normalizePlayState("inProgress", 1)).toBe("live");
    expect(normalizePlayState("halted")).toBe("halted");
  });
});

describe("appstore-play-mcp over MCP", () => {
  it("exposes a read-only tool surface", async () => {
    const client = await connectDemoClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_app",
      "get_releases",
      "get_reviews",
      "list_apps",
      "stores_health",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
    }
  });

  it("lists apps from both stores in one call", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "list_apps", arguments: {} });
    const { apps } = result.structuredContent as { apps: Array<{ store: string }> };
    expect(apps.some((app) => app.store === "appstore")).toBe(true);
    expect(apps.some((app) => app.store === "play")).toBe(true);
  });

  it("filters to one store on request", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "list_apps", arguments: { store: "play" } });
    const { apps } = result.structuredContent as { apps: Array<{ store: string }> };
    expect(apps.every((app) => app.store === "play")).toBe(true);
  });

  it("reports a staged rollout and a review queue side by side", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({
      name: "get_releases",
      arguments: { appId: "com.example.pocketherbarium" },
    });
    const { releases } = result.structuredContent as {
      releases: Array<{ store: string; state: string; userFraction?: number }>;
    };
    expect(releases.find((r) => r.state === "rolling_out")?.userFraction).toBe(0.2);
    expect(releases.some((r) => r.store === "appstore" && r.state === "in_review")).toBe(true);
  });

  it("sweeps the portfolio for complaints", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "get_reviews", arguments: { maxRating: 2 } });
    const { reviews, count } = result.structuredContent as {
      count: number;
      reviews: Array<{ rating: number; store: string }>;
    };
    expect(count).toBeGreaterThan(0);
    expect(reviews.every((review) => review.rating <= 2)).toBe(true);
    expect(new Set(reviews.map((review) => review.store)).size).toBe(2);
  });

  it("sorts merged reviews newest first", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "get_reviews", arguments: {} });
    const { reviews } = result.structuredContent as { reviews: Array<{ createdAt?: string }> };
    const dates = reviews.map((review) => review.createdAt ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("explains an unmatched app instead of returning nothing", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "get_releases", arguments: { appId: "com.nope.missing" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("list_apps");
  });

  it("says which store is unconfigured rather than returning an empty list", async () => {
    const config = loadConfig({
      ASC_KEY_ID: "K",
      ASC_ISSUER_ID: "I",
      ASC_PRIVATE_KEY: "x",
    } as NodeJS.ProcessEnv);
    const server = createServer(config);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = await client.callTool({ name: "list_apps", arguments: { store: "play" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("PLAY_SERVICE_ACCOUNT_PATH");
  });

  it("reports health for both stores", async () => {
    const client = await connectDemoClient();
    const result = await client.callTool({ name: "stores_health", arguments: {} });
    const { mode, stores } = result.structuredContent as { mode: string; stores: Array<{ ok: boolean }> };
    expect(mode).toBe("demo");
    expect(stores).toHaveLength(2);
    expect(stores.every((store) => store.ok)).toBe(true);
  });
});

describe("release metadata", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const registry = JSON.parse(readFileSync("server.json", "utf8"));

  // The MCP Registry rejects a server.json that disagrees with the published
  // package, so the mismatch is worth catching here rather than at publish time.
  it("keeps package.json, server.json and the advertised version in step", () => {
    expect(VERSION).toBe(pkg.version);
    expect(registry.version).toBe(pkg.version);
    expect(registry.packages[0].version).toBe(pkg.version);
    expect(registry.packages[0].identifier).toBe(pkg.name);
    expect(registry.name).toBe(pkg.mcpName);
  });

  // The registry namespace is case-sensitive and must match the GitHub owner
  // exactly: io.github.johnbilousov was rejected where io.github.JohnBilousov
  // is granted. Derive it from the repository URL rather than trusting a
  // hand-typed string.
  it("matches the namespace to the GitHub owner, case included", () => {
    const owner = new URL(registry.repository.url).pathname.split("/")[1];
    expect(registry.name).toBe(`io.github.${owner}/${pkg.name}`);
  });

  it("stays inside the registry's description limit", () => {
    expect(registry.description.length).toBeLessThanOrEqual(100);
  });
});
