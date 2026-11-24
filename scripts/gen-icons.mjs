// 从 lucide-static 生成自包含的 src/data/icons.ts（运行时零依赖，API 不变）。
// 改图标：改下面的 MAP 后 `node scripts/gen-icons.mjs`。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 语义名 → lucide 图标名（约 67 个，保持原语义）。
const MAP = {
  pet: 'paw-print', chat: 'message-circle', screen: 'monitor', size: 'move-diagonal',
  settings: 'settings-2', play: 'circle-play', character: 'user-round', speed: 'gauge',
  physics: 'orbit', corner: 'corner-up-left', pin: 'map-pin', autostart: 'power',
  hide: 'eye-off', eye: 'eye', grip: 'grip-vertical', spawn: 'circle-plus', clear: 'trash-2', pause: 'circle-pause',
  stop: 'square', application: 'grid-2x2', balance: 'scale', harness: 'wrench',
  web: 'globe', update: 'rotate-cw', download: 'download', automation: 'bot',
  todo: 'list-todo', weather: 'sun', island: 'pill', exit: 'log-out',
  search: 'search', interaction: 'activity', add: 'plus', remove: 'minus',
  edit: 'pencil', back: 'chevron-left', save: 'save', info: 'info',
  more: 'ellipsis', copy: 'copy', attach: 'paperclip', send: 'send',
  file: 'file', folder: 'folder', minimize: 'minus', appearance: 'palette',
  template: 'layout-template', sidebar: 'panel-left', retry: 'rotate-ccw',
  thumbs_down: 'thumbs-down', multi_select: 'list-checks', external_link: 'external-link',
  sparkles: 'sparkles', wand: 'wand-sparkles', smile: 'smile', check: 'check',
  heart: 'heart', paw: 'paw-print', gift: 'gift', party: 'party-popper',
  star: 'star', rabbit: 'rabbit', fish: 'fish', bone: 'bone',
  coffee: 'coffee', cloud: 'cloud', zap: 'zap', music: 'music', moon: 'moon',
};

const iconDir = join(process.cwd(), 'node_modules/lucide-static/icons');
const inner = (name) => {
  const svg = readFileSync(join(iconDir, `${name}.svg`), 'utf8');
  // 取 <svg ...> 与 </svg> 之间的图形元素，压掉注释与多余空白。
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');
  return body.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
};

const lines = [];
for (const [semantic, lucide] of Object.entries(MAP)) {
  lines.push(`  ${semantic}: '${inner(lucide)}',`);
}
const out = `// 由 scripts/gen-icons.mjs 从 lucide-static 生成，勿手改。语义名 → Lucide 图标。
// 线性图标 24 网格、圆头圆角；iconSvg 统一包装 stroke。未知名回退 paw-print。
const P: Record<string, string> = {
${lines.join('\n')}
};

export function iconSvg(name: string, size = 18): string {
  const d = P[name] ?? P.pet;
  return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${d}</svg>\`;
}

export const ICON_NAMES = Object.keys(P);
`;
writeFileSync(join(process.cwd(), 'src/data/icons.ts'), out);
console.log(`已生成 src/data/icons.ts（${Object.keys(MAP).length} 个图标，源自 lucide-static）`);
