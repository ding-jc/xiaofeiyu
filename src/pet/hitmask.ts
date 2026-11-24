// 非透明像素命中：把每只桌宠当前帧的 alpha 栅格化成全屏遮罩，
// 生成 HRGN 交给原生命中窗：透明区整棵窗口树退出命中，原生直达下层。
import { api } from '../bridge';
import type { Pet } from './pet';

const GW = 256, GH = 144;  // 全屏遮罩网格（约 7.5px / 格），决定 region 精度
const ALPHA = 16;          // 过滤半透明描边，放宽阈值保住抗锯齿边缘像素

export class HitMask {
  private bits = new Uint8Array(GW * GH);
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null;
  private timer = 0;
  private tainted = false;
  private readonly sw = 48;
  private readonly sh = 27;
  private readonly interval = 200;

  constructor(private pets: () => Pet[]) {
    this.canvas.width = this.sw;
    this.canvas.height = this.sh;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  private dragPaused = false;
  start() {
    this.stop();
    if (this.dragPaused) return;
    this.timer = window.setInterval(() => this.refresh(), this.interval);
    this.refresh();
  }
  stop() { window.clearInterval(this.timer); this.timer = 0; }
  /** 拖动期整窗 region 用不到 mask：停掉 14ms 的同步采样，避免位置变化掉帧。 */
  setDragPaused(on: boolean) {
    if (on === this.dragPaused) return;
    this.dragPaused = on;
    if (on) this.stop(); else this.start();
  }

  private cell(x: number, y: number) {
    const gx = Math.floor(x / (window.innerWidth / GW));
    const gy = Math.floor(y / (window.innerHeight / GH));
    return gx < 0 || gx >= GW || gy < 0 || gy >= GH ? -1 : gy * GW + gx;
  }
  isOpaque(x: number, y: number) { const i = this.cell(x, y); return i >= 0 && this.bits[i] === 1; }

  /** 读当前帧 alpha；canvas 被跨域污染时退化为矩形命中（仍能工作，只是不精确）。 */
  private sample(v: HTMLVideoElement): Uint8ClampedArray | null {
    if (!this.ctx || this.tainted) return null;
    try {
      this.ctx.clearRect(0, 0, this.sw, this.sh);
      this.ctx.drawImage(v, 0, 0, this.sw, this.sh);
      return this.ctx.getImageData(0, 0, this.sw, this.sh).data;
    } catch {
      this.tainted = true;
      return null;
    }
  }

  private refresh() {
    if (document.hidden) return;
    const next = new Uint8Array(GW * GH);
    const cw = window.innerWidth / GW, ch = window.innerHeight / GH;
    for (const pet of this.pets()) {
      const v = pet.stage.querySelector<HTMLVideoElement>('video.pet-clip.on');
      if (!v || v.readyState < 2 || !v.videoWidth) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const mirror = pet.stage.style.transform.includes('scaleX(-1)');
      const alpha = this.sample(v);
      const x0 = Math.max(0, Math.floor(r.left / cw)), x1 = Math.min(GW - 1, Math.floor(r.right / cw));
      const y0 = Math.max(0, Math.floor(r.top / ch)), y1 = Math.min(GH - 1, Math.floor(r.bottom / ch));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const u = ((gx + .5) * cw - r.left) / r.width;
          const w = ((gy + .5) * ch - r.top) / r.height;
          if (u < 0 || u >= 1 || w < 0 || w >= 1) continue;
          const sx = Math.min(this.sw - 1, Math.floor((mirror ? 1 - u : u) * this.sw));
          const sy = Math.min(this.sh - 1, Math.floor(w * this.sh));
          if (alpha && alpha[(sy * this.sw + sx) * 4 + 3] < ALPHA) continue;
          next[gy * GW + gx] = 1;
        }
      }
    }
    this.bits = next;
    api.overlayHitMask(GW, GH, Array.from(next)).catch(() => {});
  }
}
