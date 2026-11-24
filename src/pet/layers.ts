// 浮层坐标：旧壁纸层宠物坐标落在 x/y，移除壁纸后统一迁移到浮层。
import type { PetConfig } from '../types';

export const posOf = (p: PetConfig): [number, number] =>
  (p.ox ?? -1) >= 0 && (p.oy ?? -1) >= 0 ? [p.ox!, p.oy!] : [p.x, p.y];
