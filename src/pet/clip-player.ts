// A/B 双缓冲 WebM 播放：换片时先解码下一片再切可见性，切换完成立刻释放上一片解码器。
type FrameCb = (now: number, meta: { mediaTime: number }) => void;
type VVideo = HTMLVideoElement & {
  requestVideoFrameCallback(cb: FrameCb): number;
  cancelVideoFrameCallback(h: number): void;
};

import { fitToBox, type Box } from './normalizer';

export interface PlayOpts {
  loop: boolean;
  rate: number;
  /** 逐段归一化目标框（body_box）：无则不处理。 */
  fitBox?: Box;
  onReady?: (duration: number) => void;
  onEnd?: () => void;
  onFrame?: (mediaTime: number) => void;
}

function mk(): VVideo {
  const v = document.createElement('video') as VVideo;
  v.className = 'pet-clip';
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disablePictureInPicture = true;
  (v as HTMLVideoElement & { controls: boolean }).controls = false;
  return v;
}

export class ClipPlayer {
  private els: [VVideo, VVideo];
  private front = 0;
  private seq = 0;
  private active: VVideo | null = null;
  private frameHandle = 0;
  private paused = false;
  private rate = 1;

  constructor(host: HTMLElement) {
    this.els = [mk(), mk()];
    this.els[0].classList.add('on');
    host.append(this.els[0], this.els[1]);
  }

  private stopFrames() {
    if (this.frameHandle && this.active) {
      try { this.active.cancelVideoFrameCallback(this.frameHandle); } catch { /* noop */ }
    }
    this.frameHandle = 0;
  }

  private startFrames(el: VVideo, seq: number, cb: (t: number) => void) {
    if (typeof el.requestVideoFrameCallback !== 'function') return;
    const step: FrameCb = (_now, meta) => {
      if (seq !== this.seq) return;
      cb(meta.mediaTime);
      this.frameHandle = el.requestVideoFrameCallback(step);
    };
    this.frameHandle = el.requestVideoFrameCallback(step);
  }

  play(src: string, opts: PlayOpts) {
    const seq = ++this.seq;
    this.rate = opts.rate;
    this.stopFrames();
    const back = this.els[1 - this.front];
    const old = this.els[this.front];
    back.pause();
    // 与非透明像素命中检测共用：允许把带 alpha 的当前帧读进 canvas
    if (/^https?:/.test(src)) back.crossOrigin = 'anonymous';
    else back.removeAttribute('crossorigin');
    back.src = src;
    back.loop = opts.loop;
    back.playbackRate = opts.rate;
    back.load();

    let settled = false;
    const swap = () => {
      if (settled || seq !== this.seq) return;
      settled = true;
      const go = () => {
        if (seq !== this.seq) return;
        back.play().then(() => {
          if (seq !== this.seq) return; // 过期：交给最新一次 play 处理，别误暂停它的视频

          // 等首帧真正绘制后再切可见性：video 未绘帧时会露出白色占位矩形，
          // 快速连点换片频繁，这段窗口被放大成肉眼可见的闪白。旧片留到首帧就绪再撤。
          let revealed = false;
          const reveal = () => {
            if (revealed || seq !== this.seq) return;
            revealed = true;
            back.classList.add('on');
            old.classList.remove('on');
            this.front = 1 - this.front;
            this.active = back;
            old.pause();
            old.removeAttribute('src');
            old.load();
            if (Number.isFinite(back.duration)) opts.onReady?.(back.duration);
            if (!opts.loop) {
              back.addEventListener('ended', () => { if (seq === this.seq) opts.onEnd?.(); }, { once: true });
            }
            if (opts.onFrame) this.startFrames(back, seq, opts.onFrame);
            if (this.paused) back.pause();
          };

          // 逐段归一化：首帧若能测出内容框立即应用，否则随帧重试（淡入首帧常全透明）
          if (opts.fitBox) {
            let tries = 0;
            const fit = () => {
              if (seq !== this.seq) return;
              if (fitToBox(back, src, opts.fitBox!)) return;
              if (tries++ < 24 && typeof back.requestVideoFrameCallback === 'function') {
                back.requestVideoFrameCallback(fit);
              }
            };
            fit();
          }

          if (this.paused || typeof back.requestVideoFrameCallback !== 'function') {
            reveal(); // 暂停态无新帧可等，loadeddata 已保证首帧就绪；老内核退回立即切换
          } else {
            back.requestVideoFrameCallback(() => reveal()); // 首帧提交后再显示
            window.setTimeout(reveal, 600); // 异常兜底：解码卡死时也别让画面停在前一片
          }
        }).catch(() => { if (seq === this.seq) opts.onEnd?.(); });
      };
      go();
    };
    back.addEventListener('loadeddata', swap, { once: true });
    back.addEventListener('error', () => { if (seq === this.seq) opts.onEnd?.(); }, { once: true });
    window.setTimeout(swap, 1200);
  }

  /**
   * 大小统一（对齐原项目 window._rebuild_frame）：视频帧直接拉伸填满画布
   * （IgnoreAspectRatio scaled 的 CSS 等价，.pet-clip 铺满 pet-stage）。
   * 画布坐标系恒一致，body_box / feet_y 等元数据直接可用，无需运行时猜测。
   */
  pause() { this.paused = true; this.els.forEach((v) => v.pause()); }

  resume() {
    this.paused = false;
    if (this.active && this.active.paused) this.active.play().catch(() => {});
  }

  /** 当前可见视频的播放头（媒体秒）；用于和动画帧严格同步的水平位移。未开播返回 0。 */
  time(): number { return this.active?.currentTime ?? 0; }

  setRate(r: number) { this.rate = r; this.els.forEach((v) => { v.playbackRate = r; }); }

  destroy() {
    this.seq++;
    this.stopFrames();
    this.els.forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); });
  }
}
