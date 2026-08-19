import type { SchemaSnapshot, SnapshotColumn } from "./snapshot.js";

function pascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function tsType(column: SnapshotColumn): string {
  const nullable = column.notnull === 0 && column.pk === 0;
  const base = column.type.toUpperCase() === "INTEGER" || column.type.toUpperCase() === "REAL" ? "number" : "string";
  return nullable ? `${base} | null` : base;
}

export function generateRowTypes(snapshot: SchemaSnapshot): string {
  const blocks = Object.values(snapshot.tables)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((table) => {
      const fields = table.columns
        .map((column) => `  ${column.name}: ${tsType(column)};`)
        .join("\n");
      return `export type ${pascalCase(table.name)}Row = {\n${fields}\n};`;
    });

  return [
    "// Generated from schema/snapshot.json. Do not edit by hand.",
    `export const SNAPSHOT_SCHEMA_VERSION = ${snapshot.version} as const;`,
    "",
    ...blocks,
    "",
  ].join("\n");
}
