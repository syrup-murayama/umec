import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function findPackageRoot(startHref = import.meta.url): string {
  let dir = fileURLToPath(new URL(".", startHref));
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "schema"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Cannot locate @umec/core package root (package.json + schema/)");
    }
    dir = parent;
  }
}
