// 世界：置顶透明浮层 WebView 内承载所有桌宠（多槽位）、灵动岛、待办、菜单与全部本地玩法。
import { api } from '../bridge';
import { defaultProfile, mergeConfig } from '../data/defaults';
import { loadConfig } from '../boot';
import type { CharacterPack, Clip, Config, Metrics, PetConfig, PetLayer, QuickLaunchApp } from '../types';
import { Island } from '../ui/island';
import { TodoScheduler } from '../ui/todo-scheduler';
import { el } from '../ui/widgets';
import { BUBBLE_PRESETS, CORNER_MARGIN, clips as catClips, sortPacks, viewCategory } from './catalog';
import { emptyLayout, normLayout, type ActionLayout } from './action-layout';
import { ContextMenu, buildMenu } from './menu';
import { HitMask } from './hitmask';
import { hydrate, scheduleSave, flushNow, type PetPos } from './pos-store';
import { layerLock, layerOpacity } from './layer-cfg';
import { resolveCollisions, circlesFromRect, type Bounds } from './physics';
import { Pet } from './pet';

const PLAYERS: Record<string, string[]> = {
  netease: ['C:/Program Files (x86)/Netease/CloudMusic/cloudmusic.exe', 'C:/Program Files/Netease/CloudMusic/cloudmusic.exe'],
  qqmusic: ['C:/Program Files (x86)/Tencent/QQMusic/QQMusic.exe', 'C:/Program Files/Tencent/QQMusic/QQMusic.exe'],
  kugou: ['C:/Program Files (x86)/KuGou/KGMusic/KuGou.exe', 'C:/Program Files/KuGou/KGMusic/KuGou.exe'],
  soda: ['C:/Program Files (x86)/SodaMusic/SodaMusic.exe', 'C:/Program Files/SodaMusic/SodaMusic.exe'],
};

export class World {
  readonly layer: HTMLElement;
  /** 固定为浮层：兼容下游模块（坐标 / 命中遮罩 / 层级工具）的层级参数。 */
  readonly view: PetLayer = 'overlay';
  cfg: Config;
  packs: CharacterPack[] = [];
  pets: Pet[] = [];
  menu: ContextMenu;
  hitMask: HitMask;
  island?: Island;
  private todoSched?: TodoScheduler;
  private host: HTMLElement;
  private visible = true;
  private paused = false;
  private fullscreen = false;
  private layerVisible = true;
  private hoveredId = '';
  private last = 0;
  private raf = 0;
  private idleAcc = 0;
  private saveCheckAcc = 0;
  private lastSaved = new Map<string, PetPos>();
  private phrase = { self_talk: [] as string[], click: [] as string[], divination: null as unknown, festival: null as unknown };
  private metrics: Metrics | null = null;
  private quietQueue: string[] = [];
  private collisionCooldown = 0;
  private playlists: Record<string, string[]> = {};
  private menuCats: Record<string, Record<string, string[]>> = {};
  private actionLayouts: Record<string, ActionLayout> = {};
  private metas: Record<string, Record<string, unknown>> = {};
  private cursor: Record<string, number> = {};
  /** 浮层命中窗在 WM_LBUTTONUP 本地裁决的音效许可，供本次 tap 消费（见 Pet.sound）。 */
  overlayClickSound = false;
  /** 壁纸层物理边界 = 工作区（扣任务栏），地板落在任务栏上；取不到时回退整屏视口。 */
  private physBounds: Bounds | null = null;

  constructor(host: HTMLElement, cfg: Config) {
    this.cfg = cfg;
    this.host = host;
    this.layerVisible = this.layerOn(cfg);
    this.layer = el('div', 'pet-layer');
    this.layer.id = 'pet-layer';
    host.append(this.layer);
    this.menu = new ContextMenu(() => this.cfg);
    this.hitMask = new HitMask(() => this.pets);
  }

  /** 固定浮层。 */
  get isOverlay() { return true; }
  /** 像素遮罩供原生命中窗逐像素命中。 */
  private startZones() { this.hitMask.start(); }
  private stopZones() { this.hitMask.stop(); }
  /** 浮层拖动：整窗 region 跟手，同时暂停 14ms 的 mask 采样（否则位置变化掉帧）。 */
  overlayDrag(on: boolean) {
    if (!this.isOverlay) return;
    this.hitMask.setDragPaused(on);
    api.overlayDragging(on).catch(() => {});
  }
  private layerOn(c: Config) { return c.overlay_visible !== false; }

  width() { return window.innerWidth; }
  height() { return window.innerHeight; }

  // 浮层窗本身就是工作区尺寸，视口即边界；Rust 下发的工作区矩形用于多显示器拼接送。
  workBounds(): Bounds {
    return this.physBounds ?? { x: 0, y: 0, w: this.width(), h: this.height() };
  }
  /** 拿到工作区后设置物理边界并重新夹紧。IPC 异步，落地后再校正一次。 */
  private refreshWorkBounds() {
    api.workArea(this.view).then((r) => {
      if (r.w > 0 && r.h > 0) { this.physBounds = { x: r.x, y: r.y, w: r.w, h: r.h }; this.clampAll(); }
    }).catch(() => { /* 拿不到就保持视口回退 */ });
  }

  async init() {
    this.packs = sortPacks(await api.packs());
    const [selfTalk, click, div, fest, pl, mt, ct, layout] = await Promise.all([
      api.data<string[]>('self_talk_texts').catch(() => []),
      api.data<string[]>('click_phrases').catch(() => []),
      api.data('divination').catch(() => null),
      api.data('festival').catch(() => null),
      api.data<Record<string, string[]>>('character_playlists').catch((): Record<string, string[]> => ({})),
      api.data<Record<string, Record<string, unknown>>>('character_meta').catch((): Record<string, Record<string, unknown>> => ({})),
      api.data<Record<string, Record<string, string[]>>>('character_categories').catch((): Record<string, Record<string, string[]>> => ({})),
      api.data<Record<string, unknown>>('character_action_layout').catch((): Record<string, unknown> => ({})),
    ]);
    if (pl && typeof pl === 'object' && !Array.isArray(pl)) this.playlists = pl;
    if (mt && typeof mt === 'object' && !Array.isArray(mt)) this.metas = mt;
    if (ct && typeof ct === 'object' && !Array.isArray(ct)) this.menuCats = ct;
    if (layout && typeof layout === 'object' && !Array.isArray(layout)) {
      this.actionLayouts = Object.fromEntries(
        Object.entries(layout).map(([k, v]) => [k, normLayout(v)]),
      );
    }
    this.applyMetas();
    this.phrase = {
      self_talk: Array.isArray(selfTalk) ? selfTalk : [],
      click: Array.isArray(click) ? click : [],
      divination: div, festival: fest,
    };
    if (!this.cfg.self_talk_texts?.length) this.cfg.self_talk_texts = this.phrase.self_talk;
    this.buildPets();
    this.startZones();
    this.clampAll();
    this.refreshWorkBounds();
    // 灵动岛与待办提醒调度常驻浮层世界（无第二层，计时器只跑一份）。
    this.island = new Island(this.host, () => this.cfg, (p) => this.patch(p));
    this.todoSched = new TodoScheduler(() => this.cfg, (t) => this.remind(t));
    this.todoSched.start();
    this.applyConfig();
    this.bind();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private buildPets() {
    const explicit = Boolean((this.cfg as unknown as Record<string, unknown>).home_pets_explicit);
    const hidden = this.cfg.hidden_roles ?? [];
    const list: PetConfig[] = this.cfg.pets.length || explicit ? this.cfg.pets : [
      { id: '0', character: 'shenshen', x: -1, y: -1, scale: 0.72, facing: 'left', visible: true,
        layers: { wallpaper: false, overlay: true }, profile: defaultProfile() },
    ];
    for (const c of list) {
      if (hidden.includes(c.character)) continue; // 停用角色：不加载、不创建实例
      const pack = this.packs.find((p) => p.id === c.character) ?? this.packs[0];
      if (!pack) { this.toast('没有可用桌宠素材，请导入视频 + JSON 素材包'); return; }
      this.pets.push(new Pet(this, c, pack, () => this.cfg));
    }
  }

  private loop = (t: number) => {
    if (this.paused) { this.raf = 0; return; }
    this.raf = requestAnimationFrame(this.loop);
    let dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (this.paused) return;
    // 静止桌宠坐标自动保存：每 0.6s 扫一次，只有静止且位置变化的才交给 pos-store 防抖写盘。
    // 放在 low-fps return 之前——静止宠物正是低 fps 分支，放后面会被跳过。
    this.saveCheckAcc += dt;
    if (this.saveCheckAcc >= 0.6) { this.saveCheckAcc = 0; this.checkStaticPositions(); }
    if (this.cfg.idle_low_fps_enabled && this.pets.every((p) => p.behavior.idleFor > this.cfg.idle_low_fps_threshold)) {
      this.idleAcc += dt;
      if (this.idleAcc < 0.1) return;
      dt = this.idleAcc;
      this.idleAcc = 0;
    } else this.idleAcc = 0;

    for (const p of this.pets) p.step(dt);
    this.collisionCooldown -= dt;
    const colliders = this.pets.filter((p) => p.profile.collision_enabled);
    if (this.cfg.feature_activation?.collision !== false && colliders.length > 1 && this.collisionCooldown <= 0) {
      // 每帧刷新碰撞几何（圆链 / 质量 / 无限质量），并保留上一帧位置用于扫掠
      for (const p of colliders) {
        p.body.px = p.body.x; p.body.py = p.body.y;
        this.syncBody(p);
      }
      const bodies = colliders.map((p) => p.body);
      const events = resolveCollisions(bodies, this.cfg, dt);
      for (const p of this.pets) { p.x = p.body.x; p.y = p.body.y; p.applyTransform(); }
      // 宠物间撞击 → 挤压变形（z 轴压扁回弹）；形变保留，运动学交给原项目式弹性互撞
      for (const ev of events) {
        const power = Math.min(0.5, ev.impulse / 1500 + 0.07);
        for (const id of [ev.a, ev.b]) {
          this.pets.find((x) => x.id === id)?.squash(power);
        }
      }
      this.collisionCooldown = 0.016;
    }
  };

  private bind() {
    api.onConfig((c) => {
      this.cfg = mergeConfig(c);
      if (!this.cfg.self_talk_texts?.length) this.cfg.self_talk_texts = this.phrase.self_talk;
      this.syncPets();
      this.applyConfig();
    }).catch(() => {});
    api.onData<Record<string, string[]>>('character_playlists', (v) => {
      this.playlists = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      this.cursor = {};
    }).catch(() => {});
    api.onData<Record<string, Record<string, unknown>>>('character_meta', (v) => {
      this.metas = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      this.applyMetas();
    }).catch(() => {});
    api.onData<Record<string, Record<string, string[]>>>('character_categories', (v) => {
      this.menuCats = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }).catch(() => {});
    api.onData<Record<string, unknown>>('character_action_layout', (v) => {
      const L = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
      this.actionLayouts = Object.fromEntries(Object.entries(L).map(([k, x]) => [k, normLayout(x)]));
    }).catch(() => {});
    api.onSlot((e) => {
      const pet = this.pets.find((p) => p.id === e.id);
      if (pet && e.profile) { pet.profile = defaultProfile(e.profile as object); pet.behavior.reset(); }
    }).catch(() => {});
    api.onPacks((list) => {
      this.packs = sortPacks(list);
      for (const pet of this.pets) {
        const next = list.find((p) => p.id === pet.pack.id) ?? list[0];
        if (next) { pet.applyPack(next); pet.behavior.reset(); }
      }
    }).catch(() => {});
    api.onData<unknown>('self_talk_texts', (v) => {
      if (Array.isArray(v)) { this.phrase.self_talk = v as string[]; this.cfg.self_talk_texts = v as string[]; }
    }).catch(() => {});
    api.onMetrics((m) => { this.metrics = m; }).catch(() => {});
    api.onCommand((e) => this.command(e.cmd, e.payload)).catch(() => {});
    api.onFullscreen((on) => { this.fullscreen = on; this.syncPause(); }).catch(() => {});
    api.onVisible((v) => { this.visible = v; this.syncPause(); }).catch(() => {});
    if (this.isOverlay) api.onOverlayMouse((m) => this.synthOverlayMouse(m)).catch(() => {});
    window.addEventListener('resize', () => this.clampAll());
    document.addEventListener('visibilitychange', () => { this.syncPause(); if (document.hidden) this.flushPositions(); });
    window.addEventListener('pagehide', () => this.flushPositions());
    api.onBounds(() => { this.refreshWorkBounds(); this.clampAll(); }).catch(() => {});
    api.onDropPaths((paths) => this.onFiles(paths)).catch(() => {});
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'f') e.preventDefault();
    });
  }

  /** 任一「该歇着」的条件成立就整体休眠：隐藏 / 后台 / 前台全屏应用 / 本层被隐藏。 */
  private syncPause() {
    const p = !this.visible || document.hidden || this.fullscreen || !this.layerVisible;
    if (p === this.paused) return;
    this.paused = p;
    for (const pet of this.pets) p ? pet.player.pause() : pet.player.resume();
    if (p) {
      this.stopZones();
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      return;
    }
    this.startZones();
    this.last = performance.now();
    this.pets.forEach((pet) => pet.behavior.idleFor = 0);
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  /** 主界面「角色编辑」的元数据覆盖到素材包，立即作用于已存在的桌宠。 */
  private applyMetas() {
    for (const p of this.packs) {
      const m = this.metas[p.id];
      if (!m) continue;
      if (typeof m.name === 'string') p.name = m.name;
      if (typeof m.theme === 'string') p.theme = m.theme;
      if (typeof m.prompt === 'string') p.prompt = m.prompt;
      if (Array.isArray(m.canvas) && m.canvas.length === 2 && m.canvas.every((x) => typeof x === 'number')) {
        p.canvas = [m.canvas[0], m.canvas[1]] as [number, number];
      }
      if (typeof m.feet_y === 'number') p.feet_y = m.feet_y;
      if (typeof m.fps === 'number') p.fps = m.fps;
      if (typeof m.scale === 'number') p.scale = m.scale;
    }
    for (const pet of this.pets) {
      const next = this.packs.find((p) => p.id === pet.pack.id);
      if (next) pet.applyPack(next);
    }
  }

  /** 主界面改写 config.pets 后增量同步壁纸层，避免重启解码链。 */
  private syncPets() {
    const hidden = this.cfg.hidden_roles ?? [];
    const byId = new Map(this.pets.map((p) => [p.id, p]));
    const kept: Pet[] = [];
    for (const pc of this.cfg.pets ?? []) {
      if (hidden.includes(pc.character)) continue; // 停用角色：销毁桌面实例（下方 byId 残留统一 destroy）
      const pack = this.packs.find((p) => p.id === pc.character) ?? this.packs[0];
      if (!pack) continue;
      const old = byId.get(pc.id);
      if (old) {
        byId.delete(pc.id);
        if (old.pack.id !== pack.id) {
          old.applyPack(pack); old.setProfile('character', pack.id); old.behavior.reset();
        }
        if (Math.abs(old.scale - (pc.scale || 1)) > 0.001) old.setScale(pc.scale || 1);
        if (pc.profile) {
          old.profile = defaultProfile(pc.profile as object);
          old.player.setRate(old.profile.playback_speed ?? 1);
        }
        kept.push(old);
      } else kept.push(new Pet(this, pc, pack, () => this.cfg));
    }
    for (const p of byId.values()) { p.destroy(); api.deleteSlot(p.id).catch(() => {}); }
    this.pets = kept;
    if (this.hoveredId && !kept.some((p) => p.id === this.hoveredId)) this.hoveredId = '';
  }

  categoriesFor(packId: string): Record<string, string[]> { return this.menuCats[packId] ?? {}; }
  /** 「查看动作」里拖动排序 + 眼睛显隐的布局，右键菜单据此渲染。 */
  actionLayoutFor(packId: string): ActionLayout { return this.actionLayouts[packId] ?? emptyLayout(); }

  /** 当前角色自动播放的可见动作池：剔除「查看动作」里眼睛隐藏的分类与动作。 */
  private autoPool(pack: CharacterPack, cat: string): Clip[] {
    const layout = this.actionLayoutFor(pack.id);
    const hiddenCats = new Set(layout.hiddenCats);
    const hiddenClips = new Set(layout.hiddenClips);
    return catClips(pack, cat).filter((c) =>
      !hiddenClips.has(c.name) && !hiddenCats.has(viewCategory(pack.id, c)));
  }

  /** 自动播放可见动作池：剔除眼睛隐藏的分类与动作。 */
  visibleClips(pack: CharacterPack, cat: string): Clip[] { return this.autoPool(pack, cat); }

  /** 随机取一个可见动作（自动播放回退用），隐藏的不参与。 */
  pickVisible(pack: CharacterPack, cat: string): Clip | null {
    const list = this.autoPool(pack, cat);
    return list.length ? list[(Math.random() * list.length) | 0] : null;
  }

  /** 跨全部原始桶取一个可见动作：待机/过场兜底，隐藏的动作绝不参与。 */
  pickVisibleAny(pack: CharacterPack): Clip | null {
    const all: Clip[] = [];
    for (const cat of Object.keys(pack.clips ?? {})) all.push(...this.autoPool(pack, cat));
    return all.length ? all[(Math.random() * all.length) | 0] : null;
  }

  /** 轮播编排：按保存的动作名顺序播放，隐藏的动作跳过；可见池为空则放弃，绝不回退到含隐藏的原始桶。 */
  nextRandom(pack: CharacterPack, cat: string): Clip | null {
    const order = this.playlists[pack.id];
    if (!Array.isArray(order) || !order.length) return null;
    const list = this.autoPool(pack, cat);
    if (!list.length) return null;
    const i = this.cursor[pack.id] ?? 0;
    for (let k = 0; k < order.length; k++) {
      const c = list.find((x) => x.name === order[(i + k) % order.length]);
      if (c) { this.cursor[pack.id] = (i + k + 1) % order.length; return c; }
    }
    return null;
  }

  /** 扫描静止桌宠，位置变化则收集并交给 pos-store 防抖保存。飞行/拖拽中的不写，落地静止后才落盘。 */
  private checkStaticPositions() {
    const changed: { id: string; x: number; y: number }[] = [];
    for (const p of this.pets) {
      const b = p.body;
      const still = !b.dragging && Math.abs(b.vx) + Math.abs(b.vy) < 1 && Math.abs(b.angle) < 0.05;
      if (!still) continue;
      const prev = this.lastSaved.get(p.id);
      if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue;
      this.lastSaved.set(p.id, { x: p.x, y: p.y });
      changed.push({ id: p.id, x: p.x, y: p.y });
    }
    if (changed.length) scheduleSave(changed);
  }

  /** 恢复坐标时夹紧到工作区内（含身体框），保证每只都在可见范围且不落到任务栏下。 */
  private clampAll() {
    const b = this.workBounds();
    if (b.w <= 0 || b.h <= 0) return;
    for (const pet of this.pets) {
      const box = pet.bodyBox();
      const minX = b.x - box.l, maxX = Math.max(minX, b.x + b.w - box.r);
      const minY = b.y - box.t, maxY = Math.max(minY, b.y + b.h - box.b);
      pet.x = Math.max(minX, Math.min(maxX, pet.x));
      pet.y = Math.max(minY, Math.min(maxY, pet.y));
      pet.body.x = pet.x; pet.body.y = pet.y;
      pet.applyTransform();
    }
    this.island?.sync();
  }

  private applyConfig() {
    const c = this.cfg;
    const dark = c.ui_theme === 'dark' || (c.ui_theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.density = c.ui_density ?? 'standard';
    document.documentElement.style.setProperty('--ui-font', `${c.ui_font_size ?? 13}px`);
    document.documentElement.style.setProperty('--ui-radius', `${c.corner_radius ?? 12}px`);
    for (const pet of this.pets) {
      pet.setOpacity(layerOpacity(c, this.view) / 100);
      pet.player.setRate(pet.profile.playback_speed ?? 1);
    }
    this.island?.sync();
    // 本层显示开关：窗口显隐由 Rust 统一决定，这里只负责停/续解码与物理
    const on = this.layerOn(c);
    if (on !== this.layerVisible) { this.layerVisible = on; this.syncPause(); }
    // 整层穿透时窗口不吃鼠标，pointerleave 永远不来，手动收掉名牌
    if (c.overlay_mouse_through) this.hoverName(null);
  }

  /** 保存非坐标字段（scale/facing/profile）到 config.json。坐标不在此列——由 pos-store 存 localStorage。 */
  private async persist(force: boolean): Promise<void> {
    const old = this.cfg.pets ?? [];
    const live = new Map(this.pets.map((p) => [p.id, p]));
    const pets: PetConfig[] = old.map((c) => {
      const p = live.get(c.id);
      if (!p) return c;
      // 坐标填当前内存值只为满足类型；真相源是 localStorage，Rust 端写 config.json 时会剥离坐标。
      return { ...c, scale: p.scale, facing: p.facing, profile: p.profile, ox: p.x, oy: p.y };
    }).concat([...live].filter(([id]) => !old.some((c) => c.id === id)).map(([, p]) => p.toConfig()));
    if (!force && JSON.stringify(pets) === JSON.stringify(old)) return;
    this.cfg = { ...this.cfg, pets };
    await api.save(this.cfg).catch(() => {});
  }

  /** 退出/关窗兜底：把当前静止坐标立即写进 localStorage（含仍在防抖队列里的）。 */
  flushPositions() { flushNow(this.pets.map((p) => ({ id: p.id, x: p.x, y: p.y }))); }

  patch(p: Partial<Config>) { this.setMany(p); }
  setMany(p: Partial<Config>) {
    this.cfg = { ...this.cfg, ...p };
    this.applyConfig();
    api.save(this.cfg).catch(() => {});
  }
  saveSlot(pet: Pet) {
    const i = this.cfg.pets.findIndex((p) => p.id === pet.id);
    if (i >= 0) this.cfg.pets[i].profile = pet.profile;
    api.saveSlot(pet.id, pet.profile).catch(() => {});
    this.persist(true);
  }

  toast(msg: string) {
    const host = document.getElementById('toast');
    if (!host) return;
    const t = el('div', 'toast', msg);
    host.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  allClips(pet: Pet): Clip[] {
    return Object.values(pet.pack.clips).flat().filter((c) => c.category !== 'idle' && c.category !== 'turn');
  }

  /** 右键动作菜单用：含 idle/turn，对齐原版「待机/转向」分类；自动播放链仍走 allClips。 */
  menuClips(pet: Pet): Clip[] { return Object.values(pet.pack.clips).flat(); }

  private lastMenuAt = 0;
  /** Rust 钩子与 WebView 原生右键可能同时到达，220ms 内去重。 */
  openMenu(x: number, y: number, pet: Pet) {
    const t = performance.now();
    if (t - this.lastMenuAt < 220) return;
    this.lastMenuAt = t;
    const hidden = this.cfg.hidden_roles ?? [];
    this.menu.show(x, y, buildMenu(this, pet, this.cfg,
      this.packs.filter((p) => !hidden.includes(p.id)).map((p) => ({ id: p.id, name: p.name })), this.menuClips(pet)));
  }

  /** 生小肥鱼：自动避让位置，独立档案，同角色共享解码链（同源 video 由浏览器复用） */
  spawn() {
    const main = this.pets[0];
    const pack = this.packs.find((p) => p.id === (main?.pack.id ?? this.cfg.pets[0]?.character)) ?? this.packs[0];
    if (!pack) return;
    const max = 24;
    if (this.pets.length >= max) { this.toast('最多 24 只小肥鱼啦'); return; }
    const id = String(Date.now());
    const scale = this.cfg.spawn_inherit_size && main ? main.scale : (this.cfg.spawn_scale ?? 0.72);
    const c: PetConfig = {
      id, character: pack.id, x: -1, y: -1, scale, facing: Math.random() < 0.5 ? 'left' : 'right',
      visible: true, profile: defaultProfile({ scale, character: pack.id }),
      layers: { wallpaper: false, overlay: true },
    };
    const pet = new Pet(this, c, pack, () => this.cfg);
    const i = this.pets.length;
    pet.x = Math.max(8, Math.min(this.width() - pet.width - 8,
      (main?.x ?? this.width() - pet.width - CORNER_MARGIN) - 70 * i + (i % 3) * 24));
    pet.y = Math.max(0, Math.min(this.height() - pet.height,
      (main?.y ?? this.height() - pet.height - CORNER_MARGIN) - (i % 2) * 18));
    pet.body.x = pet.x; pet.body.y = pet.y;
    pet.applyTransform();
    this.pets.push(pet);
    this.persist(true);
    this.toast('孵出一只小肥鱼～');
  }

  clearSpawned() {
    while (this.pets.length > 1) {
      const p = this.pets.pop();
      p?.destroy();
      if (p) api.deleteSlot(p.id).catch(() => {});
    }
    this.persist(true);
    this.toast('已退出全部子肥鱼');
  }

  returnCorner(pet: Pet) {
    pet.x = this.width() - pet.width - CORNER_MARGIN;
    pet.y = this.height() - pet.height - CORNER_MARGIN;
    pet.body.x = pet.x; pet.body.y = pet.y;
    pet.body.vx = 0; pet.body.vy = 0; pet.body.angle = 0;
    pet.applyTransform();
    this.persist(true);
  }

  setCharacter(pet: Pet, id: string) {
    const pack = this.packs.find((p) => p.id === id);
    if (!pack) return;
    pet.applyPack(pack);
    pet.setProfile('character', pack.id);
    pet.behavior.reset();
  }

  playClip(pet: Pet, c: Clip) { pet.behavior.playOnce(c); }
  setScale(pet: Pet, s: number) { pet.setScale(Math.max(0.3, Math.min(1.6, s))); this.persist(true); }
  openSettings(pet: Pet) { api.settings(pet.id).catch(() => {}); }
  hideAll() {
    void api.hidden(true).catch(() => {});
    this.visible = false;
    this.syncPause();
    this.toast('已隐藏；托盘 → 显示 / 隐藏桌宠 可恢复');
  }
  quit() { this.flushPositions(); void api.quit().catch(() => {}); }
  openTodo() {
    // 待办是独立窗：由 Rust 创建 / 显示，浮层世界只保留到期提醒调度。
    api.openTodo().catch(() => {});
  }

  /** 浮层悬停：跟随光标显示角色名牌（同一时刻只留一个，贴光标实时重摆）。 */
  hoverName(pet: Pet | null, x?: number, y?: number) {
    const id = pet?.id ?? '';
    const same = id === this.hoveredId;
    if (!same) {
      if (this.hoveredId) this.pets.find((p) => p.id === this.hoveredId)?.bubble.dropTag();
      this.hoveredId = id;
    }
    if (!pet) return;
    if (same) pet.bubble.moveTag(x ?? 0, y ?? 0);
    else pet.bubble.tag(pet.pack.name, x ?? 0, y ?? 0);
  }

  /** 浮层命中窗的语义事件 → 合成 DOM 事件，复用 .pet-hit 上既有交互，不改 Pet 一行。 */
  private synthOverlayMouse(m: import('../bridge').OverlayMouse) {
    // 命中窗进程 DPI-aware，GetCursorPos 返回物理像素；DOM 用 CSS 像素，按 dpr 换算。
    const dpr = window.devicePixelRatio || 1;
    const { type, button, shift, ctrl, delta } = m;
    const x = m.x / dpr, y = m.y / dpr;
    const base: PointerEventInit = {
      clientX: x, clientY: y, button, buttons: type === 'up' || type === 'leave' ? 0 : 1,
      shiftKey: shift, ctrlKey: ctrl, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    };
    const fire = (el: EventTarget, ev: Event) => el.dispatchEvent(ev);
    switch (type) {
      case 'down': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new PointerEvent('pointerdown', base));
        break;
      }
      case 'up':
        // 命中窗在原生层裁决本次松手是否放行音效（早于壁纸层 IPC），结果挂到 world 供 tap 消费。
        this.overlayClickSound = m.sound === true;
        fire(window, new PointerEvent('pointerup', base));
        break;
      case 'move': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new PointerEvent('pointermove', base));
        // 名牌：命中哪只就冒哪只、贴光标实时重摆，移开收掉
        // （命中窗的 leave 只在整窗边缘触发，逐宠切换靠这里）。
        const hit = (t as HTMLElement | null)?.closest?.('.pet') as HTMLElement | null;
        this.hoverName(hit ? this.pets.find((p) => p.id === hit.dataset.id) ?? null : null, x, y);
        break;
      }
      case 'leave':
        fire(window, new PointerEvent('pointerleave', base));
        this.hoverName(null);
        break;
      case 'rdown': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new PointerEvent('pointerdown', base));
        break;
      }
      case 'contextmenu': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new MouseEvent('contextmenu', { ...base }));
        break;
      }
      case 'dblclick': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new MouseEvent('dblclick', { ...base }));
        break;
      }
      case 'wheel': {
        const t = document.elementFromPoint(x, y);
        if (t) fire(t, new WheelEvent('wheel', { deltaY: delta, ctrlKey: ctrl, bubbles: true, cancelable: true }));
        break;
      }
    }
  }

  async toggleAutostart() {
    try {
      const on = await api.autostart.isEnabled();
      if (on) await api.autostart.disable(); else await api.autostart.enable();
      this.setMany({ autostart: !on });
      this.toast(!on ? '已开启开机自启' : '已关闭开机自启');
    } catch { this.toast('开机自启设置失败'); }
  }

  quiet(minutes: number) {
    const until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
    this.setMany({ quiet_until: until });
    if (!minutes && this.quietQueue.length) {
      const n = this.quietQueue.length;
      this.quietQueue = [];
      this.pets[0]?.say(`刚才攒了 ${n} 条提醒，慢慢看～`, 4);
    }
    this.toast(minutes ? `免打扰 ${minutes} 分钟` : '已结束免打扰');
  }

  private quietNow() { return this.cfg.quiet_until > Date.now(); }

  remind(text: string) {
    if (this.quietNow()) { this.quietQueue.push(text); return; }
    const pet = this.pets.find((p) => p.profile.visible !== false) ?? this.pets[0];
    pet?.say(text, 5);
  }

  trim() {
    // 释放所有非活动解码器 + 触发一次 GC 友好清理
    for (const p of this.pets) p.player.setRate(p.profile.playback_speed ?? 1);
    const gc = (window as unknown as { gc?: () => void }).gc;
    if (gc) gc();
    this.toast('已回收闲置解码资源');
  }

  launch(app: QuickLaunchApp) {
    api.run(app.path, app.args ? app.args.split(' ').filter(Boolean) : undefined)
      .then(() => this.toast(`已启动 ${app.name}`))
      .catch((e) => this.toast(`启动失败：${String(e)}`));
  }

  openPlayer(key: string) {
    const custom = (this.cfg as unknown as Record<string, string>)[`player_path_${key}`];
    const candidates = custom ? [custom, ...(PLAYERS[key] ?? [])] : (PLAYERS[key] ?? []);
    const hit = candidates.find((p) => p);
    if (!hit) { this.toast('未找到播放器；可在设置里配置路径'); return; }
    api.run(hit).then(() => this.toast('正在打开播放器～'))
      .catch(() => this.toast('找不到播放器，请到「设置 → 桌宠 → 显示与音乐」填写路径'));
  }

  egg(pet: Pet) {
    const d = this.cfg.menu_easter_egg;
    if (!d?.enabled) return;
    pet.say(d.hint || '请点击', 3);
    if (d.image_dir) this.toast('彩蛋图片目录已配置（右键菜单首行）');
  }

  festival(pet: Pet) {
    const map = (this.phrase.festival ?? {}) as Record<string, string>;
    const now = new Date();
    const key = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    pet.say(map[key] ?? '今天不是特定节日，也要开开心心呀～', 5);
  }

  divination(pet: Pet) {
    const d = (this.phrase.divination ?? {}) as { levels?: string[]; lines?: string[] };
    const levels = d.levels?.length ? d.levels : ['大吉', '吉', '中吉', '小吉', '末吉'];
    const lines = d.lines?.length ? d.lines : ['今日宜摸鱼，万事顺遂。'];
    const lv = levels[(Math.random() * levels.length) | 0];
    const line = lines[(Math.random() * lines.length) | 0];
    pet.say(`【${lv}】${line}`, 6);
  }

  private onFiles(paths: string[]) {
    if (!paths.length) return;
    const pet = this.pets[0];
    if (!pet) return;
    if (paths.some((p) => /\.(zip|json|webm)$/i.test(p))) {
      paths.forEach((p) => this.importPath(p));
      return;
    }
    if ((this.cfg as unknown as Record<string, boolean>).file_eat_enabled === false) return;
    const name = paths[0].split(/[\\/]/).pop() ?? '文件';
    pet.behavior.playOnce(this.allClips(pet)[(Math.random() * Math.max(1, this.allClips(pet).length)) | 0] ?? this.allClips(pet)[0]);
    pet.say(`啊呜！把「${name}」吃掉啦（没有真的删掉哦）`, 4);
  }

  onPetClicked(pet: Pet) {
    const c = pet.effective(this.cfg);
    if (c.click_show_self_talk) {
      const texts = this.phrase.click?.length ? this.phrase.click : ['哎呀！', '别戳我～'];
      pet.bubble.show(texts[(Math.random() * texts.length) | 0], {
        style: c.self_talk_bubble_style, scale: c.bubble_text_scale, duration: 2.4,
      });
    }
    if (c.click_golden_spin) pet.spin();
    void BUBBLE_PRESETS;
  }
  onPetReleased(pet: Pet) {
    if (this.cfg.collision_enabled) pet.body.angle = 0;
    // 坐标由 loop 里的静止检测自动保存到 localStorage；此处无需外部保存钩子。
  }

  /** 每帧把桌宠当前位置/缩放/状态同步进碰撞体（圆链几何 + 质量 + 无限质量）。 */
  private syncBody(p: Pet) {
    const b = p.body;
    const scale = p.scale;
    const bb = p.pack.body_box;
    let left: number, top: number, w: number, h: number;
    if (bb) {
      left = p.x + bb[0] * scale; top = p.y + bb[1] * scale;
      w = (bb[2] - bb[0]) * scale; h = (bb[3] - bb[1]) * scale;
    } else {
      left = p.x; top = p.y; w = p.width; h = p.height;
    }
    b.circles = circlesFromRect(left, top, w, h);
    const ms = this.cfg.collision_mass_scale ?? 1;
    b.mass = Math.max(0.5, Math.min(2.5, ms * Math.pow(scale / 0.72, 2)));
    b.infinite = b.dragging || !!p.profile.no_move || layerLock(this.cfg, this.view);
    b.w = p.width; b.h = p.height; b.scale = scale;
  }

  private async importPath(path: string) {
    try { const r = await api.import(path); this.toast(`素材包已导入：${r.id}`); }
    catch (e) { this.toast(`导入失败：${String(e)}`); }
  }
  async pickImport() {
    const p = await api.pickFolder();
    if (p) await this.importPath(p);
  }

  private async command(cmd: string, payload: unknown) {
    switch (cmd) {
      case 'toggle-visible':
      case 'set-visible': {
        const v = cmd === 'toggle-visible' ? !this.visible : Boolean(payload);
        // 坐标已在拖动松手时即时落盘，隐藏直接通知 Rust 显隐层即可。
        await api.hidden(!v).catch(() => {});
        this.visible = v;
        this.syncPause();
        break;
      }
      case 'toggle-through':
        this.setMany({ overlay_mouse_through: !this.cfg.overlay_mouse_through });
        break;
      case 'toggle-quiet': this.quiet(this.quietNow() ? 0 : (this.cfg.quiet_minutes_default ?? 30)); break;
      case 'open-todo': this.openTodo(); break;
      case 'open-todo-layer': this.openTodo(); break;
      case 'import': this.pickImport(); break;
      case 'spawn': this.spawn(); break;
      case 'clear-spawned': this.clearSpawned(); break;
      case 'return-corner': if (this.pets[0]) this.returnCorner(this.pets[0]); break;
      case 'feed': this.pets[0]?.say('好好吃！谢谢主人～', 3); break;
      case 'feed-demo': this.toast('把文件拖到桌宠身上试试～'); break;
      case 'throw-egg': {
        const p = this.pets[0];
        if (p) { p.body.vy = -700; p.body.vx = (Math.random() - 0.5) * 500; p.say('哎哟！', 2); }
        break;
      }
      case 'divination': if (this.pets[0]) this.divination(this.pets[0]); break;
      case 'festival': if (this.pets[0]) this.festival(this.pets[0]); break;
      case 'toggle-autostart': this.toggleAutostart(); break;
      case 'home-preview': {
        const p = payload as { character?: string; src?: string; name?: string } | null;
        const pet = this.pets.find((x) => x.pack.id === p?.character) ?? this.pets[0];
        const c = pet
          ? Object.values(pet.pack.clips).flat().find((x) => x.name === p?.name || x.src === p?.src)
          : null;
        if (pet && c) this.playClip(pet, c);
        else this.toast('先在「我的角色」里开启这位角色，再预览动画');
        break;
      }
      case 'set-character-for': {
        const p = payload as { slot?: string; id?: string } | null;
        const pet = this.pets.find((x) => x.id === (p?.slot ?? '0')) ?? this.pets[0];
        if (pet && p?.id) this.setCharacter(pet, p.id);
        break;
      }
    }
  }
}

export async function start() {
  const app = document.getElementById('app');
  if (!app) return;
  // 浮层不可选中：不出现选区/拖影/浏览器右键菜单；事件本身照常捕获
  document.addEventListener('contextmenu', (e) => e.preventDefault(), true);
  document.addEventListener('selectstart', (e) => e.preventDefault());
  document.addEventListener('dragstart', (e) => e.preventDefault());
  app.innerHTML = '<div id="world"></div><div id="toast"></div>';
  const host = document.getElementById('world')!;
  const cfg = await loadConfig();
  // 先读 localStorage 浮层坐标注入 cfg，Pet 构造经 posOf 落到正确位置（先读后显示）。
  hydrate(cfg);
  const w = new World(host, cfg);
  (window as unknown as { __world: World }).__world = w;
  await w.init();
  // 引擎装好宠物后再让 Rust 显示置顶窗，避免闪一帧空窗
  api.overlayReady().catch(() => {});
}
