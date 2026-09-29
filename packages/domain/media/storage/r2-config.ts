/**
 * Cloudflare R2 (S3-compatible) configuration — read lazily from
 * process.env, never at module load time (so importing image-service.ts
 * never fails just because R2 isn't configured in a given environment,
 * e.g. a local unit-test run). Same convention as packages/auth/session.ts's
 * getSecretKey(): validate on first real use, throw a clear error naming
 * which variable is missing, NEVER include the actual secret values in any
 * error message, log, or response.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** Normalized — no trailing slash. */
  publicBaseUrl: string;
  /** Derived from accountId — never hardcoded, never stored separately. */
  endpoint: string;
}

const REQUIRED_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"] as const;

export function getR2Config(env: NodeJS.ProcessEnv = process.env): R2Config {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Nedostaju promenljive okruženja za R2 skladište: ${missing.join(", ")}`);
  }

  const accountId = env.R2_ACCOUNT_ID!;
  const accessKeyId = env.R2_ACCESS_KEY_ID!;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY!;
  const bucketName = env.R2_BUCKET_NAME!;
  const publicBaseUrlRaw = env.R2_PUBLIC_BASE_URL!;

  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrlRaw);
  } catch {
    throw new Error("R2_PUBLIC_BASE_URL nije validan URL.");
  }
  if (parsed.protocol !== "https:") {
    // Allow http only for an explicit local/dev escape hatch — production
    // traffic and every deployed environment must be https.
    if (env.NODE_ENV === "production") {
      throw new Error("R2_PUBLIC_BASE_URL mora biti https:// u produkciji.");
    }
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicBaseUrl: publicBaseUrlRaw.replace(/\/+$/, ""),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}
