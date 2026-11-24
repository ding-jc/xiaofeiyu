// 坐标存储：浮层 WebView 用 localStorage 存桌宠的视口 CSS 坐标。
// 读在落位前、写在宠物静止后（防抖）。key 沿用 pet.pos.overlay 以兼容已有用户坐标。
import type { Config } from '../types';

export interface PetPos { x: number; y: number }
type PosMap = Record<string, PetPos>;

const KEY = 'pet.pos.overlay';
// 旧版 identifier/key 遗留的坐标，启动时一次性迁移到新 key 后保留原样以便回滚。
const LEGACY_KEY = 'dshpet.pos.overlay';

function parse(raw: string | null): PosMap {
  try {
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as PosMap : {};
  } catch { return {}; }
}

/** 新 key 无数据时读旧 key 并写回新 key；迁移后两份都在，避免升级丢失坐标。 */
function migrate(): void {
  try {
    if (localStorage.getItem(KEY)) return;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const map = parse(raw);
    if (!Object.keys(map).length) return;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* 配额/隐私模式忽略 */ }
}

function load(): PosMap {
  migrate();
  return parse(localStorage.getItem(KEY));
}

function flush(map: PosMap) {
  // 合并已存坐标，避免后一批覆盖前一批（静止检测是分批触发的）。
  try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...map })); } catch { /* 配额/隐私模式忽略 */ }
}

/** 启动落位前：把已存坐标注入 cfg，Pet 构造经 posOf 读到后直接落位。 */
export function hydrate(cfg: Config): void {
  const map = load();
  for (const p of cfg.pets) {
    const s = map[p.id];
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    p.ox = s.x; p.oy = s.y;
  }
}

let pending: PosMap = {};
let timer = 0;
const DEBOUNCE = 600;

/** 宠物静止后调用：合并本帧静止宠物的坐标，防抖落盘。 */
export function scheduleSave(pets: { id: string; x: number; y: number }[]): void {
  if (!pets.length) return;
  for (const p of pets) pending[p.id] = { x: p.x, y: p.y };
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { flush(pending); pending = {}; }, DEBOUNCE);
}

/** 立即落盘（退出/关窗兜底），把仍在防抖队列的坐标写掉。 */
export function flushNow(pets: { id: string; x: number; y: number }[]): void {
  window.clearTimeout(timer);
  for (const p of pets) pending[p.id] = { x: p.x, y: p.y };
  flush(pending);
  pending = {};
}
