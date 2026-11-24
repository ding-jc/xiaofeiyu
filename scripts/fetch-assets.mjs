// 拉取内置角色素材（仓库不收录，111MB / 9 个角色）。
//
// 来源：R2 桶 xiaofeiyu 里的 characters.zip，经 Worker 直发；
// 可用 ASSET_BASE 覆盖（自建镜像）。已是最新时按 etag 跳过下载，
// 本地反复跑不会重复下 111MB。`npm run assets -- --force` 强制重下。
import AdmZip from 'adm-zip';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = (process.env.ASSET_BASE || 'https://xiaofeiyu.2096450462.workers.dev').replace(/\/$/, '');
const URL_ZIP = `${BASE}/characters.zip`;
const OUT = 'src-tauri/resources/characters';
const STAMP = join(OUT, '.assets-stamp');
const TMP = 'dist-assets/characters.zip';

const force = process.argv.includes('--force');

async function head(url) {
  const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'xiaofeiyu' } });
  if (!r.ok) throw new Error(`HEAD ${url} → ${r.status}`);
  return { etag: r.headers.get('etag') || '', bytes: Number(r.headers.get('content-length') || 0) };
}

async function download(url, dst) {
  const r = await fetch(url, { headers: { 'User-Agent': 'xiaofeiyu' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await mkdir('dist-assets', { recursive: true });
  await writeFile(dst, buf);
  return buf.length;
}

let meta;
try {
  meta = await head(URL_ZIP);
} catch (e) {
  console.error(`无法访问素材源 ${URL_ZIP}\n${e.message}`);
  console.error('只做本地开发的话，把素材放进 src-tauri/resources/characters 就能跳过这一步。');
  process.exit(1);
}

if (!force) {
  const old = await readFile(STAMP, 'utf8').catch(() => '');
  if (old.trim() && meta.etag && old.trim() === meta.etag) {
    console.log(`素材已是最新（${meta.etag.slice(0, 14)}…），跳过下载`);
    process.exit(0);
  }
}

console.log(`下载素材包 ${(meta.bytes / 1048576).toFixed(1)} MB …`);
const bytes = await download(URL_ZIP, TMP);
if (meta.bytes && Math.abs(bytes - meta.bytes) > 1024) {
  console.error(`下载不完整：期望 ${meta.bytes} 字节，实得 ${bytes}`);
  process.exit(1);
}

const zip = new AdmZip(TMP);
const entries = zip.getEntries().filter((e) => !e.isDirectory);
if (!entries.length) {
  console.error('素材包是空的');
  process.exit(1);
}

// 先解到临时目录再整体替换，避免解压中断留下半套素材
const stage = `${OUT}.incoming`;
await rm(stage, { recursive: true, force: true });
for (const e of entries) {
  const dst = join(stage, e.entryName);
  await mkdir(join(dst, '..'), { recursive: true });
  await writeFile(dst, e.getData());
}
await rm(OUT, { recursive: true, force: true });
await cp(stage, OUT, { recursive: true });
await rm(stage, { recursive: true, force: true });
await writeFile(STAMP, `${meta.etag}\n`);
// 目录本身要在仓库里留一条记录：tauri-build 要求 resources/characters 存在
await writeFile(join(OUT, '.gitkeep'), '');

const ids = new Set(entries.map((e) => e.entryName.split('/')[0]));
const size = entries.reduce((n, e) => n + e.header.size, 0);
console.log(`完成：${entries.length} 个文件 · ${ids.size} 个角色 · ${(size / 1048576).toFixed(1)} MB → ${OUT}`);
