import type { DatabaseTarget } from "./lib/resolve-db-target.d.mts";

export declare function resolveStudioTarget(argv?: string[]): Promise<DatabaseTarget>;
export declare function buildStudioSpawnEnv(
  target: DatabaseTarget,
  baseEnv?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
export declare function buildStudioArgs(): string[];
