// 原项目菜单动作模型（context_menus/registry.py）与默认布局（modern-default-v1.json）。
// 「能力不可用」沿用原项目语义：本版本移除 AI/联网/语音，节点保留在编排树里、运行时省略。
import type { Config, MenuAppearance, MenuNode, PetProfile } from '../types';

export interface ActionSpec {
  label: string;
  icon: string;
  /** removed = 本构建不具备该能力（AI / 联网 / 语音），运行时省略、编排器说明原因 */
  capability?: 'removed';
  reason?: string;
  kind?: 'toggle' | 'value' | 'submenu' | 'action';
}

const R = '本版本为纯本地壁纸版，已移除 AI / 联网 / 语音能力';

export const ACTIONS: Record<string, ActionSpec> = {
  ojingjing: { label: '厉害了我的鲸', icon: 'pet', kind: 'action' },
  look_screen: { label: '看看屏幕', icon: 'screen', capability: 'removed', reason: R },
  screen_capture: { label: '截图提问', icon: 'size', capability: 'removed', reason: R },
  animations_hub: { label: '动作', icon: 'play', kind: 'submenu' },
  character: { label: '切换角色', icon: 'character', kind: 'submenu' },
  playback_speed: { label: '播放速率', icon: 'speed', kind: 'value' },
  size: { label: '大小', icon: 'size', kind: 'value' },
  music: { label: '音乐', icon: 'play', kind: 'submenu' },
  music_pause: { label: '暂停 / 播放', icon: 'pause', capability: 'removed', reason: R },
  music_next: { label: '切歌', icon: 'play', capability: 'removed', reason: R },
  music_prev: { label: '上一首', icon: 'play', capability: 'removed', reason: R },
  music_quit: { label: '退出音乐模式', icon: 'stop', capability: 'removed', reason: R },
  music_lyric_align: { label: '歌词对齐', icon: 'play', capability: 'removed', reason: R },
  music_open_netease: { label: '打开网易云并播放', icon: 'play', kind: 'action' },
  music_open_qqmusic: { label: '打开QQ音乐并播放', icon: 'play', kind: 'action' },
  music_open_kugou: { label: '打开酷狗音乐并播放', icon: 'play', kind: 'action' },
  music_open_soda: { label: '打开汽水音乐并播放', icon: 'play', kind: 'action' },
  pet_controls: { label: '桌宠控制', icon: 'pet', kind: 'submenu' },
  drag_physics: { label: '拖动物理', icon: 'physics', kind: 'toggle' },
  no_move: { label: '不移动', icon: 'pause', kind: 'toggle' },
  on_top: { label: '窗口置顶', icon: 'pin', kind: 'toggle' },
  overlay_through: { label: '鼠标穿透', icon: 'hide', kind: 'toggle' },
  autostart: { label: '开机自启', icon: 'autostart', kind: 'toggle' },
  return_corner: { label: '回到右下角', icon: 'corner', kind: 'action' },
  hide_pet: { label: '隐藏桌宠', icon: 'hide', kind: 'action' },
  spawn_pet: { label: '生小肥鱼', icon: 'spawn', kind: 'action' },
  clear_spawned_pets: { label: '退出子肥鱼', icon: 'clear', kind: 'action' },
  agent_cost: { label: '显示本轮消费', icon: 'balance', capability: 'removed', reason: R },
  golden_spin: { label: '黄金回旋', icon: 'play', kind: 'action' },
  edge_probe: { label: '边缘探头', icon: 'corner', kind: 'toggle' },
  quick_launch: { label: '快捷启动', icon: 'application', kind: 'submenu' },
  tools_help: { label: '工具与帮助', icon: 'settings', kind: 'submenu' },
  balance: { label: 'DeepSeek 余额', icon: 'balance', capability: 'removed', reason: R },
  harness: { label: '启动 DeepSeek Harness', icon: 'harness', capability: 'removed', reason: R },
  deepseek_web: { label: '打开网页版 DeepSeek', icon: 'web', capability: 'removed', reason: R },
  check_update: { label: '检查更新', icon: 'update', capability: 'removed', reason: R },
  network_info: { label: '网络信息', icon: 'web', capability: 'removed', reason: R },
  github_project: { label: 'GitHub 项目页', icon: 'web', capability: 'removed', reason: R },
  quark_download: { label: '夸克网盘下载', icon: 'download', capability: 'removed', reason: R },
  agent_link: { label: 'Agent 联动', icon: 'automation', capability: 'removed', reason: R },
  proactive_screen: { label: '主动识屏', icon: 'screen', capability: 'removed', reason: R },
  todo_panel: { label: '待办提醒', icon: 'todo', kind: 'action' },
  quiet_mode: { label: '免打扰', icon: 'pause', kind: 'submenu' },
  memory_trim: { label: '回收内存', icon: 'clear', kind: 'action' },
  weather: { label: '查看天气', icon: 'weather', capability: 'removed', reason: R },
  weather_cities: { label: '天气城市', icon: 'weather', capability: 'removed', reason: R },
  voice_chime_now: { label: '立即报时', icon: 'chat', capability: 'removed', reason: R },
  voice_chime_toggle: { label: '语音报时', icon: 'chat', capability: 'removed', reason: R },
  festival_now: { label: '节日寄语', icon: 'todo', kind: 'action' },
  festival_toggle: { label: '节日提醒', icon: 'todo', kind: 'toggle' },
  divination_draw: { label: '抽一支签', icon: 'todo', kind: 'action' },
  modern_settings: { label: '桌宠设置', icon: 'settings', kind: 'action' },
  quit: { label: '退出', icon: 'exit', kind: 'action' },
  island_toggle: { label: '灵动岛', icon: 'island', kind: 'toggle' },
  fun: { label: '趣味玩法', icon: 'sparkles', kind: 'submenu' },
};

const A = (id: string): MenuNode => ({ type: 'action', id });
const S = (id: string): MenuNode => ({ type: 'separator', id });
const M = (id: string, children: MenuNode[]): MenuNode => ({ type: 'submenu', id, children });

/** 已下线的菜单项：老配置里的节点也要在加载时剔除（彩蛋 / 切角色 / 速率 / 大小 / 免打扰） */
export const MENU_RETIRED = new Set([
  'ojingjing', 'character', 'playback_speed', 'size', 'quiet_mode',
  'autostart', 'hide_pet', 'spawn_pet', 'clear_spawned_pets', 'edge_probe', 'island_toggle',
]);

/** 精简收纳后的菜单：只保留可用能力，按「动作 / 控制 / 趣味 / 工具」分组 */
export const DEFAULT_MENU: MenuNode[] = [
  A('animations_hub'),
  S('sep.control'),
  M('pet_controls', [
    A('drag_physics'), A('no_move'), A('on_top'), A('overlay_through'), A('return_corner'),
  ]),
  M('fun', [
    A('golden_spin'), A('festival_now'), A('festival_toggle'), A('divination_draw'), A('memory_trim'),
  ]),
  S('sep.tools'),
  A('todo_panel'),
  S('sep.sys'),
  A('modern_settings'), A('quit'),
];

export const DEFAULT_APPEARANCE: MenuAppearance = {
  theme: 'system', density: 'standard', corner_radius: 18, ui_font: 'system', ui_font_size: 13,
  translucent: true, opacity: 0.96,
  light_background: '#fffaf5', light_foreground: '#3a2e28', light_hover: '#ffe9d6',
  dark_background: '#2a2422', dark_foreground: '#f6efe9', dark_hover: '#3d332f',
};

export function defaultProfile(overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    character: 'shenshen', scale: 1, playback_speed: 1, animation_gap_seconds: 0,
    self_talk_enabled: false, self_talk_texts: [], self_talk_bubble_style: 'classic_top',
    self_talk_duration_seconds: 4, self_talk_min_interval: 45, self_talk_max_interval: 150,
    bubble_text_scale: 100, click_sound_enabled: true, click_sound_volume: 0.7,
    drag_physics: false, drop_gravity: true, throw_strength: 1,
    collision_enabled: true,
    click_show_self_talk: false, no_move: false, ...overrides,
  };
}

export function defaultConfig(): Config {
  return {
    version: 2,
    pets: [{
      id: '0', character: 'shenshen', x: -1, y: -1, scale: 1, facing: 'left', visible: true,
      layers: { wallpaper: false, overlay: true }, ox: -1, oy: -1, profile: defaultProfile(),
    }],
    wallpaper_mode: false, wallpaper_auto_moved: [], interactive: true, mouse_through: false,
    cover_all_monitors: false, auto_hide_fullscreen: true, quiet_until: 0,
    wallpaper_visible: true, overlay_visible: true, overlay_mouse_through: false,
    on_top: true, no_move: false, lock_position: false, shift_drag: false,
    pet_opacity: 100, cursor_hidden_passthrough: false, allow_cross_screen: true,
    wallpaper_opacity: 100, overlay_opacity: 100,
    wallpaper_lock_position: false, overlay_lock_position: false,
    wallpaper_shift_drag: false, overlay_shift_drag: false,
    playback_speed: 1, animation_gap_seconds: 0, idle_low_fps_enabled: false,
    idle_low_fps_threshold: 30, anim_menu_stay_open: false,
    spawn_inherit_size: true, spawn_scale: 1,
    drag_physics: false, drop_gravity: true, throw_strength: 1,
    slingshot_enabled: false,     collision_enabled: true,
    collision_restitution: 0.995, collision_friction: 0, collision_mass_scale: 1,
    collision_impulse_cap: 9000,
    edge_probe_enabled: false, golden_spin_enabled: true,
    click_golden_spin: false, click_spin_skip_animation: false,
    self_talk_enabled: false, self_talk_min_interval: 45, self_talk_max_interval: 150,
    self_talk_duration_seconds: 4, self_talk_texts: [], self_talk_image_scale: 100,
    self_talk_image_chance: 0.3, self_talk_image_dir: '', self_talk_bubble_style: 'classic_top',
    bubble_text_scale: 100, click_show_self_talk: false,
    click_sound_enabled: true, click_sound_pack: 'builtin', click_sound_volume: 0.7,
    ui_theme: 'system', ui_font: 'system', ui_font_size: 13, ui_density: 'standard',
    corner_radius: 12, menu_opacity: 0.94,
    context_menu_layout: DEFAULT_MENU, context_menu_appearance: DEFAULT_APPEARANCE,
    menu_easter_egg: { enabled: true, title: '厉害了我的鲸', hint: '请点击', avatar: '', image_dir: '' },
    quick_launch_apps: [],
    island_enabled: false, island_show_clock: true, island_show_network: false,
    island_show_cpu: false, island_show_mem: false, island_show_gpu: false,
    island_show_fps: false, island_show_name: true, island_info_mode: 'time',
    island_custom_text: '', island_opacity: 0.9, island_edge: 'top',
    island_x: -1, island_y: 18, island_collapsed: false,
    todo_reminder_enabled: true, todo_reminder_lead_minutes: 5,
    system_notifications_enabled: true, quiet_minutes_default: 30,
    quiet_also_on_fullscreen: false, festival_enabled: true, divination_enabled: true,
    autostart: false,
    feature_activation: {
      dynamic_island: true, quick_launch: true, todo: true, festival: true,
      divination: true, collision: true, edge_probe: true, golden_spin: true,
    },
    hidden_roles: [],
    scale: 1,
  };
}

/** 清理菜单树：剔除不存在/隐藏/已下线项与空子菜单，合并连续分隔符 */
function cleanMenu(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    if (n.hidden || MENU_RETIRED.has(n.id) || (n.id && ACTIONS[n.id]?.capability === 'removed')) continue;
    if (n.type === 'submenu') {
      const kids = cleanMenu(n.children ?? []);
      if (!kids.length) continue;
      out.push({ ...n, children: kids });
    } else if (n.type === 'separator') {
      if (out.length && out[out.length - 1].type !== 'separator') out.push(n);
    } else {
      if (ACTIONS[n.id]) out.push(n);
    }
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

export function mergeConfig(raw: Partial<Config> | null | undefined): Config {
  const d = defaultConfig();
  if (!raw) return d;
  const merged = { ...d, ...raw } as Config;
  // 老配置只有共用的 pet_opacity / lock_position / shift_drag：拆层后两层都继承旧值。
  if (typeof raw.pet_opacity === 'number') {
    if (typeof raw.wallpaper_opacity !== 'number') merged.wallpaper_opacity = raw.pet_opacity;
    if (typeof raw.overlay_opacity !== 'number') merged.overlay_opacity = raw.pet_opacity;
  }
  if (typeof raw.lock_position === 'boolean') {
    if (typeof raw.wallpaper_lock_position !== 'boolean') merged.wallpaper_lock_position = raw.lock_position;
    if (typeof raw.overlay_lock_position !== 'boolean') merged.overlay_lock_position = raw.lock_position;
  }
  if (typeof raw.shift_drag === 'boolean') {
    if (typeof raw.wallpaper_shift_drag !== 'boolean') merged.wallpaper_shift_drag = raw.shift_drag;
    if (typeof raw.overlay_shift_drag !== 'boolean') merged.overlay_shift_drag = raw.shift_drag;
  }
  merged.context_menu_appearance = { ...d.context_menu_appearance, ...(raw.context_menu_appearance ?? {}) };
  merged.menu_easter_egg = { ...d.menu_easter_egg, ...(raw.menu_easter_egg ?? {}) };
  merged.feature_activation = { ...d.feature_activation, ...(raw.feature_activation ?? {}) };
  merged.context_menu_layout = Array.isArray(merged.context_menu_layout) && merged.context_menu_layout.length
    ? cleanMenu(merged.context_menu_layout)
    : DEFAULT_MENU;
  if (!merged.context_menu_layout.length) merged.context_menu_layout = DEFAULT_MENU;
  // 空数组是「全部隐藏」的合法状态，用哨兵键和首次启动的空配置区分。
  if (!Array.isArray(merged.pets) || (!merged.pets.length && !merged.home_pets_explicit)) merged.pets = d.pets;
  merged.pets = merged.pets.map((p) => ({
    ...p,
    profile: defaultProfile(p.profile ?? {}),
    // 层级缺省补全：默认跟随壁纸功能；壁纸关闭时老配置落到浮层，避免桌宠消失。
    layers: {
      wallpaper: p.layers?.wallpaper ?? merged.wallpaper_mode,
      overlay: p.layers?.overlay ?? !merged.wallpaper_mode,
    },
    ox: typeof p.ox === 'number' ? p.ox : -1,
    oy: typeof p.oy === 'number' ? p.oy : -1,
  }));
  if (!Array.isArray(merged.quick_launch_apps)) merged.quick_launch_apps = [];
  if (!Array.isArray(merged.self_talk_texts)) merged.self_talk_texts = [];
  if (!Array.isArray(merged.hidden_roles)) merged.hidden_roles = [];
  if (!Array.isArray(merged.wallpaper_auto_moved)) merged.wallpaper_auto_moved = [];
  return merged;
}
