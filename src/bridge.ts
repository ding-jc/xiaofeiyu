import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pick, save as saveDialog, ask } from '@tauri-apps/plugin-dialog';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { CharacterPack, CommandEvent, Config, Metrics, Monitor } from './types';

/** 网页深链带来的待确认导入清单概览（不含素材，仅用于预览）。 */
export interface ImportPreview {
  url: string; id: string; name: string; theme: string; source: string;
  count: number; categories: Record<string, number>;
  exists?: boolean; baseId?: string; suggestName?: string; error?: string;
}

/** 浮层命中窗的鼠标语义：type=down/up/move/leave/rdown/contextmenu/dblclick/wheel。 */
export interface OverlayMouse {
  type: string; x: number; y: number; button: number;
  shift: boolean; ctrl: boolean; delta: number;
  /** 仅 up：命中窗已在原生层裁决本次点击允许播放音效。 */
  sound?: boolean;
}

export const api = {
  config: () => invoke<Config>('get_config'),
  save: (c: Config) => invoke<void>('set_config', { value: c }),
  /** 增量保存桌宠坐标：{id, x, y}[]。 */
  savePositions: (positions: { id: string; x: number; y: number }[]) =>
    invoke<void>('save_pet_positions', { positions }),
  data: <T = unknown>(name: string) => invoke<T>('get_data', { name }),
  setData: (name: string, value: unknown) => invoke<void>('set_data', { name, value }),
  slots: () => invoke<{ id: string; profile: unknown }[]>('list_slots'),
  saveSlot: (id: string, profile: unknown) => invoke<void>('save_slot', { id, profile }),
  deleteSlot: (id: string) => invoke<void>('delete_slot', { id }),
  metrics: (on: boolean) => invoke<void>('set_metrics', { on }),
  notify: (title: string, body: string) => invoke<void>('notify', { title, body }),
  run: (path: string, args?: string[]) => invoke<void>('run_program', { path, args }),
  packs: () => invoke<CharacterPack[]>('list_packs'),
  import: (path: string) => invoke<{ id: string }>('import_pack', { path }),
  importWeb: (url: string, merge = false, newName?: string) =>
    invoke<{ id: string }>('import_web_url', { url, merge, newName: newName ?? null }),
  takePendingImports: () => invoke<string[]>('take_pending_imports'),
  previewImport: (url: string) => invoke<ImportPreview>('preview_import', { url }),
  onImportPending: (cb: () => void) => api.on<null>('import://pending', () => cb()),
  // 统一素材格式：转换全在 Rust 进程内完成，前端只传路径，字节不跨 IPC
  convertImport: (path: string, name?: string) =>
    invoke<{ id: string; name: string; format: string; label: string }>('convert_import', { path, name: name ?? null }),
  exportDshZip: (id: string, target: string, root?: string) =>
    invoke<{ path: string; root: string }>('export_dsh_zip', { id, target, root: root ?? null }),
  writeDshPet: (id: string, root?: string) =>
    invoke<{ dir: string; root: string }>('write_dsh_pet', { id, root: root ?? null }),
  previewDshWrite: (root?: string) =>
    invoke<{ dshHome: string; petDir: string; root: string; config: string; animationDir: string }>('preview_dsh_write', { root: root ?? null }),
  remove: (id: string) => invoke<void>('remove_pack', { id }),
  settings: (slot?: string) => invoke<void>('open_settings', { slot: slot ?? null }),
  settingsReady: () => invoke<void>('settings_ready'),
  openTodo: () => invoke<void>('open_todo'),
  broadcast: (cmd: string, payload: unknown = null) => invoke<void>('broadcast', { cmd, payload }),
  monitors: () => invoke<Monitor[]>('get_monitors'),
  /** 浮层命中遮罩：供原生命中窗做逐像素命中。 */
  overlayHitMask: (cols: number, rows: number, bits: number[]) =>
    invoke<void>('set_overlay_hit_mask', { payload: { cols, rows, bits } }),
  /** 拖动期撤掉浮层 region，避免低精度遮罩裁剪渲染出网格锯齿。 */
  overlayDragging: (on: boolean) => invoke<void>('set_overlay_dragging', { on }),
  /** 浮层引擎装好之后调用：这时才让置顶窗显示。 */
  overlayReady: () => invoke<void>('overlay_ready'),
  onContextMenu: (cb: (v: { x: number; y: number; left: number; top: number; width: number; height: number }) => void) =>
    api.on('pet://context-menu', cb),
  hidden: (on: boolean) => invoke<void>('set_hidden', { hidden: on }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  reset: () => invoke<Config>('reset_config'),
  showDataDir: () => invoke<void>('show_data_dir'),
  workArea: (label?: string) => invoke<{ x: number; y: number; w: number; h: number }>('work_area', { label }),
  quit: () => invoke<void>('quit'),

  // 右键菜单：独立的透明 webview 窗渲染（view=menu），等点击返回下标路径。
  nativeMenuShow: (x: number, y: number, items: unknown, layer: string) =>
    invoke<number[] | null>('native_menu_show', { x, y, items, layer }),
  onFullscreen: (cb: (on: boolean) => void) => api.on<{ on: boolean }>('pet://fullscreen', (v) => cb(v.on)),
  /** 浮层命中窗转来的鼠标语义事件（客户区坐标 == DOM CSS 坐标），浮层世界合成 PointerEvent 派发。 */
  onOverlayMouse: (cb: (v: OverlayMouse) => void) =>
    api.on<OverlayMouse>('overlay://mouse', cb),
  /** 旧滚轮通道，保留兼容。 */
  onOverlayWheel: (cb: (v: { deltaY: number; x: number; y: number }) => void) =>
    api.on<{ deltaY: number; x: number; y: number }>('overlay://wheel', cb),

  on<T>(name: string, cb: (v: T) => void): Promise<UnlistenFn> {
    return listen<T>(name, (e) => cb(e.payload));
  },
  onConfig: (cb: (v: Config) => void) => api.on<Config>('config://changed', cb),
  onPacks: (cb: (v: CharacterPack[]) => void) => api.on<CharacterPack[]>('packs://changed', cb),
  onCommand: (cb: (v: CommandEvent) => void) => api.on<CommandEvent>('pet://command', cb),
  onVisible: (cb: (v: boolean) => void) => api.on<boolean>('pet://visible', cb),
  onData: <T>(name: string, cb: (v: T) => void) => api.on<T>(`data://${name}`, cb),
  /** 素材转换长任务进度：{stage, done, total, percent} */
  onAssetProgress: (cb: (v: { stage: string; done: number; total: number; percent: number }) => void) =>
    api.on('asset://progress', cb),
  onMetrics: (cb: (v: Metrics) => void) => api.on<Metrics>('sys://metrics', cb),
  onSlot: (cb: (v: { id: string; profile: unknown }) => void) => api.on('slot://changed', cb),
  onBounds: (cb: (v: { x: number; y: number; width: number; height: number }) => void) =>
    api.on('pet://bounds', cb),

  pickFolder: async (): Promise<string | null> => {
    const r = await pick({ directory: true, multiple: false, title: '选择桌宠素材包文件夹' });
    return Array.isArray(r) ? r[0] ?? null : r;
  },
  pickZip: async (): Promise<string | null> => {
    const r = await pick({
      multiple: false, title: '选择桌宠素材包 .zip',
      filters: [{ name: '素材包', extensions: ['zip'] }],
    });
    return Array.isArray(r) ? r[0] ?? null : r;
  },
  pickFile: async (title: string, extensions: string[]): Promise<string | null> => {
    const r = await pick({ multiple: false, title, filters: [{ name: '文件', extensions }] });
    return Array.isArray(r) ? r[0] ?? null : r;
  },
  pickSave: async (title: string, defaultName: string, extensions: string[]): Promise<string | null> => {
    const r = await saveDialog({ title, defaultPath: defaultName, filters: [{ name: '文件', extensions }] });
    return Array.isArray(r) ? r[0] ?? null : r;
  },
  /** 原生异步二次确认：await 真正阻塞到用户点确认，杜绝 confirm() 非阻塞导致"未确认就执行"。 */
  confirm: (message: string, title = '请确认'): Promise<boolean> =>
    ask(message, { title, kind: 'warning', okLabel: '确定', cancelLabel: '取消' }),
  autostart: { isEnabled, enable, disable },

  onDropPaths(cb: (paths: string[]) => void) {
    return getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === 'drop') cb(e.payload.paths);
    });
  },
};

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
