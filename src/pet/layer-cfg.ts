// 分层配置：同一项在壁纸层 / 浮层各有一份。missing 时回退到旧版共用键。
import type { Config } from '../types';

type Layer = 'wallpaper' | 'overlay';

export const layerOpacity = (c: Config, layer: Layer) =>
  (layer === 'overlay' ? c.overlay_opacity ?? c.pet_opacity : c.wallpaper_opacity ?? c.pet_opacity) ?? 100;
export const layerLock = (c: Config, layer: Layer) =>
  (layer === 'overlay' ? c.overlay_lock_position ?? c.lock_position : c.wallpaper_lock_position ?? c.lock_position) ?? false;
export const layerShiftDrag = (c: Config, layer: Layer) =>
  (layer === 'overlay' ? c.overlay_shift_drag ?? c.shift_drag : c.wallpaper_shift_drag ?? c.shift_drag) ?? false;
