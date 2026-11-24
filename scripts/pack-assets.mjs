// 把内置角色素材打成一个 zip，供 CI 从对象存储拉取（仓库本身不收录素材）。
// 用法：npm run assets:pack → dist-assets/characters.zip
import AdmZip from 'adm-zip';
import { readdir, mkdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SRC = 'src-tauri/resources/characters';
const OUT = 'dist-assets/characters.zip';

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name !== '.gitkeep') out.push(p);
  }
  return out;
}

const files = await walk(SRC);
if (!files.length) {
  console.error(`${SRC} 里没有素材，先 npm run assets`);
  process.exit(1);
}

const zip = new AdmZip();
for (const f of files) zip.addLocalFile(f, relative(SRC, join(f, '..')).replaceAll('\\', '/'));
await mkdir('dist-assets', { recursive: true });
zip.writeZip(OUT);

const { size } = await stat(OUT);
const ids = new Set(files.map((f) => relative(SRC, f).split(/[\\/]/)[0]));
console.log(`${OUT} · ${files.length} 个文件 · ${ids.size} 个角色 · ${(size / 1048576).toFixed(1)} MB`);
