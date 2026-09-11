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
const materialFolders = ["ジャケット", "リリック", "ノーツ"];

async function ensureMaterialFolders() {
  await Promise.all(materialFolders.map(folder => mkdir(join(inbox, folder), { recursive: true })));
}

function fail(message) {
  console.error(`更新素材を処理できません: ${message}`);
  process.exitCode = 1;
}

async function inventory(directory, depth = 0) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "処理済み") continue;
    if (depth === 0 && entry.isDirectory() && !materialFolders.includes(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await inventory(fullPath, depth + 1);
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

async function archiveMaterials(files) {
  const archive = join(inbox, "処理済み", archiveName());
  const materials = files.map(file => file.replace(/:\d+:\d+$/, ""));

  if (materials.length === 0) return;
  await mkdir(archive, { recursive: true });

  for (const material of materials) {
    const original = files.find(file => file.startsWith(`${material}:`));
    const current = await stat(join(inbox, material));
    if (original !== `${material}:${current.size}:${Math.floor(current.mtimeMs)}`) continue;
    await mkdir(dirname(join(archive, material)), { recursive: true });
    await rename(join(inbox, material), join(archive, material));
  }

  console.log(`処理した素材を保管しました: ${archive}`);
  await ensureMaterialFolders();
}

function buildPrompt(files) {
  return `You maintain the Makuma official website in ${repoRoot}.

Only process this exact list of new materials:
${files.map(file => join(inbox, file.replace(/:\d+:\d+$/, ""))).join("\n")}

Read only those material files. Never list, scan, or read 処理済み or other
inbox folders, previous batches, caches, logs, node_modules, or dist.
Do not recursively scan the repository or read every page. Read AGENTS.md,
then search filenames/titles only within the relevant src/pages category.
Read the matching page and its category index. For a new release use only
src/pages/Music/weatherland.astro as the style example. Inspect shared code
only when the requested change requires it. Do not touch unrelated pages.
For cover-only updates do not inspect lyrics or Song Notes.
Determine what the materials are intended to update. When distribution URLs or
tracklists are needed, research them from authoritative artist, distributor,
Spotify, or Apple Music pages and cross-check the result.
Follow distributor smart-link redirects to obtain the actual Spotify release
URL. Verify its artist and title, then add both a Spotify link and a Spotify
embed player matching the existing release pages. Never invent a Spotify ID.
Reuse verified links already on the matching page first. If missing, find the
official distributor link for this title and artist, then run:
node scripts/resolve-spotify.mjs '<distributor URL>' '<exact release title>'
The helper follows the distributor's Spotify redirect and returns the verified
URL and embed URL. Verify the artist from the distributor page too. Do not
repeat broad searches after this succeeds. Use the returned URLs on the page.
Keep release buttons labeled Spotify and Apple Music as on existing pages.
Use distributor smart links only for research; do not add LinkCore or a
Streaming / Download button to the website.
If the URL cannot be verified, explicitly report the missing Spotify link and
player as incomplete work rather than claiming the update is complete.

The inbox uses these folders: ジャケット for cover images, リリック for lyric
documents, and ノーツ for Song Notes documents. A cover image is named
作品名（曲名）.jpg or .png; lyric and Song Notes documents are each named
曲名.docx. Treat the folder as the source type when the same song appears in
both a lyric and Song Notes document.

Make all necessary local changes: place images in the right project location,
create or update Astro pages, links, lyrics, Music and Lyrics indexes, and
Song Notes when source material calls for it. Preserve supplied text and stanza
breaks exactly. Do not run the build or start a preview: the desktop launcher
runs the build and release-link checks once after your edits. Check only links
you changed, not every page. Finish with a concise list of changed files.

Do not delete or rename source material. Do not commit, push, deploy, publish,
or change remote services. Finish by reporting the local diff and preview URL.`;
}

async function runCodex(files) {
  // Finder-launched Terminal sessions do not always inherit the normal shell
  // PATH. Prefer the Codex executable bundled with the ChatGPT app, while
  // still allowing an explicit override for future installations.
  const command = process.env.CODEX_CLI_PATH ?? (
    existsSync(bundledCodexCli) ? bundledCodexCli : "codex"
  );
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--cd",
    repoRoot,
    "--add-dir",
    inbox,
    "--sandbox",
    "workspace-write",
    buildPrompt(files),
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

  await ensureMaterialFolders();

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
      `素材の置き場所を確認してください: ${unexpectedRootFiles.join(", ")}。ジャケットは「ジャケット」、歌詞は「リリック」、Song Notesは「ノーツ」に入れてください`,
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

  await runCodex(files);
  await archiveMaterials(files);
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
