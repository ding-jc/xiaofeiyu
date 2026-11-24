// 设置控件工厂：全部走全局 cfg 的 get/set，改动即时落盘。
// 复用组件：section/featureCard/notice 等，卡通风格 + 触摸友好热区。
import type { Config } from '../types';
import { iconSvg } from '../data/icons';

export interface Ctx {
  cfg: Config;
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): void;
  defaults: Config;
  changed: Set<string>;
  mark(key: string, on: boolean): void;
  toast(msg: string): void;
  searchable: { el: HTMLElement; text: string; section: string; page: string }[];
  page: string;
  section: string;
  action(fn: () => void): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 圆润图标节点 */
export function ico(name: string, size = 18, cls = 'ico') {
  const s = el('span', cls);
  s.innerHTML = iconSvg(name, size);
  return s;
}

function rowShell(c: Ctx, label: string, hint: string, key: string) {
  const row = el('div', 'setting-row');
  row.dataset.key = key;
  const main = el('div', 'setting-main');
  const head = el('div', 'setting-head');
  head.append(el('div', 'setting-label', label));
  main.append(head);
  if (hint) main.append(el('div', 'setting-hint', hint));
  row.append(main);
  c.searchable.push({ el: row, text: `${label} ${hint} ${key}`, section: c.section, page: c.page });
  return row;
}

/** 设置行：label/hint 在左，控件在右，带「已修改」圆点 */
export function row(c: Ctx, label: string, hint: string, control: HTMLElement, key: string) {
  const r = rowShell(c, label, hint, key);
  const slot = el('div', 'setting-control');
  slot.append(control);
  r.append(slot);
  const dot = el('span', 'setting-dot');
  dot.title = '已修改';
  if (c.changed.has(key)) dot.classList.add('on');
  r.append(dot);
  return r;
}

export function toggle(c: Ctx, key: string, label: string, hint = '') {
  const btn = el('button', 'switch');
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  const knob = el('span', 'switch-knob');
  btn.append(knob);
  const sync = () => {
    const v = Boolean(c.get(key));
    btn.classList.toggle('on', v);
    btn.setAttribute('aria-checked', String(v));
  };
  sync();
  btn.addEventListener('click', () => { c.set(key, !Boolean(c.get(key))); sync(); });
  const r = row(c, label, hint, btn, key);
  (r as HTMLElement & { _sync?: () => void })._sync = sync;
  return r;
}

export interface Opt { label: string; value: string | number; icon?: string }
export function select(c: Ctx, key: string, label: string, opts: Opt[], hint = '') {
  const wrap = el('div', 'select-wrap');
  const btn = el('button', 'select-btn');
  btn.type = 'button';
  const val = el('span', 'select-value');
  const caret = el('span', 'select-caret');
  caret.innerHTML = iconSvg('back', 15);
  btn.append(val, caret);
  const menu = el('div', 'select-menu');
  const sync = () => {
    const v = c.get(key);
    const o = opts.find((x) => x.value === v) ?? opts[0];
    val.textContent = o?.label ?? String(v ?? '');
    for (const ch of menu.children) ch.classList.toggle('active', (ch as HTMLElement).dataset.value === String(v));
  };
  opts.forEach((o) => {
    const it = el('button', 'select-item');
    it.type = 'button';
    it.dataset.value = String(o.value);
    if (o.icon) it.append(ico(o.icon, 16, 'select-item-ico'));
    it.append(el('span', '', o.label));
    it.append(ico('check', 15, 'select-tick'));
    it.addEventListener('click', (e) => {
      e.stopPropagation();
      c.set(key, o.value); sync(); menu.classList.remove('open'); c.action(() => {});
    });
    menu.append(it);
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.select-menu.open').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
    menu.classList.toggle('open');
  });
  wrap.append(btn, menu);
  sync();
  const r = row(c, label, hint, wrap, key);
  (r as HTMLElement & { _sync?: () => void })._sync = sync;
  return r;
}

export function slider(
  c: Ctx, key: string, label: string, min: number, max: number, step: number, hint = '', unit = '',
) {
  const wrap = el('div', 'slider-wrap');
  const input = el('input', 'slider');
  input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
  const out = el('span', 'slider-value');
  const sync = () => {
    const v = Number(c.get(key));
    input.value = String(v);
    out.textContent = `${Number.isInteger(step) ? Math.round(v) : Number(v.toFixed(2))}${unit}`;
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    c.set(key, v);
    out.textContent = `${v}${unit}`;
  });
  wrap.append(input, out);
  sync();
  const r = row(c, label, hint, wrap, key);
  (r as HTMLElement & { _sync?: () => void })._sync = sync;
  return r;
}

export function text(c: Ctx, key: string, label: string, hint = '', placeholder = '') {
  const input = el('input', 'text-input');
  input.type = 'text'; input.placeholder = placeholder;
  input.value = String(c.get(key) ?? '');
  input.addEventListener('change', () => c.set(key, input.value));
  const r = row(c, label, hint, input, key);
  (r as HTMLElement & { _sync?: () => void })._sync = () => { input.value = String(c.get(key) ?? ''); };
  return r;
}

export function textarea(c: Ctx, key: string, label: string, hint = '', placeholder = '') {
  const ta = el('textarea', 'text-area');
  ta.placeholder = placeholder;
  ta.rows = 4;
  const v = c.get<string[] | string>(key);
  ta.value = Array.isArray(v) ? v.join('\n') : String(v ?? '');
  ta.addEventListener('change', () => {
    const d = c.defaults[key];
    c.set(key, Array.isArray(d) ? ta.value.split('\n').map((s) => s.trim()).filter(Boolean) : ta.value);
  });
  const r = row(c, label, hint, ta, key);
  (r as HTMLElement & { _sync?: () => void })._sync = () => {
    const x = c.get<string[] | string>(key);
    ta.value = Array.isArray(x) ? x.join('\n') : String(x ?? '');
  };
  return r;
}

export function color(c: Ctx, key: string, label: string, hint = '') {
  const wrap = el('div', 'color-wrap');
  const sw = el('button', 'color-swatch');
  sw.type = 'button';
  const input = el('input', 'color-input');
  input.type = 'color';
  const sync = () => {
    const v = String(c.get(key) ?? '#ffffff');
    sw.style.background = v;
    input.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
  };
  sw.addEventListener('click', () => input.click());
  input.addEventListener('input', () => { c.set(key, input.value); sw.style.background = input.value; });
  wrap.append(sw, input);
  sync();
  const r = row(c, label, hint, wrap, key);
  (r as HTMLElement & { _sync?: () => void })._sync = sync;
  return r;
}

export function button(c: Ctx, label: string, hint: string, btnLabel: string, onClick: () => void, icon = '') {
  const b = el('button', 'row-btn');
  b.type = 'button';
  if (icon) b.append(ico(icon, 16, 'btn-ico'));
  b.append(el('span', '', btnLabel));
  b.addEventListener('click', onClick);
  return row(c, label, hint, b, `action.${label}`);
}

/** 分组卡片：可选圆润图标标题 */
export function section(c: Ctx, title: string, desc = '', nodes: HTMLElement[] = [], icon = '') {
  const s = el('section', 'settings-section');
  const h = el('div', 'section-head');
  if (icon) h.append(ico(icon, 17, 'section-ico'));
  h.append(el('h3', 'section-title', title));
  s.append(h);
  if (desc) s.append(el('p', 'section-desc', desc));
  const card = el('div', 'settings-card');
  nodes.forEach((n, i) => {
    if (i) card.append(el('div', 'card-sep'));
    card.append(n);
  });
  s.append(card);
  return s;
}

/** 手风琴内容容器：多个表单合并为同一列 */
function accordionBody(nodes: HTMLElement[]) {
  const body = el('div', 'advanced-body');
  const inner = el('div', 'adv-inner');
  nodes.forEach((n) => inner.append(n));
  body.append(inner);
  return { body, inner };
}

/** 手风琴内核：trigger 整条可点，状态类挂在 stateEl，展开后解除限高避免裁掉下拉 */
function bindAccordion(trigger: HTMLElement, stateEl: HTMLElement, inner: HTMLElement) {
  trigger.setAttribute('aria-expanded', 'false');
  inner.addEventListener('transitionend', (e) => {
    if (e.target !== inner || (e as TransitionEvent).propertyName !== 'max-height') return;
    if (stateEl.classList.contains('open')) {
      inner.style.maxHeight = 'none';
      inner.style.overflow = 'visible';
    } else inner.style.overflow = 'hidden';
  });
  const setOpen = (open: boolean) => {
    stateEl.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', String(open));
    inner.style.overflow = 'hidden';
    inner.style.maxHeight = `${inner.scrollHeight}px`;
    if (!open) requestAnimationFrame(() => {
      if (!stateEl.classList.contains('open')) inner.style.maxHeight = '0px';
    });
  };
  trigger.addEventListener('click', () => setOpen(!stateEl.classList.contains('open')));
  return setOpen;
}

/** 独立手风琴条目：标题行与普通表单行同构，状态箭头与其它控件右对齐 */
export function advanced(c: Ctx, title: string, nodes: HTMLElement[], icon = 'settings') {
  const wrap = el('div', 'advanced');
  const btn = el('button', 'advanced-toggle');
  btn.type = 'button';
  const main = el('div', 'setting-main');
  const head = el('div', 'setting-head');
  head.append(ico(icon, 16, 'adv-ico'), el('span', 'setting-label', title));
  main.append(head);
  const control = el('div', 'setting-control');
  const caret = el('span', 'adv-caret');
  caret.innerHTML = iconSvg('back', 17);
  control.append(caret);
  btn.append(main, control);
  const { body, inner } = accordionBody(nodes);
  bindAccordion(btn, wrap, inner);
  wrap.append(btn, body);
  return wrap;
}

export function notice(title: string, body: string, icon = 'info') {
  const n = el('div', 'notice');
  const h = el('div', 'notice-title');
  h.append(ico(icon, 15, 'notice-ico'), el('span', '', title));
  n.append(h, el('div', 'notice-body', body));
  return n;
}

/** 功能卡：条目自身即手风琴触发，展开图标与开关并排置于最右 */
export function featureCard(opts: {
  name: string; desc: string; icon: string; on: boolean;
  onToggle: (on: boolean) => void; config?: HTMLElement[];
}) {
  const card = el('div', 'feature-card');
  card.classList.toggle('off', !opts.on);
  const trigger = el('div', 'feature-trigger');
  const head = el('div', 'feature-head');
  const name = el('span', 'feature-name');
  name.append(ico(opts.icon, 19, 'feature-ico'), el('span', '', opts.name));
  const controls = el('div', 'feature-controls');
  const btn = el('button', 'switch');
  btn.type = 'button';
  btn.append(el('span', 'switch-knob'));
  const sync = () => {
    btn.classList.toggle('on', !card.classList.contains('off'));
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', String(!card.classList.contains('off')));
  };
  sync();
  // 开关只切换启用态，不触发展开
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = card.classList.contains('off');
    card.classList.toggle('off', !on);
    sync();
    opts.onToggle(on);
  });
  controls.append(btn);
  head.append(name);
  trigger.append(head, el('div', 'feature-desc', opts.desc), controls);
  card.append(trigger);

  if (opts.config?.length) {
    const caret = el('span', 'adv-caret');
    caret.innerHTML = iconSvg('back', 17);
    controls.prepend(caret);
    trigger.classList.add('clickable');
    trigger.tabIndex = 0;
    trigger.setAttribute('role', 'button');
    const { body, inner } = accordionBody(opts.config);
    const setOpen = bindAccordion(trigger, card, inner);
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!card.classList.contains('open')); }
    });
    card.append(body);
  }
  return card;
}

