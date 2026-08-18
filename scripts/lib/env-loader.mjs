// Shared .env loader for plain-node (.mjs) scripts that run outside the
// `dotenv -e .env --` wrapper used by most npm scripts (e.g. scripts invoked
// directly, or invoked by other scripts). Never overwrites a variable
// already set in the real process environment (so CI/production env vars
// always win).
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, "..", "..");

export function loadEnv(envPath = join(repoRoot, ".env")) {
  if (!existsSync(envPath)) return;
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
