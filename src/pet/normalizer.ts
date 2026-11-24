// 逐段视频内容归一化：部分角色包同一角色的不同动作里角色画得大小不一（离镜头远近不同），
// 切换动作时忽大忽小。换片抽首帧测 alpha 内容框，等比缩放并平移到 body_box，
// 让每段角色等大、脚底齐平；结果与碰撞框同源。按 src 缓存，同一片段只测一次。
export type Box = [number, number, number, number];
type Fit = { s: number; dx: number; dy: number; ox: number; oy: number };
const cache = new Map<string, Fit | null>();

/** 把视频内容框归一化到目标框（CSS transform）；首帧未就绪返回 false 供重试。 */
export function fitToBox(v: HTMLVideoElement, src: string, target: Box): boolean {
  let f = cache.get(src);
  if (f === undefined) { f = measure(v, target); if (f) cache.set(src, f); }
  if (!f) return false;
  v.style.transformOrigin = `${f.ox.toFixed(2)}px ${f.oy.toFixed(2)}px`;
  v.style.transform = `translate(${f.dx.toFixed(2)}px, ${f.dy.toFixed(2)}px) scale(${f.s.toFixed(4)})`;
  return true;
}

/** 抽帧扫描 alpha 内容框 → 归一化参数（采样坐标映射到 640×360 显示坐标系）。 */
function measure(v: HTMLVideoElement, [bl, bt, br, bb]: Box): Fit | null {
  try {
    if (!v.videoWidth) return null;
    const W = 80, H = 45;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null; // 全透明帧，稍后重试
    const kx = 640 / W, ky = 360 / H;
    const cl = x0 * kx, cr = (x1 + 1) * kx, ct = y0 * ky, cb = (y1 + 1) * ky;
    const s = Math.min((br - bl) / (cr - cl), (bb - bt) / (cb - ct));
    const ox = (cl + cr) / 2, oy = (ct + cb) / 2; // 内容框中心 = 缩放原点，脚底随之齐平
    return { s, dx: (bl + br) / 2 - ox, dy: (bt + bb) / 2 - oy, ox, oy };
  } catch { return null; }
}
