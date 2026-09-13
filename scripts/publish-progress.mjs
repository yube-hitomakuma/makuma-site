import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const digest = data => createHash('sha256').update(data).digest('hex');

export async function waitForDeployment(expected, {request = fetch, attempts = 60, delay = 5000} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const matches = await Promise.all(expected.map(async ({path, hash}) => {
      try {
        const response = await request(`https://makuma1005.com${path}?verify=${Date.now()}`, {signal: AbortSignal.timeout(15000), cache:'no-store'});
        return response.ok && digest(Buffer.from(await response.arrayBuffer())) === hash;
      } catch { return false; }
    }));
    if (matches.length && matches.every(Boolean)) return;
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('本番反映をまだ確認できません。公開成功とは判定していません。時間をおいて再確認してください。');
}

export async function startProgress() {
  const token = randomBytes(24).toString('hex');
  let state = {percent:0, message:'公開の準備中です'};
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.url === `/${token}/state`) {
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(state)); return;
    }
    if(req.url !== `/${token}`) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>マクマ 公開状況</title><style>body{font:20px system-ui;background:#141414;color:#fff;max-width:640px;margin:15vh auto;padding:32px}progress{width:100%;height:28px;accent-color:#8ed9ae}small{color:#bbb}</style><h1>マクマ サイト公開</h1><p id="message">公開の準備中です</p><progress id="bar" max="100" value="0"></progress><p id="percent">0%</p><small>工程ごとの進捗です。本番反映の確認後に100%になります。</small><script>async function tick(){try{const s=await(await fetch(location.pathname+'/state')).json();document.getElementById('bar').value=s.percent;document.getElementById('percent').textContent=s.percent+'%';document.getElementById('message').textContent=s.message;if(s.percent<100&&!s.failed)setTimeout(tick,500)}catch{document.getElementById('message').textContent='処理が終了したか、接続が切れました。公開結果はポップアップで確認してください。'}}tick();</script></html>`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {url:`http://127.0.0.1:${server.address().port}/${token}`, set:(percent,message,failed=false)=>{state={percent,message,failed}}, close:()=>server.close()};
}

export async function deploymentFiles(root, files) {
  const paths = new Set(['/']);
  for(const file of files) {
    if(file.startsWith('src/pages/') && file.endsWith('.astro') && !file.includes('[')) paths.add('/'+file.slice(10,-6).replace(/index$/,''));
    if(file.startsWith('public/')) paths.add('/'+file.slice(7));
  }
  return Promise.all([...paths].map(async path => {
    const disk = path.startsWith('/covers/') ? path : path.replace(/\/$/,'')+'/index.html';
    return {path, hash:digest(await readFile(root+'/dist'+disk))};
  }));
}
