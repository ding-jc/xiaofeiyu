// 免安装版：把 release 产物 + 内置素材打包成 zip，并写入 portable.txt 标记。
import { existsSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const root = process.cwd();
const exe = join(root, 'src-tauri/target/release/pixup-pet.exe');
if (!existsSync(exe)) {
  console.error('缺少 release 可执行文件，请先运行: npm run build:app -- --no-bundle 或 npm run tauri -- build');
  process.exit(1);
}

const outDir = join(root, 'dist-portable');
mkdirSync(outDir, { recursive: true });
// 暂存区用系统临时目录，避开可能被资源管理器/杀毒锁定的旧 dist-portable/pixup-pet
const stage = join(tmpdir(), `pixup-pet-${Date.now()}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(exe, join(stage, basename(exe)));
const unreg = join(root, 'scripts/unregister-protocol.cmd');
if (existsSync(unreg)) copyFileSync(unreg, join(stage, 'unregister-protocol.cmd'));
writeFileSync(join(stage, 'portable.txt'), 'portable build: config/logs/characters are stored in ./data\n');
if (existsSync(join(root, 'src-tauri/resources/characters'))) {
  cpSync(join(root, 'src-tauri/resources/characters'), join(stage, 'resources/characters'), { recursive: true });
}
if (existsSync(join(root, 'src-tauri/resources/sounds'))) {
  cpSync(join(root, 'src-tauri/resources/sounds'), join(stage, 'resources/sounds'), { recursive: true });
}
writeFileSync(join(stage, 'README.txt'), [
  '小肥鱼宠物 · 免安装版',
  '',
  '双击 pixup-pet.exe 即可运行，无需安装、无需管理员权限。',
  '配置、日志与导入的素材包保存在同目录 data/ 下，删除整个文件夹即完成卸载。',
  '卸载前请先运行同目录的 unregister-protocol.cmd 清理 video-json-pet:// 浏览器唤起协议。',
  '首次运行会附着到桌面壁纸层；若看不到桌宠，先点一下桌面（或按 Win+D），',
  '再从系统托盘图标打开菜单。',
  '',
  '需要完整交互（右键菜单不被 Windows 原生菜单干扰）时，',
  '托盘 → 桌宠设置 → 壁纸层 → 关闭「附着到壁纸层」切换为浮层模式。',
].join('\n'));

const zipPath = join(outDir, 'pixup-pet-portable.zip');
const output = createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 6 } });
output.on('close', () => {
  const mb = (readFileSync(zipPath).length / 1048576).toFixed(1);
  console.log(`免安装版已生成: ${zipPath} (${mb} MB)`);
  rmSync(stage, { recursive: true, force: true });
  try { rmSync(join(outDir, 'pixup-pet'), { recursive: true, force: true }); } catch {}
});
archive.on('error', (e) => { throw e; });
archive.pipe(output);
archive.directory(stage, 'pixup-pet');
await archive.finalize();
