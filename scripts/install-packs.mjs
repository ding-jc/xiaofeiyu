// 离线安装官方完整素材包（core + extra1..6）。
// 构建期工具，不是应用内联网络请求；本版本运行时不联网。
// 用法：node scripts/install-packs.mjs <包含分件 zip 的目录>
import { readdir, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const SRC = process.argv[2];
const OUT = join('src-tauri', 'resources', 'characters', 'shenshen', 'videos');

if (!SRC) {
  console.log(`用法：node scripts/install-packs.mjs <分件 zip 所在目录>

分件文件名格式（与官方发布页一致）：
  shenshen-2.0.0-base-640x360.core.zip
  shenshen-2.0.0-base-640x360.extra1.zip … extra6.zip

下载地址：https://github.com/MerZlin/dsh-pet-indesktop/releases/tag/assets-v1
下载后把所有 zip 放进同一个目录再运行本脚本。脚本只做解压与合并，不下载任何内容。
合并完成后重新执行 npm run build:nsis / build:portable 即可打进安装包。`);
  process.exit(0);
}

const files = (await readdir(SRC)).filter((f) => /\.zip$/i.test(f)).sort();
if (!files.length) throw new Error(`目录里没有 .zip：${SRC}`);

let copied = 0, replaced = 0;
const collisions = [];

for (const f of files) {
  const p = join(SRC, f);
  const sz = (await stat(p)).size;
  console.log(`解压 ${f} (${(sz / 1048576).toFixed(1)} MiB)`);
  const tmp = join(SRC, `.unpack-${basename(f, '.zip')}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  // 优先用系统 unzip（保留中文文件名），Windows 无 unzip 时回退 PowerShell
  try {
    await exec('unzip', ['-q', '-o', p, '-d', tmp], { maxBuffer: 1 << 28 });
  } catch {
    await exec('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${p.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`],
      { maxBuffer: 1 << 28 });
  }
  const roots = await findVideoRoots(tmp);
  if (!roots.length) {
    console.warn(`  ! 未找到 videos/ 目录，跳过 ${f}`);
    await rm(tmp, { recursive: true, force: true });
    continue;
  }
  for (const root of roots) {
    await copyTree(root, OUT, f);
  }
  await rm(tmp, { recursive: true, force: true });
}

// 汇总各分类，便于确认分件确实都合并进来了
const summary = [];
let total = 0;
for (const e of await readdir(OUT, { withFileTypes: true })) {
  const p = join(OUT, e.name);
  if (e.isDirectory()) {
    const n = await webmCount(p);
    summary.push([e.name, n]);
    total += n;
  } else if (/\.webm$/i.test(e.name)) total++;
}
console.log(`\n完成：${copied} 个文件写入 ${OUT}（其中 ${replaced} 个同名覆盖）`);
console.log(`分类统计：${summary.map(([k, n]) => `${k}=${n}`).join('  ')}  根目录=${total - summary.reduce((a, [, n]) => a + n, 0)}`);
console.log(`WebM 合计 ${total} 段。重新执行 npm run build:nsis / build:portable 即可打进安装包。`);
if (collisions.length) {
  console.log(`\n同名覆盖明细（前 20 条，通常表示分件里同一动画被更新）：`);
  for (const c of collisions.slice(0, 20)) console.log(`  ${c}`);
}

async function findVideoRoots(dir) {
  const out = [];
  async function walk(d, depth) {
    if (depth > 6) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (e.name.toLowerCase() === 'videos') { out.push(p); continue; }
      await walk(p, depth + 1);
    }
  }
  await walk(dir, 0);
  return out;
}

async function copyTree(src, dst, from) {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const a = join(src, e.name), b = join(dst, e.name);
    if (e.isDirectory()) { await copyTree(a, b, from); continue; }
    // 直接用 fs.copyFile，避免为每个文件启动一个 node 子进程（完整包有上千文件）
    let exists = true;
    try { await stat(b); } catch { exists = false; }
    await copyFile(a, b);
    copied++;
    if (exists) { replaced++; collisions.push(`${relative(OUT, b)} ← ${from}`); }
  }
}
