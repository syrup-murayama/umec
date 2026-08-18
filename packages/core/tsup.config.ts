import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/access.ts",
    "src/checkout.ts",
    "src/config.ts",
    "src/env.ts",
    "src/middleware.ts",
    "src/notify.ts",
    "src/subscribe.ts",
    "src/webhook.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: ["cloudflare:workers"],
});
