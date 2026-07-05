#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import * as readline from "node:readline";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import * as steps from "../lib/steps.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

const stepResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  hint: z.string().optional(),
  skipped: z.boolean().optional(),
});

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    let settled = false;

    rl.once("close", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    rl.question(question, (answer) => {
      if (!settled) {
        settled = true;
        resolve(answer);
      }
      rl.close();
    });
  });
}

async function loadSystemPrompt() {
  const promptPath = new URL("../prompts/system.md", import.meta.url);
  const [systemPrompt, docContext] = await Promise.all([
    readFile(promptPath, "utf8"),
    steps.loadDocContext(),
  ]);

  if (!docContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## リポジトリ手順書\n\n${docContext}`;
}

function createTools() {
  const noInput = z.object({});

  return {
    check_env: tool({
      description: "環境（Node.js、git、wrangler）を確認する",
      inputSchema: noInput,
      outputSchema: stepResultSchema,
      execute: () => steps.checkEnv(),
    }),
    set_keys: tool({
      description:
        "APIキー4種を人間からマスク入力で受け取り、.env に保存する。鍵の値はAIへ返さない",
      inputSchema: noInput,
      outputSchema: stepResultSchema,
      execute: () => steps.promptKeys(),
    }),
    run_build: tool({
      description: "pnpm install と pnpm run build を実行する",
      inputSchema: noInput,
      outputSchema: stepResultSchema,
      execute: () => steps.build(),
    }),
    run_deploy: tool({
      description:
        "wrangler deploy を実行する。実行前の承認はツール内部で人間に確認する",
      inputSchema: noInput,
      outputSchema: stepResultSchema,
      execute: () => steps.deploy(),
    }),
    wrangler_login: tool({
      description:
        "wrangler login を実行してブラウザで Cloudflare 認証する。check_env で Cloudflare 未ログインが検出されたときに呼ぶ",
      inputSchema: noInput,
      outputSchema: stepResultSchema,
      execute: () => steps.wranglerLogin(),
    }),
    read_doc: tool({
      description:
        "リポジトリの .doc/AGENTS.md を読み、トラブル対応の根拠を得る",
      inputSchema: noInput,
      outputSchema: z.object({
        ok: z.literal(true),
        doc: z.string(),
      }),
      execute: async () => ({
        ok: true,
        doc: await steps.loadDocContext(),
      }),
    }),
  };
}

async function streamTurn({ model, system, messages, tools }) {
  const result = streamText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(25),
  });

  let wroteText = false;
  for await (const textPart of result.textStream) {
    wroteText = true;
    process.stdout.write(textPart);
  }
  if (wroteText) {
    process.stdout.write("\n");
  }

  const response = await result.response;
  messages.push(...response.messages);
}

export default async function runAI() {
  const gatewayUrl = process.env.UMEC_GATEWAY_URL;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!gatewayUrl || !openRouterApiKey) {
    console.log("\n  AI セットアップを始めるには、次の環境変数が必要です。");
    if (!gatewayUrl) {
      console.log("  - UMEC_GATEWAY_URL: Cloudflare AI Gateway の URL");
    }
    if (!openRouterApiKey) {
      console.log("  - OPENROUTER_API_KEY: OpenRouter の API キー");
    }
    console.log(
      "  準備できたら環境変数を設定して、もう一度 --ai を付けて実行してください。",
    );
    return;
  }

  const headers = process.env.CF_AIG_TOKEN
    ? {
        "cf-aig-authorization": `Bearer ${process.env.CF_AIG_TOKEN}`,
      }
    : undefined;
  const gateway = createOpenAICompatible({
    name: "cf-openrouter",
    baseURL: gatewayUrl.replace(/\/+$/, ""),
    apiKey: openRouterApiKey,
    headers,
  });
  const model = gateway(process.env.UMEC_AI_MODEL ?? DEFAULT_MODEL);
  const system = await loadSystemPrompt();
  const tools = createTools();
  const messages = [
    {
      role: "user",
      content:
        "セットアップを始めたいです。まず挨拶をして、何を公開したいか聞いてください。まだツールは呼ばないでください。",
    },
  ];

  try {
    await streamTurn({ model, system, messages, tools });

    while (true) {
      const answer = await promptUser("\n  あなた: ");
      if (answer === null) {
        console.log("\n  セットアップを終了します。またいつでも続きから始められます。");
        return;
      }

      const trimmed = answer.trim();
      if (!trimmed) {
        continue;
      }
      if (/^(exit|quit|終了)$/i.test(trimmed)) {
        console.log("  セットアップを終了します。またいつでも声をかけてください。");
        return;
      }

      messages.push({ role: "user", content: trimmed });
      await streamTurn({ model, system, messages, tools });
    }
  } catch (error) {
    console.error(
      "\n  AI との通信を続けられませんでした。入力内容のせいではありません。",
    );
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "  Gateway の URL・認証設定・モデル名を確認して、もう一度お試しください。",
    );
    process.exitCode = 1;
  }
}
