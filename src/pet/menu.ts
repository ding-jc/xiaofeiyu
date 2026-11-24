// 右键菜单：模板驱动。菜单本体由独立的透明 webview 窗渲染（view=menu），
// 浮层世界只负责构建树、把点击结果按索引路径执行掉。
import { api } from '../bridge';
import { ACTIONS } from '../data/defaults';
import type { Clip, Config, MenuNode } from '../types';
import { SPEED_STEPS, SCALE_STEPS, CATEGORY_LABELS, CATEGORY_ORDER, viewCategory } from './catalog';
import type { World } from './engine';
import type { Pet } from './pet';

export interface MenuItem {
  id: string;
  type: 'action' | 'submenu' | 'separator';
  label: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  reason?: string;
  value?: string;
  children?: MenuItem[];
  run?: () => void;
}

const serialize = (it: MenuItem): unknown => ({
  id: it.id, type: it.type, label: it.label, icon: it.icon, checked: it.checked,
  disabled: it.disabled, reason: it.reason, value: it.value,
  children: it.children?.map(serialize),
});

export class ContextMenu {
  private tree: MenuItem[] = [];

  constructor(private cfg: () => Config) {}

  hide() { this.tree = []; }

  /** 弹菜单：Rust 端等点击返回索引路径，这里按路径执行对应动作。 */
  async show(x: number, y: number, items: MenuItem[]) {
    this.tree = items;
    try {
      const path = await api.nativeMenuShow(x, y, items.map(serialize), 'overlay');
      if (path && path.length) this.pick(path);
    } catch { this.hide(); }
  }

  private pick(path: number[]) {
    let list = this.tree;
    let node: MenuItem | undefined;
    for (const i of path) {
      node = list[i];
      if (!node) return;
      list = node.children ?? [];
    }
    this.tree = [];
    node?.run?.();
  }
}

const nodeLabel = (n: MenuNode) => n.label || ACTIONS[n.id]?.label || n.id;
const nodeIcon = (n: MenuNode) => n.icon === undefined ? ACTIONS[n.id]?.icon : n.icon;

/** 把原版布局树渲染成菜单项；能力不可用节点在运行时省略（编排器仍保留）。 */
export function buildMenu(w: World, pet: Pet, cfg: Config, packs: { id: string; name: string }[], clips: Clip[]): MenuItem[] {
  const out: MenuItem[] = [];
  const isMain = pet.id === '0';

  const make = (n: MenuNode): MenuItem | null => {
    if (n.hidden || ACTIONS[n.id]?.capability === 'removed') return null;
    if (n.type === 'separator') return { id: n.id, type: 'separator', label: '' };
    if (n.type === 'submenu') {
      const children = (n.children ?? []).map(make).filter(Boolean) as MenuItem[];
      if (!children.length) return null;
      return { id: n.id, type: 'submenu', label: nodeLabel(n), icon: nodeIcon(n), children };
    }
    const spec = ACTIONS[n.id];
    const resolved = resolve(n.id, w, pet, cfg, packs, clips);
    return {
      id: n.id, type: resolved?.children ? 'submenu' : 'action',
      label: nodeLabel(n), icon: nodeIcon(n),
      checked: resolved?.checked, disabled: resolved?.disabled, reason: resolved?.reason,
      value: resolved?.value, children: resolved?.children,
      run: resolved?.run ?? (() => w.toast(`${nodeLabel(n)}：本版本未启用`)),
      ...(spec ? {} : {}),
    };
  };

  for (const n of cfg.context_menu_layout) {
    const it = make(n);
    if (it) out.push(it);
  }

  // 彩蛋首行：标题 + 副标题 + 点击图片
  if (cfg.menu_easter_egg?.enabled && out.length) {
    const egg = out[0];
    if (egg.id === 'ojingjing') {
      egg.label = cfg.menu_easter_egg.title || '厉害了我的鲸';
      egg.run = () => { w.egg(pet); };
    }
  }

  // 主宠才有一键退出子肥鱼；没有子宠时置灰说明
  const walk = (list: MenuItem[]) => {
    for (const it of list) {
      if (it.id === 'clear_spawned_pets') {
        it.disabled = w.pets.length <= 1 || !isMain;
        if (it.disabled) it.reason = isMain ? '当前没有子肥鱼' : '这是全局操作：请在主肥鱼的菜单里操作';
      }
      if (it.children) walk(it.children);
    }
  };
  walk(out);
  return out;
}

interface Resolved {
  checked?: boolean; disabled?: boolean; reason?: string; value?: string;
  children?: MenuItem[]; run?: () => void;
}

function resolve(id: string, w: World, pet: Pet, cfg: Config, packs: { id: string; name: string }[], clips: Clip[]): Resolved {
  const A = (label: string, icon: string, run: () => void): MenuItem =>
    ({ id: `leaf.${label}`, type: 'action', label, icon, run });
  const R = (items: MenuItem[]): Resolved => ({ children: items });

  switch (id) {
    case 'ojingjing': return { run: () => w.egg(pet) };
    case 'animations_hub': {
      const layout = w.actionLayoutFor(pet.pack.id);
      const hiddenCats = new Set(layout.hiddenCats);
      const hiddenClips = new Set(layout.hiddenClips);
      // 应用显隐：隐藏的分类整组剔除，隐藏的动作单项剔除
      const visible = clips.filter((c) => !hiddenClips.has(c.name) && !hiddenCats.has(viewCategory(pet.pack.id, c)));
      // 按 viewCategory 分组
      const groups = new Map<string, Clip[]>();
      for (const c of visible) {
        const key = viewCategory(pet.pack.id, c);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
      }
      // 顺序：用户拖动过的按布局顺序优先，未列入的按内置 CATEGORY_ORDER 排后
      const catRank = (k: string) => {
        const u = layout.catOrder.indexOf(k);
        if (u >= 0) return u;
        const i = CATEGORY_ORDER.indexOf(k);
        return (i < 0 ? CATEGORY_ORDER.length : i) + layout.catOrder.length;
      };
      const clipRank = (c: Clip) => {
        const u = layout.clipOrder.indexOf(c.name);
        return u >= 0 ? u : layout.clipOrder.length + 1;
      };
      const label = (name: string) => CATEGORY_LABELS[name] ?? name;
      const entries = [...groups.entries()]
        .sort((a, b) => catRank(a[0]) - catRank(b[0]) || a[0].localeCompare(b[0], 'zh'));
      const sub: MenuItem[] = entries.slice(0, 40).map(([name, list]) => {
        const ordered = [...list].sort((a, b) => clipRank(a) - clipRank(b));
        // 单个动作的分类不再套一层子菜单，直接以动作名作为菜单项
        if (ordered.length === 1) {
          const c = ordered[0];
          return { ...A(c.name, 'play', () => { w.playClip(pet, c); }), id: `anim.solo.${name}` };
        }
        return {
          id: `anim.group.${name}`, type: 'submenu' as const, label: `${label(name)}（${ordered.length}）`, icon: 'play',
          children: ordered.slice(0, 60).map((c) => A(c.name, 'play', () => { w.playClip(pet, c); })),
        };
      });
      sub.unshift(A('随便来一个', 'play', () => w.playClip(pet, visible[(Math.random() * visible.length) | 0] ?? clips[0])));
      return R(sub);
    }
    case 'character': return R([
      ...packs.map((p) => ({ ...A(p.name, 'character', () => w.setCharacter(pet, p.id)), checked: p.id === pet.pack.id })),
      { id: 'character.import', type: 'action', label: '导入素材包…', icon: 'add', run: () => w.pickImport() },
    ]);
    case 'playback_speed': return R(SPEED_STEPS.map((s) => ({
      ...A(`${s}x`, 'speed', () => pet.setSpeed(s)), checked: Math.abs(pet.profile.playback_speed - s) < 0.001,
    })));
    case 'size': return R(SCALE_STEPS.map((s) => ({
      ...A(`${Math.round(s * 100)}%`, 'size', () => w.setScale(pet, s)), checked: Math.abs(pet.scale - s) < 0.01,
    })));
    case 'music': return R([
      A('打开网易云并播放', 'play', () => w.openPlayer('netease')),
      A('打开QQ音乐并播放', 'play', () => w.openPlayer('qqmusic')),
      A('打开酷狗音乐并播放', 'play', () => w.openPlayer('kugou')),
      A('打开汽水音乐并播放', 'play', () => w.openPlayer('soda')),
    ]);
    case 'drag_physics': return { checked: pet.profile.drag_physics, run: () => pet.setProfile('drag_physics', !pet.profile.drag_physics) };
    case 'no_move': return { checked: pet.profile.no_move, run: () => pet.setProfile('no_move', !pet.profile.no_move) };
    case 'on_top': return { checked: cfg.on_top, run: () => w.patch({ on_top: !cfg.on_top }) };
    case 'overlay_through': return {
      checked: cfg.overlay_mouse_through,
      run: () => w.patch({ overlay_mouse_through: !cfg.overlay_mouse_through }),
    };
    case 'autostart': return { checked: cfg.autostart, run: () => w.toggleAutostart() };
    case 'return_corner': return { run: () => w.returnCorner(pet) };
    case 'hide_pet': return { run: () => w.hideAll() };
    case 'spawn_pet': return { run: () => w.spawn() };
    case 'clear_spawned_pets': return { run: () => w.clearSpawned() };
    case 'golden_spin': return { run: () => pet.spin() };
    case 'edge_probe': return { checked: cfg.edge_probe_enabled, run: () => w.patch({ edge_probe_enabled: !cfg.edge_probe_enabled }) };
    case 'island_toggle': return { checked: cfg.island_enabled, run: () => w.patch({ island_enabled: !cfg.island_enabled }) };
    case 'quick_launch': {
      const apps = (cfg.quick_launch_apps ?? []).filter((a) => a.enabled !== false);
      if (!apps.length) return R([{ id: 'ql.empty', type: 'action', label: '尚未配置快捷项', icon: 'application', disabled: true, reason: '设置 → 菜单 → 快捷启动 里添加' }]);
      return R(apps.map((a, i) => ({ ...A(a.name, 'application', () => w.launch(a)), checked: false, disabled: false })));
    }
    case 'todo_panel': return { run: () => w.openTodo() };
    case 'quiet_mode': return R([
      ...[15, 30, 60, 120].map((mins) => ({
        ...A(`${mins} 分钟${mins === cfg.quiet_minutes_default ? '（默认）' : ''}`, 'pause', () => w.quiet(mins)),
        checked: mins === cfg.quiet_minutes_default,
      })),
      A('结束免打扰', 'play', () => w.quiet(0)),
    ]);
    case 'memory_trim': return { run: () => { w.trim(); } };
    case 'festival_now': return { run: () => w.festival(pet) };
    case 'festival_toggle': return { checked: cfg.festival_enabled, run: () => w.patch({ festival_enabled: !cfg.festival_enabled }) };
    case 'divination_draw': return { run: () => w.divination(pet) };
    case 'modern_settings': return { run: () => w.openSettings(pet) };
    case 'quit': return { run: () => w.quit() };
    default: {
      if (id.startsWith('music_open_')) return { run: () => w.openPlayer(id.replace('music_open_', '')) };
      return { disabled: true, reason: '本版本未启用该动作' };
    }
  }
}
