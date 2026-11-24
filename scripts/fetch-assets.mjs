// 从原项目仓库拉取内置 WebM 素材（仓库体积较大，克隆时不随源码分发）。
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const OWNER = 'MerZlin';
const REPO = 'dsh-pet-indesktop';
const PREFIX = 'assets/characters/shenshen/videos/';
const OUT = 'src-tauri/resources/characters/shenshen/videos';

const tree = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`, {
  headers: { 'User-Agent': 'xiaofeiyu' },
}).then((r) => r.json());
if (!tree.tree) throw new Error('无法获取仓库目录树');

const files = tree.tree
  .filter((e) => e.type === 'blob' && e.path.startsWith(PREFIX) && /\.(webm|json)$/i.test(e.path))
  .map((e) => e.path);

console.log(`发现 ${files.length} 个素材文件，开始下载…`);
let done = 0;
const queue = [...files];
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    const dst = join(OUT, p.slice(PREFIX.length));
    await mkdir(dirname(dst), { recursive: true });
    try {
      const sz = (await stat(dst)).size;
      if (sz > 0) { done++; continue; }
    } catch { /* 不存在 */ }
    const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${p.split('/').map(encodeURIComponent).join('/')}`;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'xiaofeiyu' } });
        if (!r.ok) throw new Error(String(r.status));
        await writeFile(dst, Buffer.from(await r.arrayBuffer()));
        done++;
        break;
      } catch (e) {
        if (i === 2) console.error('失败', p, e);
      }
    }
  }
}
await Promise.all(Array.from({ length: 10 }, worker));
console.log(`完成 ${done}/${files.length}，输出目录：${OUT}`);
