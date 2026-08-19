import type { z } from "zod";

export function parseExtras<S extends z.ZodType>(schema: S, extrasJson: string | null): z.infer<S> | null {
  if (!extrasJson) return null;
  const parsed: unknown = JSON.parse(extrasJson);
  return schema.parse(parsed);
}

export function serializeExtras<S extends z.ZodType>(schema: S, value: unknown): string {
  return JSON.stringify(schema.parse(value));
}
