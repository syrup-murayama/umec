// setup.js から抽出した共有ステップ関数。AI版(setup-ai.js)と Phase1(setup.js) の両方が使う。ロジックを変えるときはここだけ変えればよい。

import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import process from "node:process";
import * as readline from "node:readline";

export const ENV_PATH = ".env";

export const color = {
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m",
};

export function paint(value, ansi) {
  return process.stdout.isTTY ? `${ansi}${value}${color.reset}` : value;
}

export function success(message) {
  console.log(`  ${paint("✓", color.green)} ${message}`);
}

export function failure(message) {
  console.log(`  ${paint("✗", color.red)} ${message}`);
}

export function section(number, title) {
  console.log(`\n  ${paint(`[${number}/4]`, color.cyan)} ${title}`);
}

export function execute(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error?.message,
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
      });
    });
  });
}

export async function checkCommand(command, versionArgs, label, hint) {
  const result = await execute(command, versionArgs);
  if (!result.ok) {
    failure(`${label} が見つかりません → ${hint}`);
    return {
      ok: false,
      error: `${label} が見つかりません`,
      hint,
    };
  }

  const version = (result.stdout || result.stderr).split("\n")[0];
  success(version.startsWith(label) ? version : `${label} ${version}`);
  return { ok: true };
}

export async function checkWranglerAuth() {
  const result = await execute("wrangler", ["whoami"]);
  if (!result.ok) {
    failure("Cloudflare: 未ログイン");
    return {
      ok: false,
      error: "Cloudflare にログインしていません",
      hint: "wrangler login を実行してください（ブラウザが開きます）",
    };
  }
  const text = result.stdout + result.stderr;
  const emailMatch = text.match(/associated with the email\s+\x1b\[[\d;]*m([^\x1b\s]+)/);
  const email = emailMatch?.[1] ?? "認証済み";
  success(`Cloudflare: ${email}`);
  return { ok: true };
}

export async function wranglerLogin() {
  console.log("  ブラウザが開きます。Cloudflare アカウントでログインしてください...");
  const result = await runInteractive("wrangler", ["login"]);
  if (!result.ok) {
    return {
      ...result,
      hint: "ブラウザが開かない場合は https://dash.cloudflare.com/sign-up でアカウントを作成してから再実行してください",
    };
  }
  success("Cloudflare ログイン完了");
  return { ok: true };
}

export async function checkEnv() {
  section(1, "環境チェック");

  const results = [
    await checkCommand(
      process.execPath,
      ["--version"],
      "Node.js",
      "Node.js 22.12.0 以上をインストールしてください",
    ),
    await checkCommand(
      "git",
      ["--version"],
      "git",
      "https://git-scm.com/ からインストールしてください",
    ),
    await checkCommand(
      "wrangler",
      ["--version"],
      "wrangler",
      "npm install -g wrangler を実行してください",
    ),
  ];

  const installFailed = results.find((result) => !result.ok);
  if (installFailed) return installFailed;

  const authResult = await checkWranglerAuth();
  return authResult;
}

export function promptLine(question) {
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

export function promptMasked(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptLine(question);
  }

  return new Promise((resolve) => {
    let value = "";
    const input = process.stdin;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };

    const finish = (answer) => {
      cleanup();
      process.stdout.write("\n");
      resolve(answer);
    };

    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(value);
        return;
      }

      if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      if (
        character &&
        !key.ctrl &&
        !key.meta &&
        character >= " " &&
        character !== "\u007f"
      ) {
        value += character;
        process.stdout.write("•");
      }
    };

    process.stdout.write(question);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}

export function validatePrefix(value, prefix, label) {
  if (!value.startsWith(prefix)) {
    return {
      ok: false,
      error: `${label} は ${prefix} で始まる値を入力してください`,
    };
  }
  return { ok: true };
}

export async function askKey(label, prefix) {
  while (true) {
    const value = await promptMasked(`  ${label} (${prefix}...): `);
    if (value === null) {
      return {
        ok: false,
        error: "入力がキャンセルされました",
        hint: "対話可能なターミナルで再実行してください",
      };
    }

    const validation = validatePrefix(value.trim(), prefix, label);
    if (validation.ok) {
      return { ok: true, value: value.trim() };
    }
    failure(validation.error);
  }
}

export async function isEnvIgnored() {
  try {
    await access(".gitignore", fsConstants.R_OK);
  } catch {
    return false;
  }

  const result = await execute("git", ["check-ignore", "-q", ENV_PATH]);
  return result.ok;
}

export function escapeEnvValue(value) {
  return JSON.stringify(value);
}

export function updateEnv(contents, values) {
  let updated = contents;

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${escapeEnvValue(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    updated = pattern.test(updated)
      ? updated.replace(pattern, line)
      : `${updated}${updated && !updated.endsWith("\n") ? "\n" : ""}${line}\n`;
  }

  return updated;
}

export async function promptKeys() {
  section(2, "API キーの設定（.env に書き込み）");

  if (!(await isEnvIgnored())) {
    return {
      ok: false,
      error: ".env が .gitignore の対象ではありません",
      hint: ".gitignore に .env を追加してから再実行してください",
    };
  }

  const prompts = [
    ["PUBLIC_STRIPE_PUBLISHABLE_KEY", "Stripe 公開キー", "pk_"],
    ["STRIPE_SECRET_KEY", "Stripe シークレットキー", "sk_"],
    ["RESEND_API_KEY", "Resend API キー", "re_"],
    ["RESEND_AUDIENCE_ID", "Resend Audience ID", ""],
  ];
  const values = {};

  for (const [envName, label, prefix] of prompts) {
    const result = prefix
      ? await askKey(label, prefix)
      : await promptMasked(`  ${label}: `).then((value) =>
          value?.trim()
            ? { ok: true, value: value.trim() }
            : {
                ok: false,
                error: value === null
                  ? "入力がキャンセルされました"
                  : `${label} を入力してください`,
              },
        );

    if (!result.ok) {
      return result;
    }
    values[envName] = result.value;
  }

  let current = "";
  let existingMode = 0o600;
  try {
    current = await readFile(ENV_PATH, "utf8");
    existingMode = (await stat(ENV_PATH)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { ok: false, error: `.env を読み込めません: ${error.message}` };
    }
  }

  try {
    await writeFile(ENV_PATH, updateEnv(current, values), {
      encoding: "utf8",
      mode: existingMode,
    });
    await chmod(ENV_PATH, existingMode);
  } catch (error) {
    return { ok: false, error: `.env に書き込めません: ${error.message}` };
  }

  success(".env に API キーを書き込みました");
  return { ok: true };
}

export function runInteractive(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });

    child.once("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: signal
            ? `${command} がシグナル ${signal} で終了しました`
            : `${command} が終了コード ${code} で失敗しました`,
        });
      }
    });
  });
}

export async function build() {
  section(3, "ビルド");

  // package.json に build スクリプトがなければ早期リターン
  try {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    if (!pkg.scripts?.build) {
      return {
        ok: false,
        error: "package.json に build スクリプトがありません",
        hint: "テンプレートリポジトリが展開されているディレクトリで実行してください。プロジェクトのルートに package.json の build スクリプトが必要です。",
      };
    }
  } catch {
    // package.json が読めない場合はそのまま進んで pnpm にエラーを任せる
  }

  process.stdout.write("  pnpm install ...\n");
  const installResult = await runInteractive("pnpm", ["install"]);
  if (!installResult.ok) {
    return {
      ...installResult,
      hint: "pnpm install の出力を確認してください",
    };
  }
  success("pnpm install");

  process.stdout.write("  pnpm run build ...\n");
  const buildResult = await runInteractive("pnpm", ["run", "build"]);
  if (!buildResult.ok) {
    return {
      ...buildResult,
      hint: "エラーメッセージを確認してください。型エラーの場合は pnpm run typecheck でも確認できます。",
    };
  }
  success("pnpm run build");

  return { ok: true };
}

export async function deploy() {
  section(4, "デプロイ");
  const answer = await promptLine(
    "  wrangler deploy を実行しますか？ [Y/n]: ",
  );

  if (answer === null) {
    return {
      ok: false,
      error: "入力がキャンセルされました",
      hint: "対話可能なターミナルで再実行してください",
    };
  }

  if (answer.trim() && !/^y(es)?$/i.test(answer.trim())) {
    console.log("  デプロイをスキップしました");
    return { ok: true, skipped: true };
  }

  const result = await runInteractive("wrangler", ["deploy"]);
  if (!result.ok) {
    return {
      ...result,
      hint: "wrangler login と wrangler.jsonc を確認してください",
    };
  }
  success("wrangler deploy");
  return { ok: true };
}

export function reportError(result) {
  failure(result.error ?? "不明なエラーが発生しました");
  if (result.hint) {
    console.log(`  ${paint("ヒント:", color.yellow)} ${result.hint}`);
  }
}

export async function loadDocContext() {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(".doc/AGENTS.md", "utf8");
  } catch {
    return "";
  }
}
