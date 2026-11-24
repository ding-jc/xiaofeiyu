// 把旧素材包（character.json / manifest.json / move_strides.json / text_clips.json 分散）
// 合并为 xiaofeiyu-asset-v1 单清单 config.json。无损迁移：旧字段全部保留，新能力字段给默认值。
// 用法：node scripts/migrate-assets.mjs [--dry]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const charsDir = join(root, 'src-tauri/resources/characters');
const dry = process.argv.includes('--dry');
const FORMAT = 'xiaofeiyu-asset-v1';

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

// 浅合并，先到先得（优先级：character.json > videos/manifest.json > ...）
function merge(...objs) {
  const out = {};
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    for (const [k, v] of Object.entries(o)) if (!(k in out)) out[k] = v;
  }
  return out;
}

function migrate(id) {
  const dir = join(charsDir, id);
  const videos = join(dir, 'videos');
  const rootChar = readJson(join(dir, 'character.json'));
  const rootManifest = readJson(join(dir, 'manifest.json'));
  const vChar = readJson(join(videos, 'character.json'));
  const vManifest = readJson(join(videos, 'manifest.json'));
  const strides = readJson(join(videos, 'move_strides.json')) ?? readJson(join(videos, 'strides.json'));
  const textClips = readJson(join(videos, 'text_clips.json'));

  const base = merge(rootChar, rootManifest, vChar, vManifest);
  if (!base.id) base.id = id;
  if (!base.name) base.name = id;

  // 汇总 noMirror（去重）
  const noMirror = [
    ...(base.noMirror ?? base.no_mirror ?? []),
    ...(textClips?.noMirror ?? textClips?.no_mirror ?? []),
  ];
  const nm = [...new Set(noMirror.filter(Boolean))];

  // 组装新清单：先铺旧字段（保持同名兼容），再覆盖 format，最后补新能力字段
  const cfg = {
    format: FORMAT,
    ...base,
    id: base.id,
    name: base.name,
    ...(nm.length ? { noMirror: nm } : {}),
    ...(strides ? { strides } : {}),
  };
  // 清掉旧字段别名，统一 camelCase（解析器两种都认，这里规范化）
  delete cfg.no_mirror;
  delete cfg.feet_y;
  delete cfg.move_strides;
  delete cfg.body_box;
  delete cfg.head_box;

  if (!cfg.persona) {
    cfg.persona = { systemPrompt: cfg.prompt ?? '', selfTalk: [], tags: [] };
  }
  if (!cfg.audio) {
    cfg.audio = { click: 'sounds/click.wav', clickVolume: 0.7, throttleMs: 100 };
  }
  if (!cfg.media) {
    cfg.media = { formats: ['webm', 'mov'], safariDir: 'videos-mov' };
  }
  if (!cfg.recipe) cfg.recipe = 'recipe.md';

  const out = join(dir, 'config.json');
  if (dry) {
    console.log(`[dry] ${id}: ${Object.keys(cfg).length} 字段, noMirror=${nm.length}, strides=${Object.keys(strides ?? {}).length}, actions=${Object.keys(cfg.actions ?? {}).length}`);
  } else {
    writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log(`迁移 ${id} -> config.json`);
  }
}

const dirs = readdirSync(charsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => existsSync(join(charsDir, n, 'character.json')) || existsSync(join(charsDir, n, 'config.json')))
  .sort();

console.log(`发现 ${dirs.length} 个角色: ${dirs.join(', ')}`);
for (const id of dirs) migrate(id);
console.log(dry ? '预览完成（未写入）' : '迁移完成');
