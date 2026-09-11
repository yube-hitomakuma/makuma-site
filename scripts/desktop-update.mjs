#!/usr/bin/env node

/**
 * Runs a material update, then presents the final publishing choice in macOS.
 * This script is launched by the Desktop .command file.
 */
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const logPath = join(repoRoot, ".cache", "desktop-update.log");

async function log(message) {
  await mkdir(join(repoRoot, ".cache"), { recursive: true });
  await appendFile(logPath, `[${new Date().toLocaleString("ja-JP")}] ${message}\n`);
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot, ...options, stdio: ["ignore", "pipe", "pipe"],
    });
    let pendingLog = Promise.resolve();
    for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      source.on("data", (chunk) => {
        destination.write(chunk);
        pendingLog = pendingLog.then(() => appendFile(logPath, chunk)).catch(() => {});
      });
    }
    child.once("error", rejectRun);
    child.once("close", async (code, signal) => {
      await pendingLog;
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command}: 終了状態 ${code ?? signal}`));
    });
  });
}

async function status() {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

async function dialog(message, buttons, defaultButton) {
  const escaped = message.replaceAll('"', '\\"');
  const labels = buttons.map((button) => `"${button}"`).join(", ");
  const script = `display dialog "${escaped}" buttons {${labels}} default button "${defaultButton}" with title "Makumaサイト更新"`;
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.match(/button returned:([^,]+)/)?.[1];
}

async function main() {
  console.log("サイト更新を開始します。処理の進行状況をここに表示します。");
  await log("サイト更新を開始しました。");
  if (await status()) {
    await dialog(
      "未確認のサイト変更があります。混在を避けるため、今回の自動更新は開始しません。差分を確認してからもう一度実行してください。",
      ["閉じる"],
      "閉じる",
    );
    process.exitCode = 1;
    return;
  }

  try {
    console.log("素材を確認し、更新内容を準備しています。数分かかる場合があります。");
    await run("npm", ["run", "update:once"]);
    console.log("サイトのビルドを確認しています。");
    await run("npm", ["run", "build"]);
  } catch (error) {
    console.error(error.message);
    await dialog(
      "更新を完了できませんでした。公開は行いません。ターミナルの表示、または「.cache/desktop-update.log」を確認してください。",
      ["閉じる"],
      "閉じる",
    );
    process.exitCode = 1;
    return;
  }

  if (!(await status())) {
    await dialog(
      "新しい素材はありませんでした。公開は行いません。",
      ["閉じる"],
      "閉じる",
    );
    return;
  }

  const publishChoice = await dialog(
    "更新の準備とビルドが完了しました。公開しますか？\n\n「公開する」を選ぶと、変更をcommitしてGitHubへpushします。Cloudflare Pagesが本番サイトを更新します。",
    ["あとで確認", "公開する"],
    "あとで確認",
  );

  if (publishChoice !== "公開する") {
    console.log("公開は保留しました。変更はローカルに残っています。");
    return;
  }

  try {
    await run("git", ["diff", "--check"]);
    await run("git", ["add", "--all"]);
    await run("git", ["commit", "-m", "Update Makuma website content"]);
    await run("git", ["push", "origin", "main"]);
    await dialog(
      "GitHubへpushしました。Cloudflare Pagesによる本番反映を開始しています。",
      ["閉じる"],
      "閉じる",
    );
  } catch (error) {
    console.error(error.message);
    await dialog(
      "公開処理で問題が見つかりました。ターミナルの表示を確認してください。",
      ["閉じる"],
      "閉じる",
    );
    process.exitCode = 1;
  }
}

main();
