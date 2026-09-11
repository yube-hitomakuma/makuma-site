#!/usr/bin/env node

/**
 * Runs a material update, then presents the final publishing choice in macOS.
 * This script is launched by the Desktop .command file.
 */
import { execFile } from "node:child_process";
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
  let result;
  try {
    result = await execFileAsync(command, args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
    if (detail) process.stderr.write(`${detail}\n`);
    await log(`失敗: ${command} ${args.join(" ")}\n${detail}`);
    throw error;
  }

  const { stdout, stderr } = result;

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
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
    await run("npm", ["run", "update:once"]);
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
