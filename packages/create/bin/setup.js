#!/usr/bin/env node

import process from "node:process";
import * as steps from "../lib/steps.js";

const VERSION = "0.1.0";

// Phase 2 hook:
// async function explainError(result) {
//   // TODO: Daisuke の AI API に result を渡す
// }

function printHelp() {
  console.log(`
  umec セットアップ  v${VERSION}

  使い方:
    npm create @umec              対話型セットアップ（Phase 1）
    npm create @umec -- --ai     AI アシスト型セットアップ

  オプション:
    --help, -h      このヘルプを表示
    --version, -v   バージョンを表示
    --ai            AI アシスト型で起動
  `);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set();
  const commands = [];

  for (const arg of args) {
    if (arg.startsWith("-")) {
      flags.add(arg);
    } else {
      commands.push(arg);
    }
  }

  return { flags, command: commands[0] };
}

async function main() {
  const { flags, command } = parseArgs(process.argv);

  // --help / -h
  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }

  // --version / -v
  if (flags.has("--version") || flags.has("-v")) {
    console.log(VERSION);
    return;
  }

  // 未知のフラグを拒否
  const knownFlags = new Set(["--ai", "--help", "-h", "--version", "-v"]);
  for (const flag of flags) {
    if (!knownFlags.has(flag)) {
      console.error(`  エラー: 不明なオプション "${flag}"`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }

  // --ai モード（完全一致のみ）
  if (flags.has("--ai")) {
    const { default: runAI } = await import("./setup-ai.js");
    await runAI();
    return;
  }

  // command は "setup" か未指定のみ許可
  if (command && command !== "setup") {
    console.error(`  エラー: 不明なコマンド "${command}"`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  ${steps.paint("umec セットアップ", steps.color.bold)}  v${VERSION}`,
  );
  console.log("  所要時間: 約30分");

  for (const step of [
    steps.checkEnv,
    steps.promptKeys,
    steps.build,
    steps.deploy,
  ]) {
    const result = await step();
    if (!result.ok) {
      steps.reportError(result);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\n  次のステップ:");
  console.log(
    "  1. Stripe Webhook endpoint 登録: https://<your-domain>/api/webhook",
  );
  console.log("     イベント: checkout.session.completed");
  console.log("  2. wrangler secret put STRIPE_WEBHOOK_SECRET");
}

main().catch((error) => {
  // reportError 自体が失敗しても原因が消えないよう二重防御
  try {
    steps.reportError({ error: error?.message ?? String(error) });
  } catch {
    console.error("  エラー:", error?.message ?? String(error));
  }
  process.exitCode = 1;
});
