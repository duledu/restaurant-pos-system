export declare const ENV_FILES: Record<"test" | "preprod" | "production", string>;

export declare class DatabaseTargetError extends Error {}

export interface DatabaseTarget {
  environment: "test" | "preprod" | "production";
  databaseUrl: string;
  directUrl: string;
  endpointId: string;
  envFile: string;
}

export declare function resolveDatabaseTarget(options?: {
  argv?: string[];
  repoRoot?: string;
  readEnvironmentMarker?: (connectionString: string) => Promise<string | null>;
}): Promise<DatabaseTarget>;
