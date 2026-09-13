#!/usr/bin/env node

/**
 * Runs a material update, then presents the final publishing choice in macOS.
 * This script is launched by the Desktop .command file.
 */
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startProgress, waitForDeployment, deploymentFiles } from "./publish-progress.mjs";

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

async function openPreview() {
  // Refresh Astro's route table after files have been added by the updater.
  await run("npm", ["run", "astro", "--", "dev", "stop"]);
  await run("npm", ["run", "dev", "--", "--background"]);
  const state = JSON.parse(await readFile(join(repoRoot, ".astro", "dev.json"), "utf8"));
  const base = new URL(state.url);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("プレビューの接続先を確認できませんでした。");
  const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "src/pages"], { cwd: repoRoot });
  const { stdout: modified } = await execFileAsync("git", ["diff", "HEAD", "--name-only", "--", "src/pages"], { cwd: repoRoot });
  const pages = [...stdout.split("\n"), ...modified.split("\n")].filter(p => p.endsWith(".astro") && !p.includes("[") && !p.endsWith("index.astro"));
  const route = pages.length === 1 ? "/" + pages[0].replace(/^src\/pages\//, "").replace(/\.astro$/, "") : "/Music";
  const url = new URL(route, base).href;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("プレビューを読み込めませんでした。");
  await run("open", [url]);
  return url;
}

export async function reviewAndPublish(actions) {
  await actions.preview();
  const choice = await actions.choose();
  if (choice === "公開") await actions.publish();
  else if (choice === "修正") await actions.revise();
}

async function main() {
  console.log("サイト更新を開始します。処理の進行状況をここに表示します。");
  await log("サイト更新を開始しました。");
  if (await status()) {
    console.log("保留中の変更を再確認します。新しい素材の取り込みは次回に行います。");
  } else {
    console.log("素材を確認し、更新内容を準備しています。数分かかる場合があります。");
    await run("npm", ["run", "update:once"]);
  }

  try {
    console.log("サイトのビルドを確認しています。");
    await run("npm", ["run", "build"]);
    await run(process.execPath, ["scripts/check-release-links.mjs"]);
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

  await reviewAndPublish({
    preview: openPreview,
    choose: () => dialog(
      "既定ブラウザでプレビューを開きました。画面を確認してから選んでください。\n\n「公開」：この内容を本番サイトに公開します。\n「修正」：変更を残してChatGPTを開きます。",
      ["修正", "公開"], "修正",
    ),
    revise: async () => {
      console.log("変更を保存しました。ChatGPTで修正内容を伝えてください。");
      await run("open", ["-a", "ChatGPT"]);
    },
    publish: async () => {
    const progress = await startProgress();
    try {
    await run("open", [progress.url]);
    const changed = await execFileAsync("git", ["diff", "HEAD", "--name-only"], {cwd:repoRoot});
    const added = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {cwd:repoRoot});
    const expected = await deploymentFiles(repoRoot, (changed.stdout+'\n'+added.stdout).trim().split('\n'));
    await run("git", ["diff", "--check"]);
    progress.set(20, "変更を保存しています");
    await run("git", ["add", "--all"]);
    await run("git", ["commit", "-m", "Update Makuma website content"]);
    progress.set(40, "公開先へ送信しています");
    await run("git", ["push", "origin", "main"]);
    progress.set(70, "本番サイトへの反映を待っています");
    await waitForDeployment(expected);
    progress.set(100, "公開しました");
    await dialog(
      "公開しました。本番サイトへの反映を確認しました。",
      ["完了"],
      "完了",
    );
    } catch(error) {
      progress.set(70, error.message, true);
      await dialog(error.message, ["閉じる"], "閉じる");
      throw error;
    } finally { progress.close(); }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => {
    console.error(error.message);
    await log(error.stack ?? error.message);
    await dialog("処理を完了できませんでした。ターミナルに原因を表示しました。", ["閉じる"], "閉じる").catch(() => {});
    process.exitCode = 1;
  });
}
