#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { VERSION, createServer } from "./server.js";

const HELP = `appstore-play-mcp ${VERSION}

Read-only MCP server for App Store Connect and Google Play.

Usage:
  appstore-play-mcp            start the server on stdio
  appstore-play-mcp --demo     start on fixtures, no credentials needed
  appstore-play-mcp --version
  appstore-play-mcp --help

App Store Connect:
  ASC_KEY_ID                   key id from Users and Access -> Integrations
  ASC_ISSUER_ID                issuer id from the same page
  ASC_KEY_PATH                 path to AuthKey_<KEY_ID>.p8
  ASC_PRIVATE_KEY              the key inline, instead of ASC_KEY_PATH

Google Play:
  PLAY_SERVICE_ACCOUNT_PATH    path to the service account JSON
  PLAY_SERVICE_ACCOUNT_JSON    the JSON inline, instead of the path
  PLAY_PACKAGES                comma-separated package names to read

Optional:
  STORES_TIMEOUT_MS            request timeout, default 20000
  STORES_DEMO=1                force fixtures

Either store works on its own. With neither configured the server starts on
fixtures so the tools can be inspected before any credential exists.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes("--demo")) process.env.STORES_DEMO = "1";

  const config = loadConfig();
  const server = createServer(config);

  const configured = [config.appStore && "App Store", config.play && "Google Play"].filter(Boolean).join(" + ");
  console.error(
    config.demo ? "appstore-play-mcp: demo mode — fixtures only." : `appstore-play-mcp: live — ${configured}`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`appstore-play-mcp: ${error.message}`);
    process.exit(2);
  }
  console.error("appstore-play-mcp failed to start:", error);
  process.exit(1);
});
