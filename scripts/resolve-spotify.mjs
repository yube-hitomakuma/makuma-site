import { pathToFileURL } from "node:url";

export async function resolveSpotify(distributorUrl, title, request = fetch) {
  const get = async url => {
    if (new URL(url).protocol !== "https:") throw new Error("HTTPS URLが必要です。");
    const response = await request(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`配信情報を取得できません: ${response.status}`);
    return response;
  };
  const page = await get(distributorUrl);
  const html = await page.text();
  const links = [...html.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
    .map(match => new URL((match[1] ?? match[2] ?? match[3]).replaceAll("&amp;", "&"), page.url || distributorUrl))
    .filter(url => (url.hostname === "open.spotify.com" && /^\/(album|track)\//.test(url.pathname)) ||
      (url.hostname === "www.tunecore.co.jp" && url.pathname.startsWith("/to/spotify/")));
  if (!links.length) throw new Error("配信元にSpotifyリンクが見つかりません。");
  for (const link of links) {
    const target = new URL((await get(link.href)).url);
    if (target.hostname !== "open.spotify.com" || !/^\/(album|track)\/[A-Za-z0-9]+$/.test(target.pathname)) continue;
    const url = target.origin + target.pathname;
    const metadata = await (await get(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`)).json();
    const normalize = value => value.normalize("NFKC").replace(/\s/g, "").toLowerCase();
    if (normalize(metadata.title) !== normalize(title)) continue;
    return { title: metadata.title, spotifyUrl: url, embedUrl: target.origin + "/embed" + target.pathname, source: distributorUrl };
  }
  throw new Error("指定した作品名とSpotifyの作品名が一致しません。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, title] = process.argv.slice(2);
  if (!url || !title) { console.error("配信元URLと作品名を指定してください。"); process.exitCode = 1; }
  else resolveSpotify(url, title).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
