// 独立待办窗的面板：只做增删改 / 列表展示；到期提醒与归档交给 TodoScheduler。
// 每次写操作都重新读盘再改，避免和后台调度器标记 reminded 时互相覆盖。
import { api } from '../bridge';
import { iconSvg } from '../data/icons';
import type { Config, TodoItem } from '../types';
import { el } from './widgets';

export class TodoPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;

  constructor(host: HTMLElement, cfg: () => Config, onClose: () => void) {
    this.root = el('div', 'todo-panel');
    const head = el('div', 'todo-head');
    head.append(el('span', 'todo-title', '待办提醒'));
    const close = el('button', 'todo-close');
    close.innerHTML = iconSvg('remove', 15);
    close.addEventListener('click', onClose);
    head.append(close);
    const form = el('div', 'todo-form');
    const title = el('input', 'text-input'); title.placeholder = '要做什么？';
    const when = el('input', 'text-input'); when.type = 'datetime-local';
    const add = el('button', 'row-btn', '添加');
    add.addEventListener('click', () => {
      if (!title.value.trim()) return;
      const due = when.value ? new Date(when.value).getTime() : 0;
      void this.mutate((items) => {
        items.push({
          id: String(Date.now()), title: title.value.trim(), note: '', due,
          lead_minutes: cfg().todo_reminder_lead_minutes, done: false, reminded: false, created: Date.now(),
        });
      });
      title.value = ''; when.value = '';
    });
    form.append(title, when, add);
    this.list = el('div', 'todo-list');
    this.root.append(head, form, this.list);
    host.append(this.root);
    void this.reload();
    api.onData<TodoItem[]>('todo_items', (v) => { if (Array.isArray(v)) this.render(v); }).catch(() => {});
  }

  private async all(): Promise<TodoItem[]> {
    const v = await api.data<TodoItem[]>('todo_items').catch(() => []);
    return Array.isArray(v) ? v : [];
  }
  private async reload() { this.render(await this.all()); }
  private async mutate(fn: (items: TodoItem[]) => void) {
    const items = await this.all();
    fn(items);
    api.setData('todo_items', items).catch(() => {});
    this.render(items);
  }

  private render(items: TodoItem[]) {
    this.list.replaceChildren();
    const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done) || a.due - b.due);
    if (!sorted.length) { this.list.append(el('div', 'todo-empty', '还没有待办，添加一条吧～')); return; }
    for (const it of sorted) {
      const rowEl = el('div', 'todo-item');
      if (it.done) rowEl.classList.add('done');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = it.done;
      cb.addEventListener('change', () => void this.mutate((all) => {
        const hit = all.find((x) => x.id === it.id);
        if (hit) hit.done = cb.checked;
      }));
      const t = el('span', 'todo-text', it.title);
      const d = el('span', 'todo-due', it.due ? new Date(it.due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '无时间');
      const del = el('button', 'todo-del'); del.innerHTML = iconSvg('clear', 14);
      del.addEventListener('click', () => void this.mutate((all) => {
        const i = all.findIndex((x) => x.id === it.id);
        if (i >= 0) all.splice(i, 1);
      }));
      rowEl.append(cb, t, d, del);
      this.list.append(rowEl);
    }
  }
}
