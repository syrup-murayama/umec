import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

const libEntry = {
  index: "src/index.ts",
  access: "src/access.ts",
  checkout: "src/checkout.ts",
  config: "src/config.ts",
  env: "src/env.ts",
  middleware: "src/middleware.ts",
  notify: "src/notify.ts",
  subscribe: "src/subscribe.ts",
  webhook: "src/webhook.ts",
  "db/index": "src/db/index.ts",
};

export default defineConfig({
  entry: {
    ...libEntry,
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  dts: { entry: libEntry },
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: ["cloudflare:workers", "node:sqlite"],
  async onSuccess() {
    const path = "dist/cli.js";
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("#!")) {
      writeFileSync(path, `#!/usr/bin/env node\n${text}`);
    }
    chmodSync(path, 0o755);
  },
});
