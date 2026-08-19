import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Bytes(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function loadFrozenChecksums(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}
