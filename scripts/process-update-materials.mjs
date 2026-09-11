#!/usr/bin/env node

/**
 * Watches the Makuma update inbox and asks Codex to prepare the website change.
 *
 * This command never commits, pushes, or publishes. It only prepares a local
 * change and leaves it for review in the working tree.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(process.cwd());
const inbox = resolve(
  process.env.MAKUMA_UPDATE_INBOX ??
    "/Users/rarabai/Documents/Codex/マクマHP更新素材",
);
const statePath = join(repoRoot, ".cache", "makuma-update-monitor.json");
const watch = process.argv.includes("--watch");
const pollIntervalMs = 15_000;
const stableForMs = 30_000;
const bundledCodexCli = "/Applications/ChatGPT.app/Contents/Resources/codex";

function fail(message) {
  console.error(`更新素材を処理できません: ${message}`);
  process.exitCode = 1;
}

async function inventory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "処理済み") continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await inventory(fullPath);
      files.push(...nested.map((file) => `${entry.name}/${file}`));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStats = await stat(fullPath);
    files.push(`${entry.name}:${fileStats.size}:${Math.floor(fileStats.mtimeMs)}`);
  }

  return files.sort();
}

function fingerprint(files) {
  return createHash("sha256").update(files.join("\n")).digest("hex");
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { processed: null, observed: null, observedAt: null };
  }
}

async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function archiveName() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

async function archiveMaterials() {
  const archive = join(inbox, "処理済み", archiveName());
  const entries = await readdir(inbox, { withFileTypes: true });
  const materials = entries.filter(
    (entry) => !entry.name.startsWith(".") && entry.name !== "処理済み",
  );

  if (materials.length === 0) return;
  await mkdir(archive, { recursive: true });

  for (const material of materials) {
    await rename(join(inbox, material.name), join(archive, material.name));
  }

  console.log(`処理した素材を保管しました: ${archive}`);
}

function buildPrompt() {
  return `You maintain the Makuma official website in ${repoRoot}.

New materials are in ${inbox}. Inspect every supplied file and the existing site.
Determine what the materials are intended to update. When distribution URLs or
tracklists are needed, research them from authoritative artist, distributor,
Spotify, or Apple Music pages and cross-check the result.

The inbox uses these folders: ジャケット for cover images, 歌詞 for lyric
documents, and Song Notes for Song Notes documents. A cover image is named
作品名（曲名）.jpg or .png; lyric and Song Notes documents are each named
曲名.docx. Treat the folder as the source type when the same song appears in
both a lyric and Song Notes document.

Make all necessary local changes: place images in the right project location,
create or update Astro pages, links, lyrics, Music and Lyrics indexes, and
Song Notes when source material calls for it. Preserve supplied text and stanza
breaks exactly. Run npm run build and check generated internal links.

Do not delete or rename source material. Do not commit, push, deploy, publish,
or change remote services. Finish by reporting the local diff and preview URL.`;
}

async function runCodex() {
  // Finder-launched Terminal sessions do not always inherit the normal shell
  // PATH. Prefer the Codex executable bundled with the ChatGPT app, while
  // still allowing an explicit override for future installations.
  const command = process.env.CODEX_CLI_PATH ?? (
    existsSync(bundledCodexCli) ? bundledCodexCli : "codex"
  );
  const args = [
    "exec",
    "--cd",
    repoRoot,
    "--add-dir",
    inbox,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    buildPrompt(),
  ];

  console.log("新しい素材を検知しました。更新準備を開始します。");
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`Codex exited with status ${code ?? "unknown"}`));
    });
  });
}

async function inspect() {
  if (!existsSync(inbox)) {
    fail(`素材フォルダがありません: ${inbox}`);
    return;
  }

  const files = await inventory(inbox);
  if (files.length === 0) {
    console.log("素材フォルダは空です。処理は行いません。");
    return;
  }

  const unexpectedRootFiles = files.filter((file) => {
    const name = file.split(":")[0];
    return !name.includes("/") && name !== "更新内容.txt";
  });
  if (unexpectedRootFiles.length > 0) {
    fail(
      `素材の置き場所を確認してください: ${unexpectedRootFiles.join(", ")}。ジャケットは「ジャケット」、歌詞は「歌詞」、Song Notesは「Song Notes」に入れてください`,
    );
    return;
  }

  const current = fingerprint(files);
  const state = await readState();
  const now = Date.now();

  if (state.processed === current) {
    console.log("新しい素材はありません。");
    return;
  }

  if (watch && state.observed !== current) {
    await saveState({ ...state, observed: current, observedAt: now });
    console.log("素材の追加・変更を検知しました。30秒間の安定確認中です。");
    return;
  }

  if (watch && now - (state.observedAt ?? now) < stableForMs) {
    console.log("素材のコピー完了を待っています。");
    return;
  }

  await runCodex();
  await archiveMaterials();
  await saveState({ processed: current, observed: current, observedAt: now });
}

async function main() {
  try {
    await inspect();
    if (!watch) return;
    setInterval(() => {
      inspect().catch((error) => console.error(error.message));
    }, pollIntervalMs);
    console.log(`監視中: ${basename(inbox)}（Ctrl+Cで停止）`);
  } catch (error) {
    fail(error.message);
  }
}

main();
