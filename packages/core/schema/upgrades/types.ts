export type UpgradeExecutor = {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
};

export type UpgradeModule = {
  name: string;
  fromVersion: number;
  toVersion: number;
  description: string;
  replacesChecksums: readonly string[];
  canApply(db: UpgradeExecutor): Promise<boolean>;
  apply(db: UpgradeExecutor): Promise<void>;
};
