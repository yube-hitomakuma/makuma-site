import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// Check only releases involved in the pending update, including new pages.
const changed = execFileSync("git", ["diff", "HEAD", "--name-only", "--", "src/pages/Music"], { encoding: "utf8" });
const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src/pages/Music"], { encoding: "utf8" });
for (const file of new Set((changed + "\n" + added).split("\n").filter(p => p.endsWith(".astro") && !p.endsWith("/index.astro")))) {
  const source = await readFile(file, "utf8");
  const url = source.match(/href="(https:\/\/open\.spotify\.com\/(?:album|track)\/[A-Za-z0-9]+)"/)?.[1];
  if (!url || !source.includes(url.replace(".com/", ".com/embed/"))) {
    throw new Error(`${file}: Spotifyのリンクと埋め込みが揃っていません。`);
  }
  if (/linkco\.re|Streaming\s*\/\s*Download/.test(source)) throw new Error(`${file}: 配信ボタンが既存の形式と異なります。`);
  const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${file}: Spotifyの配信情報を確認できませんでした。`);
  const data = await response.json();
  const title = source.match(/<h1>([^<]+)<\/h1>/)?.[1];
  const normalize = value => value.normalize("NFKC").replace(/\s/g, "").toLowerCase();
  if (!title || normalize(data.title) !== normalize(title)) throw new Error(`${file}: Spotifyの作品名が一致しません。`);
  console.log(`Spotifyリンク・埋め込み確認済み: ${title}`);
}
