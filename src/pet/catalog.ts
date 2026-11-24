import type { CharacterPack, Clip } from '../types';

// 几何/概率常量与原项目 pet/catalog.py 完全一致
export const CANVAS_W = 640;
export const CANVAS_H = 360;
export const FEET_Y = 330;
export const PAD = CANVAS_H - FEET_Y;
export const FRAME_MS = 42;
export const P_IDLE = 0.30;
export const P_TURN = 0.40;
export const P_ACTS = 0.80;
export const MOVE_MIN_PX = 60;
export const MOVE_MAX_PX = 240;
export const MOVE_MARGIN = 20;
export const MOVE_STRIDE_DEFAULT_PX = 120;
export const DRAG_THRESHOLD = 5;
export const DEFAULT_SCALE = 0.72;
export const CORNER_MARGIN = 24;
export const SCALE_STEPS = [0.5, 0.72, 0.85, 1.0];
export const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const CATS = ['idle', 'turn', 'move', 'click', 'drag', 'random', 'events'] as const;

// 分类显示名/顺序 + 蓝毛小女仆原版细分归类：见独立模块（clip.category 不变，仅用于显示分组）。
export { CATEGORY_LABELS, CATEGORY_ORDER, viewCategory } from './action-categories';

// 内置 9 位角色的展示顺序（主界面卡片 / 切换角色菜单一致）
export const BUILTIN_ORDER = [
  'shenshen', 'ojousama', 'character3', 'character4', 'character5',
  'character6', 'character11', 'character12', 'character13',
];
export function sortPacks<T extends { id: string }>(list: T[]): T[] {
  const rank = (id: string) => { const i = BUILTIN_ORDER.indexOf(id); return i < 0 ? 1000 : i; };
  return [...list].sort((a, b) => rank(a.id) - rank(b.id));
}

export function clips(pack: CharacterPack, cat: string): Clip[] {
  return pack.clips[cat] ?? [];
}

export function pick(pack: CharacterPack, cat: string, exclude?: string): Clip | null {
  let list = clips(pack, cat);
  if (exclude && list.length > 1) list = list.filter((c) => c.name !== exclude);
  if (!list.length) return null;
  return list[(Math.random() * list.length) | 0];
}

export function idle(pack: CharacterPack): Clip | null {
  return clips(pack, 'idle')[0] ?? clips(pack, 'random')[0] ?? null;
}

/**
 * 取动画的走位配置（蓝毛小女仆 strides 标准：stride=总位移px，curve=逐帧进度）。
 * configured=false 表示素材没有为该动画配置移动——调用方必须放弃位移，不要套默认值硬加移动效果。
 */
export function strideOf(pack: CharacterPack, clip: Clip): { stride: number; curve?: number[]; configured: boolean } {
  const key = Object.keys(pack.strides).find(
    (k) => !k.startsWith('_') && (clip.name.includes(k) || k.includes(clip.name)),
  );
  const s = key ? pack.strides[key] : undefined;
  if (!s || typeof s.stride !== 'number') return { stride: 0, curve: undefined, configured: false };
  return { stride: s.stride, curve: s.curve, configured: true };
}

/** 按播放进度 t(0~1) 采样逐帧累计位移曲线，相邻帧线性插值；无有效曲线返回 null 让调用方回退线性。 */
export function sampleCurve(curve: number[] | undefined, t: number): number | null {
  if (!curve || curve.length < 2) return null;
  const f = Math.max(0, Math.min(1, t)) * (curve.length - 1);
  const i = f | 0;
  const j = i + 1 < curve.length ? i + 1 : i;
  return curve[i] + (curve[j] - curve[i]) * (f - i);
}

export function clipCount(pack: CharacterPack): number {
  return Object.values(pack.clips).reduce((n, v) => n + v.length, 0);
}

export const BUBBLE_PRESETS: Record<string, { label: string; placement: string; background: string; border: string; foreground: string; radius: number; shadow: string }> = {
  classic_top: { label: '经典暖黄 · 正上方', placement: 'top', background: '#fffaf0', border: '#efc261', foreground: '#403725', radius: 14, shadow: '#6b542b' },
  paper_left: { label: '纸感卡片 · 左上方', placement: 'top_left', background: '#ffffff', border: '#dce1e7', foreground: '#252a32', radius: 11, shadow: '#374151' },
  glass_right: { label: '深色玻璃 · 右上方', placement: 'top_right', background: '#292d36', border: '#4d5360', foreground: '#f7f8fb', radius: 18, shadow: '#111318' },
  soft_blue_top: { label: '柔蓝对话 · 正上方', placement: 'top', background: '#eef6ff', border: '#a9c9ef', foreground: '#24466f', radius: 16, shadow: '#315f91' },
  breath_bubble: { label: '吐气水泡 · 左上方', placement: 'top_left', background: '#fbfeff', border: '#0e5968', foreground: '#23444d', radius: 0, shadow: '#0e5968' },
};
