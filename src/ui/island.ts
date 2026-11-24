// 灵动岛：壁纸层内的桌面胶囊；时间 / 网速 / CPU / 内存 / 占位段；可拖动、可收成细条。
import { api } from '../bridge';
import type { Config, Metrics } from '../types';
import { el } from './widgets';

export class Island {
  readonly root: HTMLElement;
  private segments: HTMLElement;
  private metrics: Metrics = { cpu: 0, mem: 0, mem_used_mb: 0, mem_total_mb: 0, down_kb: 0, up_kb: 0 };
  private clock = 0;
  private dragging = false;
  private dx = 0;
  private dy = 0;

  constructor(host: HTMLElement, private cfg: () => Config, private save: (p: Partial<Config>) => void) {
    this.root = el('div', 'island');
    this.segments = el('div', 'island-segments');
    this.root.append(this.segments);
    host.append(this.root);
    api.onMetrics((m) => { this.metrics = m; this.render(); }).catch(() => {});
    this.clock = window.setInterval(() => this.render(), 1000);
    this.bindDrag();
    this.sync();
  }

  sync() {
    const c = this.cfg();
    const on = c.island_enabled && c.feature_activation?.dynamic_island !== false;
    this.root.style.display = on ? 'flex' : 'none';
    if (!on) { api.metrics(false).catch(() => {}); return; }
    this.root.classList.toggle('collapsed', Boolean(c.island_collapsed));
    this.root.className = `island ${c.island_collapsed ? 'collapsed' : ''} ${c.island_edge === 'bottom' ? 'bottom' : 'top'}`;
    this.root.style.opacity = String(c.island_opacity ?? 0.9);
    const x = c.island_x >= 0 ? c.island_x : (innerWidth - 320) / 2;
    this.root.style.left = `${x}px`;
    this.root.style.top = c.island_edge === 'bottom' ? `${innerHeight - (c.island_y ?? 18) - 44}px` : `${c.island_y ?? 18}px`;
    const sample = !c.island_collapsed && (c.island_show_cpu || c.island_show_mem || c.island_show_network);
    api.metrics(Boolean(sample)).catch(() => {});
    this.render();
  }

  private render() {
    const c = this.cfg();
    if (!c.island_enabled) return;
    this.segments.replaceChildren();
    if (c.island_collapsed) { this.segments.append(el('div', 'island-pill')); return; }
    const seg = (label: string, value: string, warn = false) => {
      const s = el('div', `island-seg${warn ? ' warn' : ''}`);
      s.append(el('span', 'seg-label', label), el('span', 'seg-value', value));
      this.segments.append(s);
      return s;
    };
    if (c.island_show_name) seg('', '深海桌宠');
    if (c.island_show_clock) {
      const d = new Date();
      seg('', d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    }
    if (c.island_info_mode === 'custom' && c.island_custom_text) seg('', c.island_custom_text);
    if (c.island_info_mode === 'status') seg('', '壁纸层运行中');
    if (c.island_show_cpu) seg('CPU', `${this.metrics.cpu.toFixed(0)}%`, this.metrics.cpu > 85);
    if (c.island_show_mem) seg('MEM', `${this.metrics.mem.toFixed(0)}%`, this.metrics.mem > 90);
    if (c.island_show_network) {
      seg('NET', `↓${fmt(this.metrics.down_kb)} ↑${fmt(this.metrics.up_kb)}`);
    }
    // 本版本不采集 GPU / 游戏 FPS，按原项目「系统不支持时这一段不占位，展开卡片说明原因」的口径显示占位
    if (c.island_show_gpu) seg('GPU', '--');
    if (c.island_show_fps) seg('FPS', '--');
  }

  private bindDrag() {
    this.root.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      const r = this.root.getBoundingClientRect();
      this.dx = e.clientX - r.left; this.dy = e.clientY - r.top;
      this.root.setPointerCapture(e.pointerId);
    });
    this.root.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const x = Math.max(4, Math.min(innerWidth - this.root.offsetWidth - 4, e.clientX - this.dx));
      const y = Math.max(4, Math.min(innerHeight - 48, e.clientY - this.dy));
      this.root.style.left = `${x}px`;
      this.root.style.top = `${y}px`;
    });
    this.root.addEventListener('pointerup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      const c = this.cfg();
      this.save({
        island_x: parseFloat(this.root.style.left) || 0,
        island_y: c.island_edge === 'bottom'
          ? Math.max(4, innerHeight - parseFloat(this.root.style.top) - 44)
          : parseFloat(this.root.style.top) || 18,
      });
    });
    this.root.addEventListener('dblclick', () => {
      const c = this.cfg();
      this.save({ island_collapsed: !c.island_collapsed });
    });
  }

  destroy() { window.clearInterval(this.clock); }
}

function fmt(kb: number) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB/s` : `${kb.toFixed(0)}KB/s`;
}
