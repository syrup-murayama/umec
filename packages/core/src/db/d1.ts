export type ShopStatement = {
  bind(...values: unknown[]): ShopStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

export type ShopDatabase = {
  prepare(query: string): ShopStatement;
  batch(statements: ShopStatement[]): Promise<{ meta: { changes: number } }[]>;
};
