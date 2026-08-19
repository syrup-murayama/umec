import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Printer } from "./migrate.js";

const EXTENSION_TYPES = {
  boolean: "z.boolean().optional()",
  string: "z.string().optional()",
  number: "z.number().optional()",
} as const;

export type ExtendType = keyof typeof EXTENSION_TYPES;

export type ExtendOptions = {
  cwd: string;
  key?: string;
  type?: string;
  print?: Printer;
};

const STUB = `import { z } from "zod";

export const orderExtensionSchema = z.object({
});

export type OrderExtension = z.infer<typeof orderExtensionSchema>;
`;

function isExtendType(value: string): value is ExtendType {
  return value in EXTENSION_TYPES;
}

export function runExtend(options: ExtendOptions): { exitCode: number; path: string; error?: string } {
  const print = options.print ?? (() => {});
  const path = join(options.cwd, "src/config/extensions.ts");
  mkdirSync(dirname(path), { recursive: true });

  if (!existsSync(path)) {
    writeFileSync(path, STUB);
    print(`created ${path}`);
  }

  const key = options.key;
  if (!key) {
    print("拡張は orders.extras_json に Zod で足す。orders を ALTER しないこと。");
    print(`編集ファイル: ${path}`);
    return { exitCode: 0, path };
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return { exitCode: 1, path, error: `invalid extras key: ${key}` };
  }

  const typeName = options.type ?? "string";
  if (!isExtendType(typeName)) {
    return { exitCode: 1, path, error: `unsupported type ${typeName} (boolean|string|number)` };
  }

  let source = readFileSync(path, "utf8");
  if (new RegExp(`\\b${key}:`).test(source)) {
    print(`${key} already exists in ${path}`);
    return { exitCode: 0, path };
  }

  if (!source.includes("orderExtensionSchema")) {
    return { exitCode: 1, path, error: "orderExtensionSchema not found in extensions.ts" };
  }

  source = source.replace(
    /export const orderExtensionSchema = z\.object\(\{\n/,
    `export const orderExtensionSchema = z.object({\n  ${key}: ${EXTENSION_TYPES[typeName]},\n`,
  );
  writeFileSync(path, source);
  print(`added ${key}: ${typeName} to extras_json via ${path}`);
  print("orders テーブルを ALTER しないこと。予約列 extras_json だけを使う。");
  return { exitCode: 0, path };
}
