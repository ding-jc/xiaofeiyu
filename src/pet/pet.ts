// 单只桌宠：独立档案、DOM+video 渲染、拖动/抛掷/弹弓、碰撞、边缘探头、黄金回旋、气泡。
import type { CharacterPack, Config, PetConfig, PetProfile } from '../types';
import { defaultProfile } from '../data/defaults';
import { Behavior } from './behavior';
import { Bubble } from './bubble';
import { ClipPlayer } from './clip-player';
import { CORNER_MARGIN, DRAG_THRESHOLD, PAD } from './catalog';
import { posOf } from './layers';
import { stepBody, type Body } from './physics';
import { layerLock, layerShiftDrag } from './layer-cfg';
import type { World } from './engine';
import { petUrl } from '../asset-url';

// 点击音效：与原版（client.js::playClickSound）对齐——单段 wav、复用一个 Audio 实例。
// 100ms 全局节流收口在后端唯一的 slot：壁纸层走 click_sound_gate command；
// 浮层由原生命中窗在 WM_LBUTTONUP 本地裁决（早于壁纸层 WebView 的 IPC），结果随 up 事件下发。
const CLICK_SOUND_VOLUME = 0.5;
let clickAudio: HTMLAudioElement | null = null;

export class Pet {
  readonly id: string;
  readonly root: HTMLDivElement;
  readonly stage: HTMLDivElement;
  readonly hit: HTMLDivElement;
  readonly player: ClipPlayer;
  readonly behavior: Behavior;
  readonly bubble: Bubble;
  readonly body: Body;
  pack: CharacterPack;
  profile: PetProfile;
  scale: number;
  facing: 'left' | 'right' = 'left';
  x = 0;
  y = 0;
  private down = false;
  private moved = false;
  private sx = 0;
  private sy = 0;
  private ox = 0;
  private oy = 0;
  private lastT = 0;
  private lastX = 0;
  private lastY = 0;
  private spinAngle = 0;
  private spinTimer = 0;
  private spinSpeed = 700;
  private probe = 0;              // -1 左 / 0 无 / 1 右
  private probeHold = 0;
  private downTime = 0;
  private slingStart = 0;

  constructor(readonly world: World, conf: PetConfig, pack: CharacterPack, private cfg: () => Config) {
    this.id = conf.id;
    this.pack = pack;
    this.profile = defaultProfile(conf.profile ?? {});
    this.scale = conf.scale || this.profile.scale || 1;
    this.facing = conf.facing === 'right' ? 'right' : 'left';

    this.root = document.createElement('div');
    this.root.className = 'pet';
    this.root.dataset.id = this.id;
    this.stage = document.createElement('div');
    this.stage.className = 'pet-stage';
    this.hit = document.createElement('div');
    this.hit.className = 'pet-hit';
    this.root.append(this.stage, this.hit);
    // 根节点原点=左上角，与物理 body 坐标一致：缩放不漂移，脚底恒贴地面。
    // 挤压/旋转在 stage 层围绕脚底轴（见 applyStageTransform），压扁不位移。
    world.layer.append(this.root);

    this.player = new ClipPlayer(this.stage);
    this.bubble = new Bubble(this.root, world.layer);
    this.behavior = new Behavior(this, cfg);

    this.applyPack(pack);
    const W = this.world.width();
    const H = this.world.height();
    // 每层各自记位置：壁纸层用 x/y，浮层用 ox/oy；还没落过位就贴右下角
    const [px, py] = posOf(conf);
    this.x = px >= 0 ? px : W - this.width - CORNER_MARGIN;
    this.y = py >= 0 ? py : H - this.height - CORNER_MARGIN;
    this.body = {
      x: this.x, y: this.y, vx: 0, vy: 0, w: this.width, h: this.height, dragging: false, angle: 0,
      scale: this.scale, circles: [], mass: 1, infinite: false, px: this.x, py: this.y, tag: conf.id, hit: 0,
      knock: 0, knockDamp: 0, box: this.bodyBox(),
    };
    this.applyTransform();
    this.bindEvents();
    this.behavior.start();
  }

  get width() { return this.pack.canvas[0] * this.scale; }
  get height() { return this.pack.canvas[1] * this.scale; }
  /** 身体框相对 pet 左上角的偏移（body_box×scale，缺省=整画布）：贴边/落地共用口径。 */
  bodyBox(): { l: number; t: number; r: number; b: number } {
    const bb = this.pack.body_box;
    const [w, h] = this.pack.canvas;
    const l = (bb?.[0] ?? 0) * this.scale, t = (bb?.[1] ?? 0) * this.scale;
    return { l, t, r: (bb?.[2] ?? w) * this.scale, b: (bb?.[3] ?? h) * this.scale };
  }
  boundsW() { return this.world.width(); }
  effective(base: Config): Config {
    const merged = { ...base, ...this.profile } as Config;
    if (!this.profile.self_talk_texts?.length) merged.self_talk_texts = base.self_talk_texts ?? [];
    return merged;
  }

  applyPack(pack: CharacterPack) {
    this.pack = pack;
    const [w, h] = pack.canvas;
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    if (this.body) this.body.box = this.bodyBox(); // 换角色后身体框随 manifest 更新
    const b = pack.body_box ?? [0, 0, w, h];
    // 挤压/旋转绕脚底水平中点：压扁不位移，缩放交给 root（左上角原点）
    this.stage.style.setProperty('--fx', `${(b[0] + b[2]) / 2}px`);
    this.stage.style.setProperty('--fy', `${b[3]}px`);
    this.hit.style.left = `${b[0]}px`;
    this.hit.style.top = `${b[1] + PAD}px`;
    this.hit.style.width = `${Math.max(20, b[2] - b[0])}px`;
    this.hit.style.height = `${Math.max(20, b[3] - b[1])}px`;
    const hb = pack.head_box ?? [w * 0.3, h * 0.12, w * 0.7, h * 0.52];
    this.root.style.setProperty('--bubble-x', `${(hb[0] + hb[2]) / 2}px`);
    this.root.style.setProperty('--bubble-y', `${hb[1] + PAD}px`);
    this.setMirror(this.facing === 'right');
  }

  setSpeed(v: number) {
    this.setProfile('playback_speed', v);
    this.player.setRate(v);
    this.behavior.reset();
  }
  setProfile(key: string, value: unknown) {
    this.profile = { ...this.profile, [key]: value };
    this.world.saveSlot(this);
  }
  setScale(s: number) {
    const b = this.world.workBounds();
    const floorOf = () => Math.max(b.y - this.body.box.t, b.y + b.h - this.body.box.b);
    const onGround = Math.abs(this.body.y - floorOf()) < 1 && Math.abs(this.body.vy) < 1;
    this.scale = s;
    this.body.w = this.width;
    this.body.h = this.height;
    this.body.scale = s;
    this.body.box = this.bodyBox();
    if (onGround) { this.y = this.body.y = floorOf(); } // 贴地缩放：脚底锚定地面
    this.applyTransform();
  }
  private mirrored = false;
  setMirror(v: boolean) { this.mirrored = v; if (this.body) this.applyTransform(); }

  /** 自主走位：直接写水平位置并同步物理体，不走重力；y 保持不变（贴地行走）。 */
  walkTo(x: number) {
    this.x = x;
    this.body.x = x;
    this.body.px = x;
    this.applyTransform();
  }

  // ---- 碰撞挤压变形（z 轴 squash & stretch）：撞击时压扁 + 阻尼振荡回弹 ----
  private squashT = 0;
  private squashDur = 0.55;
  private squashPower = 0;

  /** 撞击变形：power 0~0.5，撞击越猛压得越扁、弹回越明显；dur 可指定时长（点击用极短）。 */
  squash(power: number, dur = 0.55) {
    this.squashPower = Math.max(this.squashPower, Math.max(0.05, Math.min(0.5, power)));
    this.squashDur = dur;
    if (this.squashT <= 0) this.squashT = this.squashDur;
  }

  applyTransform() {
    // root：定位 + 尺寸缩放，原点左上角 → 渲染左上角 = body 坐标，脚底恒贴物理地面
    this.root.style.transform =
      `translate3d(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px, 0) scale(${this.scale.toFixed(3)})`;
    // stage：挤压变形 + 抛掷旋转，原点脚底（scale/style.scale 独立属性负责镜像）
    const rot = this.spinAngle || this.body.angle || 0;
    let sx = 1, sy = 1;
    if (this.squashT > 0) {
      const t = 1 - this.squashT / this.squashDur;
      const osc = Math.sin(t * Math.PI * 2.5) * (1 - t) * this.squashPower;
      sy = 1 - osc * 0.55; // z 轴压扁 + 横向鼓起
      sx = 1 + osc * 0.4;
    }
    const mirror = this.mirrored ? 'scaleX(-1) ' : '';
    this.stage.style.transform = `${mirror}scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${rot.toFixed(1)}deg)`;
    if (this.body && !this.body.dragging) { this.body.x = this.x; this.body.y = this.y; }
  }

  setOpacity(v: number) { this.root.style.opacity = String(Math.max(0.1, Math.min(1, v))); }

  /** 黄金回旋：连点逐圈加速 700ms → ×0.82 → 200ms 下限 */
  spin() {
    if (!this.cfg().golden_spin_enabled) return;
    this.spinSpeed = Math.max(200, this.spinTimer > 0 ? this.spinSpeed * 0.82 : 700);
    this.spinTimer = this.spinSpeed / 1000;
    window.clearInterval(this.spinHandle);
    this.spinHandle = window.setInterval(() => {
      this.spinAngle = (this.spinAngle + 12) % 360;
      this.applyTransform();
    }, 16);
  }
  private spinHandle = 0;

  /** 边缘探头：±45° 姿态，常驻露出 0.55、点击拉直 0.82、数秒自动退回 */
  private updateProbe() {
    const c = this.cfg();
    if (!c.edge_probe_enabled || this.body.dragging) {
      if (this.probe) { this.probe = 0; this.root.classList.remove('probe-left', 'probe-right'); this.applyTransform(); }
      return;
    }
    const nearRight = this.x + this.width * 0.65 >= this.world.width() - 8;
    const nearLeft = this.x <= -this.width * 0.35 + 8;
    const next = nearRight ? 1 : nearLeft ? -1 : 0;
    if (next === this.probe) return;
    this.probe = next;
    this.root.classList.toggle('probe-left', next === -1);
    this.root.classList.toggle('probe-right', next === 1);
    this.probeHold = 4;
    this.applyTransform();
  }

  private bindEvents() {
    // 壁纸层：插件 raw-input 转发把桌面态鼠标事件复制进 DOM（透明像素也会收到），交互按配置门控。
    // 浮层：region 内 WebView2 原生投递；整层穿透时一律不响应。
    const gate = (e: { clientX: number; clientY: number }) => {
      const c = this.cfg();
      if (c.overlay_mouse_through) return false;
      return this.world.hitMask.isOpaque(e.clientX, e.clientY); // 透明像素不触发桌宠交互
    };
    this.hit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!gate(e)) return;
      const c = this.cfg();
      if (layerShiftDrag(c, this.world.view) && !e.shiftKey) return;
      if (!this.beginDrag(e.clientX, e.clientY)) return;
      window.addEventListener('pointermove', this.onMove);
      window.addEventListener('pointerup', this.onUp, { once: true });
      window.addEventListener('blur', this.onBlur, { once: true });
      e.preventDefault();
    });
    this.hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (gate(e)) this.world.openMenu(e.clientX, e.clientY, this);
    });
    this.hit.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (gate(e)) this.behavior.onDoubleClick();
    });
    this.hit.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || (this.world.isOverlay && this.cfg().overlay_mouse_through)) return;
      e.preventDefault();
      this.world.setScale(this, this.scale + (e.deltaY > 0 ? -0.05 : 0.05));
    }, { passive: false });
    // 浮层：鼠标移上去冒出跟随光标的角色名牌（壁纸层不做，避免和桌面自说自话打架）
    if (this.world.isOverlay) {
      this.hit.addEventListener('pointerenter', (e) => {
        if (!this.cfg().overlay_mouse_through) this.world.hoverName(this, e.clientX, e.clientY);
      });
      this.hit.addEventListener('pointerleave', () => this.world.hoverName(null));
    }
  }

  /** 开始拖动 / 记录按下点；返回 false 表示被锁定（不响应）。 */
  beginDrag(x: number, y: number): boolean {
    if (layerLock(this.cfg(), this.world.view) || this.profile.no_move) return false;
    this.down = true;
    this.moved = false;
    this.sx = x; this.sy = y;
    this.ox = x - this.x; this.oy = y - this.y;
    this.lastX = x; this.lastY = y;
    this.lastT = this.downTime = this.slingStart = performance.now();
    return true;
  }

  /** 跟随光标移动（拖拽中调用）。 */
  moveDrag(x: number, y: number) {
    if (!this.down) return;
    const dx = x - this.sx, dy = y - this.sy;
    if (!this.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const c = this.cfg();
    if (layerLock(c, this.world.view) || this.profile.no_move) { this.down = false; return; }
    if (!this.moved) {
      this.moved = true;
      this.body.dragging = true;
      this.body.knock = 0; this.body.knockDamp = 0; // 用户接管时清掉击退态
      // 浮层：整窗 region 跟手 + 暂停 mask 采样（否则滞后切边 + 位置变化掉帧）
      this.world.overlayDrag(true);
      this.behavior.onDragStart();
    }
    this.x = x - this.ox; this.y = y - this.oy;
    this.body.x = this.x; this.body.y = this.y;
    const now = performance.now();
    const dt = Math.max(1, now - this.lastT) / 1000;
    this.body.vx = (x - this.lastX) / dt;
    this.body.vy = (y - this.lastY) / dt;
    this.lastX = x; this.lastY = y; this.lastT = now;
    if (this.probe) { // 探头激活时移动被闸门拦住
      this.x = this.probe > 0 ? this.world.width() - this.width * 0.65 : -this.width * 0.35;
      this.body.x = this.x;
    }
    this.applyTransform();
  }

  /** 结束拖动（松手）：拖动则抛出 / 回弹，未移动则视为单击。 */
  endDrag() {
    if (!this.down) return;
    const held = performance.now() - this.downTime;
    this.down = false;
    // 浮层：无论是否真的移动，结束一律恢复 region 与采样（Rust 侧幂等）
    this.world.overlayDrag(false);
    if (this.moved) {
      this.body.dragging = false;
      const c = this.cfg();
      const strength = Number(this.profile.throw_strength ?? 1);
      if (c.slingshot_enabled && held > 450) {
        const k = Math.min(2.2, held / 700) * strength;
        this.body.vx *= k; this.body.vy *= k;
      } else {
        this.body.vx *= strength;
        this.body.vy *= strength;
      }
      // 轻放视为放置：直接停在原地；快速甩出才交给物理抛掷
      if (Math.hypot(this.body.vx, this.body.vy) < 260) { this.body.vx = 0; this.body.vy = 0; }
      this.behavior.onDragEnd();
      this.world.onPetReleased(this);
    } else {
      // 点击完成（松手且未拖动）才触发完整反馈，与原版一致
      this.tap();
      this.world.onPetClicked(this);
    }
  }

  /** 单击反馈：极短撞地变形 + 点击动作 + 音效。 */
  private tap() {
    this.squash(0.3, 0.22);
    this.applyTransform();
    this.behavior.onClick();
    this.sound();
  }

  private onMove = (e: PointerEvent) => { this.moveDrag(e.clientX, e.clientY); };

  private onUp = (_e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('blur', this.onBlur);
    this.endDrag();
  };

  private onBlur = () => {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.endDrag();
  };

  /** 点击音效：单段复用 Audio + currentTime=0 重播。
   *  节流由命中窗在原生层裁决（见 world.overlayClickSound），同步播放零 IPC 往返。 */
  private sound() {
    const c = this.effective(this.cfg());
    if (!c.click_sound_enabled) return;
    if (!this.world.overlayClickSound) return;
    try {
      clickAudio ??= new Audio(petUrl('r/sounds/click-duck.wav'));
      clickAudio.volume = Math.max(0, Math.min(1, c.click_sound_volume ?? CLICK_SOUND_VOLUME));
      clickAudio.currentTime = 0;
      void clickAudio.play().catch(() => {});
    } catch { /* 静默忽略 */ }
  }

  say(text: string, seconds = 3) { this.behavior.say(text, seconds); }

  step(dt: number) {
    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      if (this.spinTimer <= 0) {
        window.clearInterval(this.spinHandle);
        this.spinAngle = 0;
        this.applyTransform();
      }
    }
    if (this.probeHold > 0) {
      this.probeHold -= dt;
      if (this.probeHold <= 0) this.updateProbe();
    }
    const moved = stepBody(this.body, dt, this.effective(this.cfg()), this.world.workBounds());
    // 边界/落地/宠物撞击 → 挤压变形（z 轴压扁回弹）
    if (this.body.hit > 130) this.squash(Math.min(0.5, this.body.hit / 1700 + 0.06));
    if (this.squashT > 0) {
      this.squashT -= dt;
      if (this.squashT <= 0) { this.squashT = 0; this.squashPower = 0; }
    }
    if (moved) {
      this.x = this.body.x;
      this.y = this.body.y;
      this.applyTransform();
    } else if (this.squashT > 0) {
      this.applyTransform(); // 变形动画独立于位移持续播放
    }
    this.updateProbe();
    this.behavior.update(dt);
  }

  toConfig(): PetConfig {
    const base = {
      id: this.id, character: this.pack.id, scale: this.scale, facing: this.facing,
      visible: true, profile: this.profile,
    };
    // 浮层实例把位置写进 ox/oy，x/y 留空，避免覆盖壁纸层的位置
    return this.world.isOverlay
      ? { ...base, x: -1, y: -1, ox: this.x, oy: this.y, layers: { wallpaper: false, overlay: true } }
      : { ...base, x: this.x, y: this.y };
  }

  destroy() {
    window.clearInterval(this.spinHandle);
    this.player.destroy();
    this.bubble.hide();
    this.bubble.dropTag();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerup', this.onUp);
    this.world.overlayDrag(false);
    this.root.remove();
  }
}
