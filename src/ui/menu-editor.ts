// 菜单编排器：左侧编辑树（显隐/移动到子菜单/根/新建子菜单/分割线/别名/图标覆盖），右侧实时预览。
import { ACTIONS, DEFAULT_MENU } from '../data/defaults';
import { iconSvg, ICON_NAMES } from '../data/icons';
import type { MenuNode } from '../types';
import { el } from './widgets';

const clone = (n: MenuNode[]) => JSON.parse(JSON.stringify(n)) as MenuNode[];
const uid = () => `custom.${Math.random().toString(36).slice(2, 9)}`;

function findParent(list: MenuNode[], id: string, parent: MenuNode[] | null = null): MenuNode[] | null {
  for (const n of list) {
    if (n.id === id) return parent;
    if (n.children) {
      const r = findParent(n.children, id, n.children);
      if (r) return r;
    }
  }
  return null;
}
function findNode(list: MenuNode[], id: string): MenuNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.children) { const r = findNode(n.children, id); if (r) return r; }
  }
  return null;
}
function removeNode(list: MenuNode[], id: string): MenuNode | null {
  const i = list.findIndex((n) => n.id === id);
  if (i >= 0) return list.splice(i, 1)[0];
  for (const n of list) if (n.children) { const r = removeNode(n.children, id); if (r) return r; }
  return null;
}

export interface EditorHost {
  nodes: MenuNode[];
  onChange(nodes: MenuNode[]): void;
  appearance: { theme: string; density: string; corner_radius: number; opacity: number; ui_font_size: number };
  toast(msg: string): void;
}

export class MenuEditor {
  readonly root: HTMLElement;
  private tree: HTMLElement;
  private preview: HTMLElement;
  private inspector: HTMLElement;
  private selected = '';

  constructor(private host: EditorHost) {
    this.root = el('div', 'menu-editor');
    const editPanel = el('div', 'menu-editor-panel');
    editPanel.append(el('div', 'editor-label', '编排'));
    const bar = el('div', 'editor-toolbar');
    bar.append(
      this.tool('add', '新建子菜单', () => this.addSubmenu()),
      this.tool('add', '插入分割线', () => this.addSeparator()),
      this.tool('remove', '删除', () => this.removeSelected()),
      this.tool('back', '移到根', () => this.moveToRoot()),
      this.tool('retry', '恢复默认', () => this.reset()),
    );
    editPanel.append(bar, this.inspector = el('div', 'editor-inspector'));
    this.tree = el('div', 'editor-tree');
    editPanel.append(this.tree);

    const prevPanel = el('div', 'menu-editor-panel');
    prevPanel.append(el('div', 'editor-label', '实时预览'));
    this.preview = el('div', 'editor-preview');
    prevPanel.append(this.preview);

    this.root.append(editPanel, prevPanel);
    this.render();
  }

  private tool(icon: string, title: string, fn: () => void) {
    const b = el('button', 'tool-btn');
    b.type = 'button'; b.title = title;
    b.innerHTML = iconSvg(icon, 16);
    b.addEventListener('click', fn);
    return b;
  }

  private render() {
    this.tree.replaceChildren();
    const walk = (nodes: MenuNode[], depth: number) => {
      for (const n of nodes) {
        const spec = ACTIONS[n.id];
        const line = el('div', 'tree-line');
        line.style.paddingLeft = `${8 + depth * 18}px`;
        line.classList.toggle('sel', n.id === this.selected);
        if (n.hidden || spec?.capability === 'removed') line.classList.add('dim');
        const vis = el('input', 'tree-check');
        vis.type = 'checkbox'; vis.checked = !n.hidden;
        vis.title = '显示';
        vis.addEventListener('change', () => { n.hidden = !vis.checked; this.commit(); });
        const ic = el('span', 'tree-icon');
        ic.innerHTML = iconSvg(spec?.icon ?? 'pet', 15);
        const name = el('span', 'tree-name', n.type === 'separator' ? '──── 分割线 ────' : (spec?.label ?? n.id));
        line.append(vis, ic, name);
        if (n.type === 'submenu') line.append(el('span', 'tree-tag', '子菜单'));
        if (spec?.capability === 'removed') { const t = el('span', 'tree-tag warn', '能力不可用'); t.title = spec.reason ?? ''; line.append(t); }
        line.addEventListener('click', (e) => {
          if (e.target === vis) return;
          this.selected = n.id; this.render();
        });
        this.tree.append(line);
        if (n.children) walk(n.children, depth + 1);
      }
    };
    walk(this.host.nodes, 0);
    this.renderInspector();
    this.renderPreview();
  }

  private renderInspector() {
    this.inspector.replaceChildren();
    const n = this.selected ? findNode(this.host.nodes, this.selected) : null;
    if (!n) { this.inspector.append(el('div', 'inspector-empty', '选中左侧节点可编辑别名与图标')); return; }
    const spec = ACTIONS[n.id];
    if (spec?.capability === 'removed') {
      this.inspector.append(el('div', 'inspector-reason', `${spec.label}：${spec.reason}`));
      return;
    }
    const alias = el('div', 'inspector-field');
    alias.append(el('label', '', '别名（运行时显示）'));
    const ai = el('input', 'text-input'); ai.type = 'text';
    ai.placeholder = spec?.label ?? n.id; ai.value = n.label ?? '';
    ai.addEventListener('change', () => { n.label = ai.value; this.commit(); });
    alias.append(ai);
    const icons = el('div', 'inspector-field');
    icons.append(el('label', '', '图标覆盖'));
    const sel = el('select', 'native-select');
    for (const v of ['', 'none', ...ICON_NAMES]) {
      const o = el('option'); o.value = v;
      o.textContent = v === '' ? '默认' : v === 'none' ? '不显示图标' : v;
      if ((n.icon ?? '') === v) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => { n.icon = sel.value || undefined; this.commit(); });
    icons.append(sel);
    const down = el('div', 'inspector-field');
    down.append(el('label', '', '调整位置'));
    const btns = el('div', 'inspector-btns');
    const mk = (label: string, fn: () => void) => { const b = el('button', 'row-btn', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    btns.append(
      mk('上移', () => this.move(-1)), mk('下移', () => this.move(1)),
      mk('移到根', () => this.moveToRoot()),
    );
    down.append(btns);
    this.inspector.append(alias, icons, down);
  }

  private renderPreview() {
    this.preview.replaceChildren();
    const a = this.host.appearance;
    const dark = a.theme === 'dark' || (a.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const m = el('div', 'modern-menu preview-menu');
    m.dataset.theme = dark ? 'dark' : 'light';
    m.dataset.density = a.density;
    m.style.setProperty('--menu-radius', `${a.corner_radius}px`);
    m.style.setProperty('--menu-opacity', String(a.opacity));
    m.style.setProperty('--menu-font', `${a.ui_font_size}px`);
    const walk = (nodes: MenuNode[]) => {
      let visible = 0;
      for (const n of nodes) {
        const spec = ACTIONS[n.id];
        if (n.hidden || spec?.capability === 'removed') continue;
        if (n.type === 'separator') { if (visible) m.append(el('div', 'menu-sep')); continue; }
        const it = el('div', 'menu-item');
        const ic = el('span', 'menu-icon');
        const icon = n.icon === undefined ? spec?.icon : n.icon;
        if (icon && icon !== 'none') ic.innerHTML = iconSvg(icon, 18);
        it.append(ic, el('span', 'menu-label', n.label || spec?.label || n.id));
        if (n.type === 'submenu') { const arw = el('span', 'menu-arrow'); arw.innerHTML = iconSvg('back', 14); it.append(arw); }
        m.append(it);
        visible++;
      }
      while (m.lastChild && (m.lastChild as HTMLElement).classList?.contains('menu-sep')) m.lastChild.remove();
    };
    walk(this.host.nodes);
    this.preview.append(m);
  }

  private move(delta: number) {
    const list = findParent(this.host.nodes, this.selected, this.host.nodes);
    if (!list) return;
    const i = list.findIndex((n) => n.id === this.selected);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.commit();
  }

  private moveToRoot() {
    const n = removeNode(this.host.nodes, this.selected);
    if (n) { this.host.nodes.push(n); this.commit(); }
  }

  private addSubmenu() {
    const node: MenuNode = { type: 'submenu', id: uid(), label: '新建子菜单', children: [] };
    const list = findParent(this.host.nodes, this.selected, this.host.nodes) ?? this.host.nodes;
    const i = list.findIndex((n) => n.id === this.selected);
    if (i >= 0) list.splice(i + 1, 0, node); else list.push(node);
    this.selected = node.id;
    this.commit();
  }

  private addSeparator() {
    const node: MenuNode = { type: 'separator', id: uid() };
    const list = findParent(this.host.nodes, this.selected, this.host.nodes) ?? this.host.nodes;
    const i = list.findIndex((n) => n.id === this.selected);
    if (i >= 0) list.splice(i + 1, 0, node); else list.push(node);
    this.commit();
  }

  private removeSelected() {
    if (!this.selected) return;
    const removed = removeNode(this.host.nodes, this.selected);
    if (removed?.children?.length) this.host.nodes.push(...removed.children);
    this.selected = '';
    this.commit();
  }

  private reset() {
    this.host.nodes = clone(DEFAULT_MENU);
    this.selected = '';
    this.commit();
    this.host.toast('菜单布局已恢复默认');
  }

  private commit() {
    this.host.onChange(clone(this.host.nodes));
    this.render();
  }
}
