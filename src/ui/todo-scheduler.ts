// 待办到期调度：无 DOM，跑在常驻的壁纸层世界；独立待办窗开关都不影响提醒。
import { api } from '../bridge';
import type { Config, TodoItem } from '../types';

export class TodoScheduler {
  private timer = 0;
  constructor(private cfg: () => Config, private onRemind: (text: string) => void) {}

  start() {
    this.timer = window.setInterval(() => void this.tick(), 15000);
    void this.tick();
  }

  private quiet(c: Config) { return c.quiet_until > Date.now(); }

  private async tick() {
    const c = this.cfg();
    if (!c.todo_reminder_enabled) return;
    const items = await api.data<TodoItem[]>('todo_items').catch(() => []);
    if (!Array.isArray(items)) return;
    const now = Date.now();
    let changed = false;
    for (const it of items) {
      if (it.done || !it.due || it.reminded) continue;
      const lead = (it.lead_minutes ?? c.todo_reminder_lead_minutes) * 60000;
      if (now + lead >= it.due) {
        it.reminded = true; changed = true;
        const text = `待办到点啦：${it.title}`;
        this.onRemind(text);
        if (!this.quiet(c) && c.system_notifications_enabled) api.notify('桌宠提醒', text).catch(() => {});
      }
      // 一次性待办过期 10 分钟宽限后自动归档
      if (!it.done && now > it.due + 600000) { it.done = true; changed = true; }
    }
    if (changed) api.setData('todo_items', items).catch(() => {});
  }

  destroy() { window.clearInterval(this.timer); }
}
