// 运行时右键菜单（独立透明窗，view=menu）。
// 面板样式复用主窗口的 .modern-menu，图标复用 data/icons 的 Lucide 线稿，
// 所以菜单和主界面是同一套字体、同一套图标、同一套主题变量。
// 布局（含子菜单翻转与屏幕边界收拢）全在这里算，算完把窗口矩形报给 Rust。
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { iconSvg } from '../../data/icons';
import type { Config } from '../../types';

interface MenuNode {
  id?: string;
  reason?: string;
  type: 'action' | 'submenu' | 'separator';
  label: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  children?: MenuNode[];
}

interface Pending {
  seq: number;
  items: MenuNode[];
  tray: boolean;
  ax: number;
  ay: number;
  work: { left: number; top: number; right: number; bottom: number };
}

/** 子菜单与父面板的水平间距 */
const GAP = 4;
/** 子菜单相对父项上移一点，和主界面的一致 */
const SUB_LIFT = 6;

interface Panel {
  el: HTMLElement;
  nodes: MenuNode[];
  x: number;
  y: number;
  /** 父面板里第几项打开的（根面板为 null） */
  childOf: number | null;
  sel: number | null;
}

let pending: Pending | null = null;
let seq = -1;
let panels: Panel[] = [];

/** #rrggbb / rgb() → 带透明度的 rgba()。 */
function withAlpha(color: string, alpha: number) {
  const c = color.trim();
  const hex = c.startsWith('#') ? c.slice(1) : '';
  if (hex.length === 6) {
    const n = parseInt(hex, 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  return c;
}

/** 把配置里的菜单外观铺到根节点上（与设置页预览同一套变量）。 */
async function applyAppearance() {
  let cfg: Config;
  try { cfg = await invoke<Config>('get_config'); } catch { return; }
  const a = cfg.context_menu_appearance;
  if (!a) return;
  const dark = a.theme === 'dark'
    || (a.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = a.density || cfg.ui_density || 'standard';
  root.style.background = 'transparent';
  const s = root.style;
  s.setProperty('--menu-radius', `${a.corner_radius ?? 14}px`);
  s.setProperty('--menu-font', `${a.ui_font_size ?? 13}px`);
  const [bg, fg, hv] = dark
    ? [a.dark_background, a.dark_foreground, a.dark_hover]
    : [a.light_background, a.light_foreground, a.light_hover];
  const op = (a.opacity ?? 0.94) > 1 ? (a.opacity ?? 94) / 100 : (a.opacity ?? 0.94);
  if (bg) s.setProperty('--menu-bg', withAlpha(bg, a.translucent ? op : 1));
  if (fg) s.setProperty('--menu-fg', fg);
  if (hv) s.setProperty('--menu-hover', hv);
  if (a.ui_font && a.ui_font !== 'system') {
    document.body.style.fontFamily = `"${a.ui_font}", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
  }
}

function buildPanel(nodes: MenuNode[], sub: boolean, childOf: number | null): Panel {
  const el = document.createElement('div');
  el.className = `modern-menu${sub ? ' submenu' : ''}`;
  let shown = 0;
  nodes.forEach((n, i) => {
    if (n.type === 'separator') {
      if (!shown) return;
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      el.append(sep);
      return;
    }
    shown++;
    const it = document.createElement('div');
    it.className = `menu-item${n.disabled ? ' disabled' : ''}`;
    it.dataset.i = String(i);
    if (n.reason) it.title = n.reason;
    const ic = document.createElement('span');
    ic.className = `menu-icon${n.icon ? '' : ' empty'}`;
    if (n.icon) ic.innerHTML = iconSvg(n.icon, 18);
    const lb = document.createElement('span');
    lb.className = 'menu-label';
    lb.textContent = n.label ?? '';
    it.append(ic, lb);
    if (n.value) {
      const v = document.createElement('span');
      v.className = 'menu-value';
      v.textContent = n.value;
      it.append(v);
    }
    if (n.checked) {
      const ck = document.createElement('span');
      ck.className = 'menu-check';
      ck.innerHTML = iconSvg('check', 9);
      it.append(ck);
    }
    if (n.type === 'submenu' && n.children?.length) {
      const ar = document.createElement('span');
      ar.className = 'menu-arrow';
      ar.innerHTML = iconSvg('back', 14);
      it.append(ar);
    }
    it.addEventListener('mouseenter', () => onHover(panels.indexOf(panel), i));
    it.addEventListener('click', (e) => { e.stopPropagation(); onPick(panels.indexOf(panel), i); });
    el.append(it);
  });
  while (el.lastElementChild?.classList.contains('menu-sep')) el.lastElementChild.remove();
  const panel: Panel = { el, nodes, x: 0, y: 0, childOf, sel: null };
  el.style.left = '0px';
  el.style.top = '0px';
  document.body.append(el);
  return panel;
}

/** 展开二级的那一项保持选中态。 */
function markActive() {
  for (const p of panels) {
    p.el.querySelectorAll('.menu-item.active').forEach((e) => e.classList.remove('active'));
  }
  for (let k = 1; k < panels.length; k++) {
    const idx = panels[k].childOf;
    if (idx === null) continue;
    panels[k - 1].el.querySelector(`.menu-item[data-i="${idx}"]`)?.classList.add('active');
  }
}

/** 关掉比 keep 更深的子菜单，返回是否真的收掉了面板。 */
function trim(keep: number): boolean {
  let changed = false;
  while (panels.length > keep + 1) {
    const p = panels.pop()!;
    p.el.remove();
    changed = true;
  }
  markActive();
  return changed;
}

function setSel(pi: number, ii: number | null) {
  const p = panels[pi];
  if (!p) return;
  p.el.querySelectorAll('.menu-item.hover').forEach((e) => e.classList.remove('hover'));
  p.sel = ii;
  if (ii !== null) p.el.querySelector(`.menu-item[data-i="${ii}"]`)?.classList.add('hover');
}

function onHover(pi: number, ii: number) {
  const p = panels[pi];
  const n = p?.nodes[ii];
  if (!p || !n || n.disabled || n.type === 'separator') return;
  setSel(pi, ii);
  if (n.type === 'submenu' && n.children?.length) openSub(pi, ii);
  else if (trim(pi)) layout();
}

function openSub(pi: number, ii: number) {
  const p = panels[pi];
  const kids = p?.nodes[ii]?.children;
  if (!p) return;
  if (!kids?.length) { if (trim(pi)) layout(); return; }
  // 已经是这一项的子菜单就别重建，否则每次 move 都闪一下
  if (panels[pi + 1]?.childOf === ii) return;
  trim(pi);
  panels.push(buildPanel(kids, true, ii));
  setSel(pi, ii);
  markActive();
  layout();
}

function onPick(pi: number, ii: number) {
  const n = panels[pi]?.nodes[ii];
  if (!n || n.disabled) return;
  if (n.type === 'submenu' && n.children?.length) { openSub(pi, ii); return; }
  const path: number[] = [];
  for (let k = 1; k <= pi; k++) path.push(panels[k].childOf!);
  path.push(ii);
  invoke('menu_pick', { path, id: n.id ?? null }).catch(() => {});
}

/** 按锚点摆好每一层面板，再把并集报给 Rust 定位窗口。 */
function layout() {
  if (!pending || !panels.length) return;
  const { work, tray, ax, ay } = pending;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const root = panels[0];
  root.el.style.maxHeight = `${work.bottom - work.top - 8}px`;
  root.el.style.overflowY = 'auto';
  const rw = root.el.offsetWidth;
  const rh = root.el.offsetHeight;
  root.x = clamp(tray ? ax - rw : ax, work.left, work.right - rw);
  root.y = clamp(tray ? ay - rh : ay, work.top, work.bottom - rh);
  for (let i = 1; i < panels.length; i++) {
    const p = panels[i];
    const parent = panels[i - 1];
    const item = parent.el.querySelector<HTMLElement>(`.menu-item[data-i="${p.childOf}"]`);
    const w = p.el.offsetWidth;
    const h = p.el.offsetHeight;
    let x = parent.x + parent.el.offsetWidth + GAP;
    if (x + w > work.right) x = parent.x - w - GAP; // 右边放不下就翻到左侧
    p.x = clamp(x, work.left, work.right - w);
    p.y = clamp(parent.y + (item?.offsetTop ?? 0) - SUB_LIFT, work.top, work.bottom - h);
  }
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of panels) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.el.offsetWidth); y1 = Math.max(y1, p.y + p.el.offsetHeight);
  }
  for (const p of panels) {
    p.el.style.left = `${p.x - x0}px`;
    p.el.style.top = `${p.y - y0}px`;
  }
  invoke('menu_layout', { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }).catch(() => {});
}

function render(p: Pending) {
  pending = p;
  for (const old of panels) old.el.remove();
  panels = [];
  if (!p.items?.length) { invoke('menu_cancel').catch(() => {}); return; }
  panels.push(buildPanel(p.items, false, null));
  layout();
  // 字体/图标就位后重算一次（本地 TTF 首帧可能还是回退字体，宽度会算窄）
  requestAnimationFrame(layout);
  document.fonts?.ready.then(() => layout());
}

async function pull() {
  let p: Pending | null = null;
  try { p = await invoke<Pending | null>('menu_pending'); } catch { return; }
  if (!p || p.seq === seq) return;
  seq = p.seq;
  render(p);
}

function keyboard(e: KeyboardEvent) {
  if (!panels.length) return;
  const pi = panels.length - 1;
  const p = panels[pi];
  const usable = p.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type !== 'separator' && !n.disabled)
    .map(({ i }) => i);
  const at = p.sel === null ? -1 : usable.indexOf(p.sel);
  const go = (delta: number) => {
    if (!usable.length) return;
    const next = at < 0 ? (delta > 0 ? 0 : usable.length - 1) : (at + delta + usable.length) % usable.length;
    setSel(pi, usable[next]);
  };
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); go(1); break;
    case 'ArrowUp': e.preventDefault(); go(-1); break;
    case 'ArrowRight':
      e.preventDefault();
      if (p.sel !== null && p.nodes[p.sel].type === 'submenu' && p.nodes[p.sel].children?.length) {
        openSub(pi, p.sel);
        // 进去就把选中落到子面板第一项，否则再按回车没反应
        const child = panels[pi + 1];
        const first = child?.nodes.findIndex((n) => n.type !== 'separator' && !n.disabled) ?? -1;
        if (first >= 0) setSel(pi + 1, first);
      }
      break;
    case 'ArrowLeft': {
      e.preventDefault();
      if (pi > 0) {
        const back = panels[pi].childOf;
        trim(pi - 1);
        if (back !== null) setSel(pi - 1, back);
        layout();
      }
      break;
    }
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (p.sel !== null) onPick(pi, p.sel);
      break;
    case 'Escape':
      e.preventDefault();
      if (pi > 0) {
        const back = panels[pi].childOf;
        trim(pi - 1);
        if (back !== null) setSel(pi - 1, back);
        layout();
      } else {
        invoke('menu_cancel').catch(() => {});
      }
      break;
    default:
      break;
  }
}

export async function start() {
  document.documentElement.style.background = 'transparent';
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    invoke('menu_cancel').catch(() => {}); // 菜单上再点右键 = 关掉（和 Win11 一致）
  });
  // 窗口是矩形，面板并集之外的透明区也算"外面"：点这里等于取消
  document.addEventListener('mousedown', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.closest?.('.modern-menu')) invoke('menu_cancel').catch(() => {});
  }, true);
  document.addEventListener('keydown', keyboard);
  window.addEventListener('blur', () => { if (panels.length) invoke('menu_cancel').catch(() => {}); });
  await applyAppearance();
  await listen('config://changed', () => { applyAppearance(); });
  await listen<number>('menu://show', () => { pull(); });
  pull();
}
