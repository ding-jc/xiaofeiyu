// 数据模型：与原项目 config.py / menu_templates / context_menus.registry 对齐。
export type Category = 'idle' | 'turn' | 'move' | 'click' | 'drag' | 'random' | 'events';

export interface Clip { name: string; src: string; category: string; no_mirror: boolean }
export interface Stride { stride: number; curve?: number[] }

export interface Persona { system_prompt: string; self_talk: string[]; tags: string[] }
export interface AudioCfg { click: string; click_volume: number; throttle_ms: number }
export interface MediaCfg { formats: string[]; safari_dir: string }

export interface CharacterPack {
  id: string; name: string; prompt: string; theme: string; format: string;
  canvas: [number, number]; feet_y: number; fps: number; scale: number;
  body_box: [number, number, number, number] | null;
  head_box: [number, number, number, number] | null;
  clips: Record<string, Clip[]>;
  strides: Record<string, Stride>;
  no_mirror: string[];
  source: string; path: string; source_url: string;
  persona?: Persona | null; audio?: AudioCfg | null; media?: MediaCfg | null; recipe?: string;
}

/** 每宠独立档案（原项目 config-slot-N.json） */
export interface PetProfile {
  character: string;
  scale: number;
  playback_speed: number;
  animation_gap_seconds: number;
  self_talk_enabled: boolean;
  self_talk_texts: string[];
  self_talk_bubble_style: string;
  self_talk_duration_seconds: number;
  self_talk_min_interval: number;
  self_talk_max_interval: number;
  bubble_text_scale: number;
  click_sound_enabled: boolean;
  click_sound_volume: number;
  drag_physics: boolean;
  drop_gravity: boolean;
  throw_strength: number;
  collision_enabled: boolean;
  click_show_self_talk: boolean;
  no_move: boolean;
  [key: string]: unknown;
}

export interface PetConfig {
  id: string; character: string; x: number; y: number; scale: number;
  facing: string; visible: boolean; profile?: PetProfile;
  /** 该槽位在哪些层显示：壁纸层（桌面）+ 浮层（置顶悬浮） */
  layers?: PetLayers;
  /** 浮层坐标（壁纸层用 x / y，两层互不干扰） */
  ox?: number; oy?: number;
}

/** 渲染层级：壁纸层贴在 WorkerW 底层，浮层是置顶透明窗。 */
export type PetLayer = 'wallpaper' | 'overlay';
export interface PetLayers { wallpaper: boolean; overlay: boolean }

export interface MenuNode {
  type: 'action' | 'submenu' | 'separator';
  id: string;
  label?: string;      // 别名（运行时覆盖规范标签）
  icon?: string;       // 图标覆盖：语义名 | none | data url
  hidden?: boolean;
  children?: MenuNode[];
}

export interface MenuAppearance {
  theme: 'system' | 'light' | 'dark';
  density: 'compact' | 'standard' | 'spacious';
  corner_radius: number;
  ui_font: string;
  ui_font_size: number;
  translucent: boolean;
  opacity: number;
  light_background: string; light_foreground: string; light_hover: string;
  dark_background: string; dark_foreground: string; dark_hover: string;
}

export interface QuickLaunchApp { name: string; path: string; args?: string; enabled: boolean }

export interface TodoItem {
  id: string; title: string; note: string;
  due: number;             // epoch ms
  lead_minutes: number;
  done: boolean; reminded: boolean; created: number;
}

export interface EggConfig { enabled: boolean; title: string; hint: string; avatar: string; image_dir: string }

/** 全局配置：强类型键 + 原版键透传 */
export interface Config {
  version: number;
  pets: PetConfig[];
  wallpaper_mode: boolean;
  /** 关闭壁纸功能时自动转到浮层的宠物 id，重新开启时按此还原。 */
  wallpaper_auto_moved?: string[];
  interactive: boolean;
  mouse_through: boolean;
  cover_all_monitors: boolean;
  auto_hide_fullscreen: boolean;
  quiet_until: number;
  // 层级显隐（壁纸层 / 浮层各自一个开关，主界面「显示 / 隐藏」按层区分）
  wallpaper_visible: boolean;
  overlay_visible: boolean;
  /** 浮层鼠标穿透：整层不接收鼠标，点击直接落到下面的窗口 */
  overlay_mouse_through: boolean;
  // 窗口 / 显示（整层）
  on_top: boolean;
  no_move: boolean;
  lock_position: boolean;   // 兼容旧配置；实际按层读 wallpaper_lock_position / overlay_lock_position
  shift_drag: boolean;      // 兼容旧配置；实际按层读 wallpaper_shift_drag / overlay_shift_drag
  pet_opacity: number;      // 兼容旧配置；实际按层读 wallpaper_opacity / overlay_opacity
  wallpaper_opacity: number;
  overlay_opacity: number;
  wallpaper_lock_position: boolean;
  overlay_lock_position: boolean;
  wallpaper_shift_drag: boolean;
  overlay_shift_drag: boolean;
  cursor_hidden_passthrough: boolean;
  allow_cross_screen: boolean;
  // 动画
  playback_speed: number;
  animation_gap_seconds: number;
  idle_low_fps_enabled: boolean;
  idle_low_fps_threshold: number;
  anim_menu_stay_open: boolean;
  spawn_inherit_size: boolean;
  spawn_scale: number;
  // 物理 / 玩法
  drag_physics: boolean;
  drop_gravity: boolean;
  throw_strength: number;
  slingshot_enabled: boolean;
  collision_enabled: boolean;
  collision_restitution: number;
  collision_friction: number;
  collision_mass_scale: number;
  collision_impulse_cap: number;
  edge_probe_enabled: boolean;
  golden_spin_enabled: boolean;
  click_golden_spin: boolean;
  click_spin_skip_animation: boolean;
  // 气泡
  self_talk_enabled: boolean;
  self_talk_min_interval: number;
  self_talk_max_interval: number;
  self_talk_duration_seconds: number;
  self_talk_texts: string[];
  self_talk_image_scale: number;
  self_talk_image_chance: number;
  self_talk_image_dir: string;
  self_talk_bubble_style: string;
  bubble_text_scale: number;
  click_show_self_talk: boolean;
  // 音效
  click_sound_enabled: boolean;
  click_sound_pack: string;
  click_sound_volume: number;
  // 菜单
  ui_theme: string;
  ui_font: string;
  ui_font_size: number;
  ui_density: string;
  corner_radius: number;
  menu_opacity: number;
  context_menu_layout: MenuNode[];
  context_menu_appearance: MenuAppearance;
  menu_easter_egg: EggConfig;
  quick_launch_apps: QuickLaunchApp[];
  // 桌面组件（灵动岛）
  island_enabled: boolean;
  island_show_clock: boolean;
  island_show_network: boolean;
  island_show_cpu: boolean;
  island_show_mem: boolean;
  island_show_gpu: boolean;
  island_show_fps: boolean;
  island_show_name: boolean;
  island_info_mode: string;
  island_custom_text: string;
  island_opacity: number;
  island_edge: 'top' | 'bottom';
  island_x: number;
  island_y: number;
  island_collapsed: boolean;
  // 自动化
  todo_reminder_enabled: boolean;
  todo_reminder_lead_minutes: number;
  system_notifications_enabled: boolean;
  quiet_minutes_default: number;
  quiet_also_on_fullscreen: boolean;
  festival_enabled: boolean;
  divination_enabled: boolean;
  autostart: boolean;
  // 功能开关（原项目 feature_activation）
  feature_activation: Record<string, boolean>;
  // 被隐藏的角色包 id：不显示、不参与切换与随机
  hidden_roles: string[];
  // 壁纸层专有
  scale: number;
  [key: string]: unknown;
}

export interface Monitor { name: string; x: number; y: number; width: number; height: number; scale: number }
export interface CommandEvent { cmd: string; payload: unknown }
export interface Metrics {
  cpu: number; mem: number; mem_used_mb: number; mem_total_mb: number;
  down_kb: number; up_kb: number;
}
