import { readFileSync } from "node:fs";

export class ConfigError extends Error {}

export interface AppStoreCredentials {
  keyId: string;
  issuerId: string;
  privateKey: string;
}

export interface PlayCredentials {
  clientEmail: string;
  privateKey: string;
  /** The Play API cannot enumerate a developer's apps, so packages are declared. */
  packages: string[];
}

export interface Config {
  demo: boolean;
  appStore?: AppStoreCredentials;
  play?: PlayCredentials;
  timeoutMs: number;
}

function truthy(value: string | undefined): boolean {
  return !!value && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readKeyMaterial(
  inline: string | undefined,
  path: string | undefined,
  label: string,
): string {
  if (inline && path) {
    throw new ConfigError(`Set either ${label}_PRIVATE_KEY or ${label}_KEY_PATH, not both.`);
  }
  if (inline) return inline.replace(/\\n/g, "\n");
  if (!path)
    throw new ConfigError(
      `${label}: no key material. Set ${label}_KEY_PATH or ${label}_PRIVATE_KEY.`,
    );
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `${label}: could not read ${path} — ${error instanceof Error ? error.message : error}`,
    );
  }
}

function loadAppStore(env: NodeJS.ProcessEnv): AppStoreCredentials | undefined {
  const keyId = env.ASC_KEY_ID?.trim();
  const issuerId = env.ASC_ISSUER_ID?.trim();
  const keyPath = env.ASC_KEY_PATH?.trim();
  const inline = env.ASC_PRIVATE_KEY?.trim();

  if (!keyId && !issuerId && !keyPath && !inline) return undefined;
  if (!keyId) throw new ConfigError("App Store: ASC_KEY_ID is missing.");
  if (!issuerId) throw new ConfigError("App Store: ASC_ISSUER_ID is missing.");

  return { keyId, issuerId, privateKey: readKeyMaterial(inline, keyPath, "ASC") };
}

function loadPlay(env: NodeJS.ProcessEnv): PlayCredentials | undefined {
  const path = env.PLAY_SERVICE_ACCOUNT_PATH?.trim();
  const inline = env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  const packages = (env.PLAY_PACKAGES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!path && !inline) {
    if (packages.length > 0) {
      throw new ConfigError(
        "Play: PLAY_PACKAGES is set but no service account. Set PLAY_SERVICE_ACCOUNT_PATH.",
      );
    }
    return undefined;
  }

  const rawJson = inline ?? readKeyMaterial(undefined, path, "PLAY_SERVICE_ACCOUNT");
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ConfigError("Play: the service account is not valid JSON.");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new ConfigError("Play: the service account JSON needs client_email and private_key.");
  }
  if (packages.length === 0) {
    throw new ConfigError(
      "Play: set PLAY_PACKAGES to the package names you want to read — the Play API cannot list a developer's apps.",
    );
  }

  return { clientEmail: parsed.client_email, privateKey: parsed.private_key, packages };
}

/**
 * Either store may be configured on its own; the server exposes whatever is
 * present. With neither configured it runs on fixtures instead of failing,
 * so the tools can be inspected before any credential exists.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const explicitDemo = truthy(env.STORES_DEMO);
  const appStore = explicitDemo ? undefined : loadAppStore(env);
  const play = explicitDemo ? undefined : loadPlay(env);
  const demo = explicitDemo || (!appStore && !play);

  const timeoutRaw = env.STORES_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`STORES_TIMEOUT_MS must be a positive number (got "${timeoutRaw}").`);
  }

  return { demo, appStore, play, timeoutMs };
}
