// 主界面状态：角色包 / 槽位 / 角色元数据 / 动作分类 / 轮播编排，全部落本地 JSON。
import { computed, reactive } from 'vue';
import { petUrl } from '../../asset-url';
import { api } from '../../bridge';
import { loadConfig } from '../../boot';
import { defaultConfig, defaultProfile, mergeConfig } from '../../data/defaults';
import { sortPacks } from '../../pet/catalog';
import { normLayout, type ActionLayout } from '../../pet/action-layout';
import type { ImportPreview } from '../../bridge';
import type { CharacterPack, Clip, Config, PetConfig } from '../../types';

export interface RoleMeta {
  name?: string; theme?: string; prompt?: string; scale?: number;
  fps?: number; feet_y?: number; canvas?: [number, number];
  custom_scale?: boolean; // 该角色被单独设置过大小 → 全局大小滑块黯淡
  restore?: number; // 隐藏前的分身数，重新显示时按此数量补回
}
export interface DialogState {
  type: 'actions' | 'edit' | 'add' | 'import';
  packId: string;
  tab?: string;
  clip?: Clip | null;
  preview?: ImportPreview;
  importLoading?: boolean; // 导入框已弹出、清单仍在拉取中
  importUrl?: string;      // 待确认清单地址
  importMerge?: boolean;   // 确认时是否合并到同名包
  importNewName?: string;  // 导入为新角色时的新名称（必须不同于现有）
}
export interface RoleView {
  pack: CharacterPack; id: string; name: string; theme: string;
  count: number; clones: PetConfig[]; enabled: boolean; scale: number;
  status: string; cover: Clip | null; gradient: string;
}

const PALETTE = ['#6f8fd0', '#e8974a', '#c7a06a', '#b49bd4', '#5b5b68', '#7fa8d8', '#df9fa9', '#89b9a3', '#d1a15c'];
const FALLBACK_NAMES: Record<string, string> = {
  shenshen: '蓝毛小女仆', ojousama: '橙毛大小姐', character3: '黄毛该溜子',
  character4: '白毛小龙娘', character5: '黑毛小狐狸', character6: '奶茶千金',
  character11: '北美大豆包', character12: '豆小妹', character13: '中二少女',
};
let localEditAt = 0;
let toastTimer = 0;

export const S = reactive({
  ready: false,
  cfg: defaultConfig() as Config,
  packs: [] as CharacterPack[],
  meta: {} as Record<string, RoleMeta>,
  playlists: {} as Record<string, string[]>,
  categories: {} as Record<string, Record<string, string[]>>,
  actionLayouts: {} as Record<string, ActionLayout>,
  tab: '我的角色' as '我的角色' | '偏好设置',
  hoverId: '',
  openMoreId: '', // 当前展开···下拉的角色 id（全局共享，保证同时只开一个）
  toast: '',
  dialog: null as DialogState | null,
  // 素材转换全局进度：title=null 表示隐藏；percent 0-100；stage 为当前阶段键
  progress: null as null | { title: string; stage: string; detail: string; percent: number },
});

const obj = <T>(v: unknown, fallback: T): T =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback;
function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
function mix(hex: string, white = 0.85) {
  const m = /^#?([\da-f]{6})$/i.exec(hex);
  if (!m) return '#f6f2f4';
  const n = parseInt(m[1], 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * white));
  return `rgb(${c.join(',')})`;
}
export const themeOf = (p: CharacterPack) => {
  const own = S.meta[p.id]?.theme;
  if (own) return own;
  if (p.id === 'shenshen') return PALETTE[0];
  if (p.theme && p.theme !== '#2f7fbf') return p.theme;
  return PALETTE[hash(p.id) % PALETTE.length];
};
export const gradientOf = (hex: string) => `linear-gradient(155deg, ${mix(hex, 0.80)}, ${mix(hex, 0.91)})`;
export const assetUrl = (src: string) => src.startsWith('http') ? src : petUrl(src.replace(/^\//, ''));
export const clipCount = (p: CharacterPack) =>
  Object.values(p.clips ?? {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
export const allClips = (p: CharacterPack): Clip[] => Object.values(p.clips ?? {}).flat();
const coverOf = (p: CharacterPack): Clip | null =>
  p.clips?.idle?.[0] ?? p.clips?.random?.[0] ?? allClips(p)[0] ?? null;

export const roles = computed<RoleView[]>(() => sortPacks(S.packs).map((p) => {
  const clones = S.cfg.pets.filter((c) => c.character === p.id);
  const scale = clones[0]?.scale ?? S.meta[p.id]?.scale ?? p.scale ?? 0.7;
  return {
    pack: p, id: p.id, name: S.meta[p.id]?.name || FALLBACK_NAMES[p.id] || p.name || p.id,
    theme: themeOf(p), count: clipCount(p), clones, enabled: clones.length > 0,
    scale, status: clones.length ? `${clones.length} 只陪伴中` : '休息中',
    cover: coverOf(p), gradient: gradientOf(themeOf(p)),
  };
}));
export const activeCount = computed(() => roles.value.reduce((n, r) => n + r.clones.length, 0));
export const waitingCount = computed(() => roles.value.filter((r) => !r.enabled).length);
export const byId = (id: string) => roles.value.find((r) => r.id === id);

export function toast(msg: string) {
  S.toast = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { S.toast = ''; }, 2600);
}

// 素材转换进度：Rust 侧 stage 事件 → 阶段映射 → 全局进度条。
// 一次转换分多阶段（read/convert/write 或 read/convert/zip），每阶段权重不同。
export const STAGE_LABEL: Record<string, string> = { read: '读取素材', write: '写入素材', zip: '打包素材', convert: '转换格式' };
const STAGE_RANGE: Record<string, [number, number]> = {
  read: [0, 40], convert: [40, 55], write: [55, 98], zip: [55, 98],
};
export function beginProgress(title: string) {
  S.progress = { title, stage: 'read', detail: '', percent: 0 };
}
export function endProgress() { S.progress = null; }
export function onAssetProgress(e: { stage: string; done: number; total: number; percent: number }) {
  if (!S.progress) return;
  const [from, to] = STAGE_RANGE[e.stage] || [0, 100];
  S.progress.stage = e.stage;
  S.progress.percent = Math.round(from + (to - from) * e.percent / 100);
  S.progress.detail = `${e.done}/${e.total}`;
}
export function openDialog(d: DialogState) { S.dialog = d; }
export function closeDialog() { S.dialog = null; }

// 网页深链导入：先弹框显示 loading（纯内存取 URL），再异步拉清单填充；多个清单依次确认。
let importQueue: string[] = [];
let draining = false;
async function drainImports() {
  if (draining) return;
  draining = true;
  try {
    const urls = await api.takePendingImports(); // 瞬间返回，curl 不在这里
    importQueue.push(...urls);
    showNextImport();
  } catch (e) { toast(`读取待导入清单失败：${String(e)}`); }
  finally { draining = false; }
}
function showNextImport() {
  if (S.dialog?.type === 'import') return;
  const url = importQueue.shift();
  if (!url) return;
  // 弹框先行：loading 态，用户立刻看到反馈，主窗渲染不阻塞
  openDialog({ type: 'import', packId: '', importUrl: url, importLoading: true, importMerge: false, importNewName: '' });
  void loadImportPreview(url);
}
async function loadImportPreview(url: string) {
  try {
    const preview = await api.previewImport(url);
    // 期间用户可能已取消 / 切走，只有仍是同一 URL 的导入框才更新
    if (S.dialog?.type === 'import' && S.dialog.importUrl === url) {
      S.dialog.preview = preview;
      S.dialog.packId = preview.baseId || preview.id;
      S.dialog.importNewName = preview.suggestName || '';
      S.dialog.importLoading = false;
    }
  } catch (e) {
    if (S.dialog?.type === 'import' && S.dialog.importUrl === url) {
      toast(`读取导入清单失败：${String(e)}`);
      S.dialog = null;
      showNextImport();
    }
  }
}
export function setImportMerge(on: boolean) {
  if (S.dialog?.type === 'import') S.dialog.importMerge = on;
}
export function setImportNewName(name: string) {
  if (S.dialog?.type === 'import') S.dialog.importNewName = name;
}
export async function confirmImport() {
  const d = S.dialog;
  if (d?.type !== 'import' || !d.importUrl || d.importLoading) return;
  const url = d.importUrl;
  const merge = d.importMerge === true;
  // 同名且选「导入为新角色」：必须改成与现有不同的名字
  const newName = d.preview?.exists && !merge ? d.importNewName?.trim() ?? '' : '';
  if (!merge && d.preview?.exists && (!newName || newName === d.preview.name)) {
    toast('请填写一个与原角色不同的新名称');
    return;
  }
  const label = newName || d.preview?.name || d.packId || '角色';
  S.dialog = null;
  try {
    toast('正在下载角色素材…');
    await api.importWeb(url, merge, newName || undefined);
    toast(`已导入角色：${label}`);
  } catch (e) { toast(`导入失败：${String(e)}`); }
  showNextImport();
}
export function cancelImport() {
  S.dialog = null;
  showNextImport();
}

let saveTimer = 0;
async function saveCfg(pets?: PetConfig[], patch: Partial<Config> = {}) {
  const next = mergeConfig({ ...S.cfg, ...patch, ...(pets ? { pets } : {}), home_pets_explicit: true });
  localEditAt = Date.now();
  S.cfg = next; // 响应式即时更新，开关手感不延迟
  // 写盘 + Rust 侧窗口重建防抖：连点层开关只让最后一次生效，避免反复销毁/重建 WebView。
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void api.save(S.cfg); }, 260);
}

const newId = () => `h${Date.now().toString(36)}${(Math.random() * 1e4 | 0).toString(36)}`;
const MAX_CLONES = 8, MAX_PETS = 24;

/** 把角色补齐到 total 只（受单角色 8 / 全局 24 上限约束），返回实际新增数。 */
function fill(pets: PetConfig[], packId: string, total: number, scale: number): number {
  let cur = pets.filter((p) => p.character === packId).length, added = 0;
  while (cur < total && cur < MAX_CLONES && pets.length < MAX_PETS) {
    pets.push(makePet(packId, scale, pets.length));
    cur++; added++;
  }
  return added;
}

/** 记住/清除角色隐藏前的分身数，重新显示时按此补回。 */
async function setRestore(id: string, n?: number) {
  S.meta = { ...S.meta, [id]: { ...S.meta[id], restore: n } };
  await api.setData('character_meta', S.meta);
}

function makePet(packId: string, scale: number, n: number): PetConfig {
  return {
    id: newId(), character: packId,
    x: 120 + (n % 5) * 170, y: 140 + Math.floor(n / 5) * 130,
    scale, facing: n % 2 ? 'right' : 'left', visible: true,
    profile: defaultProfile({ character: packId, scale }),
    layers: { wallpaper: false, overlay: true },
    ox: -1, oy: -1,
  };
}

export async function addClone(packId: string) {
  const r = byId(packId);
  if (!r) return;
  const pets = [...S.cfg.pets];
  if (!fill(pets, packId, r.clones.length + 1, r.scale)) {
    return toast(r.clones.length >= MAX_CLONES ? '每位角色最多 8 个分身啦' : '最多同时陪伴 24 只桌宠');
  }
  await saveCfg(pets);
  toast(`「${r.name}」来陪你啦～`);
}
export async function reduceClone(packId: string) {
  const r = byId(packId);
  if (!r || !r.clones.length) return;
  await removeClone(r.clones[r.clones.length - 1].id);
  toast(`「${r.name}」少了一只分身`);
}
export async function setEnabled(packId: string, on: boolean) {
  const r = byId(packId);
  if (!r) return;
  if (on) {
    // 按隐藏前记住的分身数补回（缺省 1 只），不是只补一只
    const want = Math.max(1, S.meta[packId]?.restore ?? 1);
    const pets = [...S.cfg.pets];
    const added = fill(pets, packId, want, r.scale);
    await setRestore(packId, undefined);
    await saveCfg(pets);
    toast(added > 1 ? `「${r.name}」${added} 只回来啦～` : `「${r.name}」来陪你啦～`);
    return;
  }
  await setRestore(packId, r.clones.length);
  await saveCfg(S.cfg.pets.filter((p) => p.character !== packId));
  toast(`「${r.name}」${r.clones.length} 只已休息`);
}
export async function removeClone(id: string) {
  await saveCfg(S.cfg.pets.filter((p) => p.id !== id));
  toast('分身已退出');
}
export async function clearClones(packId: string) {
  await saveCfg(S.cfg.pets.filter((p) => p.character !== packId));
  toast('已让这位角色的全部分身休息');
}
export async function setScale(packId: string, value: number) {
  const v = Math.round(Math.max(0.3, Math.min(1.2, value)) * 100) / 100;
  const pets = S.cfg.pets.map((p) => p.character === packId
    ? { ...p, scale: v, profile: { ...defaultProfile(p.profile ?? {}), scale: v } }
    : p);
  S.meta = { ...S.meta, [packId]: { ...S.meta[packId], scale: v, custom_scale: true } };
  await api.setData('character_meta', S.meta);
  await saveCfg(pets);
}
export async function resetScale(packId: string) {
  await setScale(packId, 0.7);
  S.meta = { ...S.meta, [packId]: { ...S.meta[packId], scale: undefined, custom_scale: undefined } };
  await api.setData('character_meta', S.meta);
  toast('大小已恢复默认 70%');
}
/** 有角色被单独设置过大小 → 全局大小滑块黯淡。 */
export const anyCustomScale = computed(() => S.packs.some((p) => S.meta[p.id]?.custom_scale));
/** 全局统一大小：应用到全部已开启角色，并清除单独设置标记（全局滑块恢复可用）。 */
export async function setAllSizes(value: number) {
  const v = Math.round(Math.max(0.3, Math.min(1.2, value)) * 100) / 100;
  const pets = S.cfg.pets.map((p) => ({ ...p, scale: v, profile: { ...defaultProfile(p.profile ?? {}), scale: v } }));
  const meta = { ...S.meta };
  for (const p of S.packs) meta[p.id] = { ...meta[p.id], scale: v, custom_scale: undefined };
  S.meta = meta;
  await api.setData('character_meta', S.meta);
  await saveCfg(pets);
  toast(`全部角色大小已统一为 ${Math.round(v * 100)}%`);
}
/** 批量开启：按各角色隐藏前数量补回（缺省 1 只）；批量隐藏：移除全部桌宠并记住各自数量。 */
export async function enableAll() {
  let changed = 0;
  let pets = [...S.cfg.pets];
  for (const r of roles.value) {
    if (pets.length >= MAX_PETS) break;
    if (pets.some((p) => p.character === r.id)) continue;
    const want = Math.max(1, S.meta[r.id]?.restore ?? 1);
    changed += fill(pets, r.id, want, r.scale);
    await setRestore(r.id, undefined);
  }
  await saveCfg(pets);
  toast(changed ? `已开启 ${changed} 只桌宠` : '所有角色都已陪伴中');
}
export async function hideAll() {
  const n = S.cfg.pets.length;
  for (const r of roles.value) if (r.clones.length) await setRestore(r.id, r.clones.length);
  await saveCfg([]);
  toast(n ? `已隐藏 ${n} 只桌宠` : '当前没有陪伴中的桌宠');
}

export async function saveMeta(id: string, m: RoleMeta) {
  S.meta = { ...S.meta, [id]: { ...S.meta[id], ...m } };
  await api.setData('character_meta', S.meta);
  toast('角色资料已保存');
}
export async function savePlaylist(id: string, order: string[]) {
  S.playlists = { ...S.playlists, [id]: order };
  await api.setData('character_playlists', S.playlists);
  toast('轮播编排已保存，桌宠会按顺序播放');
}
export async function saveCategories(id: string, cats: Record<string, string[]>) {
  S.categories = { ...S.categories, [id]: cats };
  await api.setData('character_categories', S.categories);
  toast('动作分类已保存');
}

/** 保存单个角色的动作布局（排序 + 显隐），右键菜单实时同步。 */
export async function saveActionLayout(id: string, layout: ActionLayout) {
  S.actionLayouts = { ...S.actionLayouts, [id]: layout };
  await api.setData('character_action_layout', S.actionLayouts);
}
/** 恢复初始：直接删除该角色的自定义布局记录。 */
export async function resetActionLayout(id: string) {
  const next = { ...S.actionLayouts };
  delete next[id];
  S.actionLayouts = next;
  await api.setData('character_action_layout', next);
  toast('已恢复初始动作列表');
}

/** 统一导入：文件夹/zip → Rust 探测格式(新格式 / dsh 两系) → 转换落地，字节不跨 IPC。 */
export async function importPaths(paths: string[]) {
  for (const p of paths) {
    if (/\.json$/i.test(p)) {
      try { const r = await api.import(p); toast(`已添加角色：${r.id}`); }
      catch (e) { toast(`导入失败：${String(e)}`); }
      continue;
    }
    beginProgress('导入角色素材');
    try {
      const r = await api.convertImport(p);
      toast(`已添加「${r.name}」（${r.label}）`);
    } catch (e) { toast(`导入失败：${String(e)}`); }
    finally { endProgress(); }
  }
  S.packs = await api.packs().catch(() => S.packs);
}
export async function pickImport(kind: 'folder' | 'zip') {
  const p = kind === 'folder' ? await api.pickFolder() : await api.pickZip();
  if (p) await importPaths([p]);
}

/** 导出为 dsh-pet 格式 ZIP：Rust 内读包→转换→打包。 */
export async function exportDsh(id: string) {
  const role = roles.value.find((r) => r.id === id);
  if (!role) return;
  const target = await api.pickSave('导出 dsh-pet 素材包', `${role.name}-dsh.zip`, ['zip']);
  if (!target) return;
  beginProgress('导出 dsh-pet 素材包');
  try {
    await api.exportDshZip(id, target, role.name);
    toast('已导出 dsh-pet 格式素材包');
  } catch (e) { toast(`导出失败：${String(e)}`); }
  finally { endProgress(); }
}

/** 一键写入本地 dsh 插件：写入前展示目标路径与文件清单待确认 */
export async function writeDsh(id: string) {
  const role = roles.value.find((r) => r.id === id);
  if (!role) return;
  try {
    const pv = await api.previewDshWrite(role.name);
    const ok = await api.confirm(
      `将写入以下 dsh 桌宠文件：\n\n` +
      `配置：${pv.config}\n素材目录：${pv.animationDir}\n\n` +
      `dsh 用户目录：${pv.dshHome}\n\n确认写入？`, '导入到 dsh-pet');
    if (!ok) return;
    beginProgress('写入本地 dsh 桌宠');
    const r = await api.writeDshPet(id, role.name);
    toast(`已写入 dsh 桌宠：${r.root}`);
  } catch (e) { toast(`写入失败：${String(e)}`); }
  finally { endProgress(); }
}
export function openPrefs(slot?: string) {
  const u = new URL(location.href);
  if (slot) u.searchParams.set('slot', slot); else u.searchParams.delete('slot');
  history.replaceState(null, '', u);
  S.tab = '偏好设置';
  api.settings(slot).catch(() => {});
}

export async function removePack(id: string) {
  const r = byId(id);
  if (!r) return;
  if (!await api.confirm(`移除角色「${r.name}」及其素材包？`, '移除角色')) return;
  const pets = S.cfg.pets.filter((p) => p.character !== id);
  await api.remove(id).catch((e) => toast(String(e)));
  await saveCfg(pets);
  S.packs = await api.packs().catch(() => S.packs);
  toast('角色已移除');
  closeDialog();
}

export async function init() {
  // 首屏只等配置（快），立即渲染骨架并让窗口显形；素材/档案等重数据后台拉取，
  // 其中 list_packs 会等材料扫描（最多 10s），不能挡首屏，否则白屏几秒。
  S.cfg = await loadConfig();
  // 骨架已在（index.html 内联 + Vue loading 遮罩），立即让窗口显形，不必空等素材扫描。
  // 角色列表数据后台拉取，到齐后再撤遮罩（S.ready），杜绝空列表白屏。
  void api.settingsReady();
  void Promise.all([
    api.packs().catch(() => [] as CharacterPack[]),
    api.data<Record<string, RoleMeta>>('character_meta').catch(() => ({})),
    api.data<Record<string, string[]>>('character_playlists').catch(() => ({})),
    api.data<Record<string, Record<string, string[]>>>('character_categories').catch(() => ({})),
    api.data<Record<string, unknown>>('character_action_layout').catch(() => ({})),
  ]).then(([packs, meta, pl, cats, layouts]) => {
    S.packs = packs;
    S.meta = obj(meta, {});
    S.playlists = obj(pl, {});
    S.categories = obj(cats, {});
    const L = obj(layouts, {});
    S.actionLayouts = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, normLayout(v)]));
    S.ready = true;
  });
  api.onConfig((c) => {
    if (Date.now() - localEditAt < 900) return;
    S.cfg = mergeConfig(c);
  }).catch(() => {});
  api.onPacks((list) => { S.packs = list; }).catch(() => {});
  api.onData<Record<string, RoleMeta>>('character_meta', (v) => { if (Date.now() - localEditAt > 900) S.meta = obj(v, {}); }).catch(() => {});
  api.onData<Record<string, string[]>>('character_playlists', (v) => { S.playlists = obj(v, {}); }).catch(() => {});
  api.onData<Record<string, Record<string, string[]>>>('character_categories', (v) => { S.categories = obj(v, {}); }).catch(() => {});
  api.onData<Record<string, unknown>>('character_action_layout', (v) => {
    const L = obj(v, {});
    S.actionLayouts = Object.fromEntries(Object.entries(L).map(([k, x]) => [k, normLayout(x)]));
  }).catch(() => {});
  api.onAssetProgress(onAssetProgress).catch(() => {});
  api.onDropPaths((paths) => importPaths(paths)).catch(() => {});
  // 网页深链导入：监听后端通知 + 首帧主动拉取（首次启动时主窗口才刚建好）。
  api.onImportPending(() => void drainImports()).catch(() => {});
  void drainImports();
  // 退出前把防抖中未落盘的配置写回，避免连点开关后立刻退出丢配置。
  window.addEventListener('beforeunload', () => {
    window.clearTimeout(saveTimer);
    void api.save(S.cfg);
  });
  // 注：S.ready 在 packs 到齐后置 true（见上方 Promise.all），loading 遮罩维持到角色列表就绪。
}
