// 设置主界面：侧栏能力域 + 卡片式分组 + 页内标签 + Ctrl+F 跳转式搜索。
// 全部为全局偏好，任何改动即时落盘生效，无需保存并退出。
import { api } from '../bridge';
import { petUrl } from '../asset-url';
import { loadConfig } from '../boot';
import { defaultConfig, mergeConfig } from '../data/defaults';
import { iconSvg } from '../data/icons';
import type { Config } from '../types';
import {
  advanced, button, color, el, featureCard, ico, notice, row, section, select,
  slider, text, textarea, toggle, type Ctx,
} from './widgets';

/** 制作配方：直接跳开源仓库里的文档，应用内不再内置渲染。 */
const RECIPE_URL = 'https://github.com/ding-jc/pixup-pet/blob/main/docs/RECIPE.md';

const DOMAINS: { label: string; icon: string }[] = [
  { label: '常规', icon: 'settings' },
  { label: '桌宠', icon: 'paw' },
  { label: '互动', icon: 'heart' },
  { label: '菜单', icon: 'appearance' },
  { label: '功能', icon: 'sparkles' },
  { label: '自动化与联动', icon: 'zap' },
  { label: '更新', icon: 'download' },
];

export class SettingsApp {
  private cfg: Config;
  private defaults = defaultConfig();
  private changed = new Set<string>();
  private searchable: Ctx['searchable'] = [];
  private pages = new Map<string, HTMLElement>();
  private tabs = new Map<string, { bar: HTMLElement; bodies: HTMLElement[]; labels: string[] }>();
  private sidebar!: HTMLElement;
  private body!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchStatus!: HTMLElement;
  private matches: Ctx['searchable'] = [];
  private matchIndex = -1;
  private saveTimer = 0;
  private localEditAt = 0;
  private autostartOn = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async start(host?: HTMLElement) {
    const root = host ?? document.getElementById('app')!;
    root.classList.add('settings-app');
    const shell = el('div', 'settings-shell');

    const side = el('aside', 'settings-sidebar');
    this.searchInput = el('input', 'settings-search') as HTMLInputElement;
    this.searchInput.type = 'search';
    this.searchInput.placeholder = '搜索设置  Ctrl+F';
    this.searchInput.addEventListener('input', () => this.search(false));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.jump(this.matchIndex + 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.jump(this.matchIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.jump(this.matchIndex - 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.searchInput.value = ''; this.search(false); }
    });
    side.append(this.searchInput);
    this.searchStatus = el('div', 'search-status', '');
    side.append(this.searchStatus);

    this.sidebar = el('nav', 'settings-nav');
    DOMAINS.forEach((d, i) => {
      const it = el('button', 'nav-item');
      it.type = 'button';
      it.dataset.page = d.label;
      it.innerHTML = `<span class="nav-icon">${iconSvg(d.icon, 17)}</span><span>${d.label}</span>`;
      if (i === 0) it.classList.add('active');
      it.addEventListener('click', () => this.showPage(d.label));
      this.sidebar.append(it);
    });
    const recipe = el('button', 'nav-item nav-item--link');
    recipe.type = 'button';
    recipe.title = '在 GitHub 打开完整制作配方';
    recipe.innerHTML = `<span class="nav-icon">${iconSvg('external_link', 17)}</span><span>制作配方</span>`;
    recipe.dataset.page = '__recipe';
    recipe.addEventListener('click', () => { api.openUrl(RECIPE_URL).catch(() => {}); });
    this.sidebar.append(recipe);
    side.append(this.sidebar);

    const resetWrap = el('div', 'reset-wrap');
    const reset = el('button', 'reset-btn', '恢复默认设置…');
    reset.addEventListener('click', () => this.resetAll());
    resetWrap.append(reset);
    side.append(resetWrap);
    side.append(el('div', 'settings-version', '版本 v1.0.0 · 桌宠版'));

    this.body = el('main', 'settings-body');
    shell.append(side, this.body);
    root.append(shell, el('div', 'toast-host'));

    this.buildPages();
    this.showPage('常规');
    this.bind();
    api.autostart.isEnabled().then((v) => { this.autostartOn = v; }).catch(() => {});
    api.onConfig((c) => {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (Date.now() - this.localEditAt < 900) return;
      this.cfg = mergeConfig(c);
      this.syncAll();
      this.applyTheme();
    }).catch(() => {});
    api.onCommand(async (e) => {
      if (e.cmd !== 'toggle-autostart') return;
      if (this.autostartOn) await api.autostart.disable(); else await api.autostart.enable();
      this.autostartOn = !this.autostartOn;
      this.set('autostart', this.autostartOn);
      this.toast(this.autostartOn ? '已开启开机自启' : '已关闭开机自启');
    }).catch(() => {});
  }

  private ctxFor(page: string, sectionName: string): Ctx {
    return {
      cfg: this.cfg,
      get: <T = unknown>(k: string) => (this.cfg as unknown as Record<string, unknown>)[k] as T,
      set: (k, v) => this.set(k, v),
      defaults: this.defaults,
      changed: this.changed,
      mark: (k, on) => { if (on) this.changed.add(k); else this.changed.delete(k); },
      toast: (m) => this.toast(m),
      searchable: this.searchable,
      page, section: sectionName,
      action: () => this.markLocal(),
    };
  }

  private C(page: string, sec: string): Ctx { return this.ctxFor(page, sec); }

  private buildPages() {
    for (const d of DOMAINS) {
      const p = el('div', 'settings-page');
      p.dataset.page = d.label;
      const head = el('div', 'page-head');
      p.append(head);
      const content = el('div', 'page-content');
      p.append(content);
      this.pages.set(d.label, p);
      this.body.append(p);
      this.buildDomain(d.label, head, content);
    }
  }

  private tabBar(page: string, labels: string[]): { bar: HTMLElement; host: HTMLElement; bodies: HTMLElement[] } {
    const bar = el('div', 'task-tabs');
    const host = el('div', 'tab-bodies');
    const bodies: HTMLElement[] = [];
    labels.forEach((label, i) => {
      const b = el('button', 'task-tab', label);
      b.type = 'button';
      if (i === 0) b.classList.add('active');
      b.addEventListener('click', () => {
        bar.querySelectorAll('.task-tab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        bodies.forEach((x, j) => { x.style.display = j === i ? 'block' : 'none'; });
      });
      bar.append(b);
      const bd = el('div', 'tab-body');
      bd.style.display = i === 0 ? 'block' : 'none';
      bodies.push(bd);
      host.append(bd);
    });
    this.tabs.set(page, { bar, bodies, labels });
    return { bar, host, bodies };
  }

  private buildDomain(page: string, head: HTMLElement, content: HTMLElement) {
    switch (page) {
      case '常规': return this.pageGeneral(page, head, content);
      case '桌宠': return this.pagePet(page, head, content);
      case '互动': return this.pageInteraction(page, head, content);
      case '菜单': return this.pageMenu(page, content);
      case '功能': return this.pageFeatures(page, content);
      case '自动化与联动': return this.pageAutomation(page, content);
      case '更新': return this.pageUpdate(page, content);
    }
  }

  private pageGeneral(page: string, head: HTMLElement, content: HTMLElement) {
    const c = this.C(page, '外观');
    content.append(section(c, '外观', '跟随系统 / 浅色 / 深色；菜单与设置窗共用同一套主题。', [
      select(c, 'ui_theme', '界面主题', [
        { label: '跟随系统', value: 'system', icon: 'appearance' }, { label: '浅色', value: 'light', icon: 'cloud' }, { label: '深色', value: 'dark', icon: 'moon' },
      ], '所有窗口共用'),
      select(c, 'ui_density', '界面密度', [
        { label: '紧凑', value: 'compact' }, { label: '标准', value: 'standard' }, { label: '宽松', value: 'spacious' },
      ]),
      slider(c, 'corner_radius', '圆角', 6, 28, 1, '菜单与卡片圆角', ' px'),
      text(c, 'ui_font', '界面字体', '留空或 system 使用系统 UI 字体', 'system'),
      slider(c, 'ui_font_size', '界面字号', 10, 18, 1, '', ' px'),
    ], 'appearance'));
    const c2 = this.C(page, '启动');
    content.append(section(c2, '启动', '系统登录项只有一份；直接启动应用会打开主界面。', [
      toggle(c2, 'autostart', '开机自启', '开机静默运行，不弹主界面'),
    ], 'zap'));
    const c3 = this.C(page, '数据与恢复');
    content.append(section(c3, '数据与恢复', '所有改动即时生效并自动保存，无需手动保存。', [
      button(c3, '数据目录', '配置与素材包都在这里', '打开文件夹', () => api.showDataDir().catch(() => {}), 'file'),
      button(c3, '恢复默认设置', '把全部偏好一次性复位', '恢复默认…', () => this.resetAll(), 'retry'),
    ], 'save'));
    head.append(el('p', 'page-desc', '界面外观、桌宠行为与数据目录。'));
  }

  private pagePet(page: string, head: HTMLElement, content: HTMLElement) {
    const t = this.tabBar(page, ['显示', '动作与碰撞']);
    head.append(t.bar);
    content.append(t.host);
    const [display, actions] = t.bodies;

    // 桌宠只在置顶浮层显示，显示相关设置收拢为一处。
    const co = this.C(page, '显示设置');
    display.append(section(co, '显示设置', '置顶浮层上的桌宠行为。', [
      slider(co, 'overlay_opacity', '不透明度', 10, 100, 1, '', '%'),
      toggle(co, 'overlay_lock_position', '锁定位置', '开启后桌宠不可拖动，点击互动仍有效'),
      toggle(co, 'overlay_shift_drag', 'SHIFT + 左键拖动', '必须按住 SHIFT 才能拖动'),
      toggle(co, 'overlay_mouse_through', '鼠标穿透', '桌宠完全不接收鼠标，点击直接落到下面的窗口'),
      toggle(co, 'on_top', '始终置顶', '关闭后桌宠不再压在其它窗口上面'),
      toggle(co, 'allow_cross_screen', '允许桌宠跨屏', '桌宠覆盖整块虚拟桌面'),
      toggle(co, 'auto_hide_fullscreen', '全屏时自动隐藏', '前台程序全屏时暂停动画解码'),
    ], 'pin'));
    const c1b = this.C(page, '动画播放');
    display.append(section(c1b, '动画播放', 'WebM 透明素材，默认 640×360 / 24fps。', [
      select(c1b, 'playback_speed', '播放速率', [
        { label: '0.5x', value: 0.5 }, { label: '0.75x', value: 0.75 }, { label: '1.0x', value: 1 },
        { label: '1.25x', value: 1.25 }, { label: '1.5x', value: 1.5 }, { label: '2.0x', value: 2 },
        { label: '3.0x', value: 3 }, { label: '4.0x', value: 4 },
      ]),
      slider(c1b, 'animation_gap_seconds', '动作等待间隔', 0, 20, 0.5, '相邻非待机动画之间的空闲秒数', ' 秒'),
      advanced(c1b, '省电与菜单', [
        toggle(c1b, 'idle_low_fps_enabled', '省电模式', '闲置时停止后台预热并降低驱动频率'),
        slider(c1b, 'idle_low_fps_threshold', '进入省电的闲置时长', 5, 180, 5, '', ' 秒'),
        toggle(c1b, 'anim_menu_stay_open', '播放动画后菜单保持打开', '默认播完即收起整条菜单链'),
      ], 'zap'),
    ], 'play'));

    const c2 = this.C(page, '拖动与抛掷');
    actions.append(section(c2, '拖动与抛掷', '改动对所有桌宠生效。', [
      toggle(c2, 'drag_physics', '拖动物理', '放手后带惯性与重力'),
      toggle(c2, 'drop_gravity', '静止放手下落', '不拖动时也会落到地面'),
      slider(c2, 'throw_strength', '抛掷力度', 0.2, 3, 0.1, '', ' ×'),
      toggle(c2, 'slingshot_enabled', '弹弓', '按住蓄力、松手弹飞'),
      toggle(c2, 'no_move', '不移动', '禁止自主走动'),
    ], 'interaction'));
    const c2b = this.C(page, '碰撞与彩蛋');
    actions.append(section(c2b, '碰撞与彩蛋', '多宠之间可互相撞飞；探头与回旋同属本地玩法。', [
      toggle(c2b, 'collision_enabled', '碰撞', '多只桌宠之间互相碰撞'),
      advanced(c2b, '碰撞调参', [
        slider(c2b, 'collision_restitution', '弹性系数', 0, 1, 0.02),
        slider(c2b, 'collision_friction', '摩擦系数', 0, 8, 0.1),
        slider(c2b, 'collision_mass_scale', '质量系数', 0.2, 3, 0.1, '', ' ×'),
        slider(c2b, 'collision_impulse_cap', '冲量上限', 200, 6000, 100),
      ], 'settings'),
      toggle(c2b, 'edge_probe_enabled', '边缘探头', '拖到屏幕左右边缘自动探头'),
      toggle(c2b, 'golden_spin_enabled', '黄金回旋', '连点逐圈加速'),
    ], 'zap'));
  }

  private pageInteraction(page: string, head: HTMLElement, content: HTMLElement) {
    const t = this.tabBar(page, ['点击与音效', '自言自语', '趣味', '快捷键']);
    head.append(t.bar);
    content.append(t.host);
    const [clicks, selfTalk, fun, hotkeys] = t.bodies;

    const c = this.C(page, '点击与音效');
    clicks.append(section(c, '点击反馈', '点击桌宠触发 Q 弹时的轻量反馈。', [
      toggle(c, 'click_sound_enabled', '点击音效', '点击桌宠时播放轻量反馈音效'),
      slider(c, 'click_sound_volume', '音效音量', 0, 1, 0.05),
      select(c, 'click_sound_pack', '音效音源', [
        { label: '内置音效', value: 'builtin', icon: 'music' }, { label: '自定义文件', value: 'custom', icon: 'file' },
      ], '内置 duck 音效；自定义可把 click.wav 放到数据目录 sounds/ 下'),
      button(c, '试听音效', '测试当前选择的点击音效', '试听', () => this.previewSound(), 'music'),
      toggle(c, 'click_show_self_talk', '点击触发自言自语', '点击时随机显示一条自言自语'),
      advanced(c, '点击彩蛋', [
        toggle(c, 'click_golden_spin', '点击触发黄金回旋', '点击动画播完自动接回旋'),
        toggle(c, 'click_spin_skip_animation', '点击回旋跳过动画', '连续点击累计圈数并逐圈加速'),
      ], 'sparkles'),
    ], 'heart'));

    const c2 = this.C(page, '自言自语');
    selfTalk.append(section(c2, '气泡自言自语', '让桌宠偶尔显示一条随机思考气泡。', [
      toggle(c2, 'self_talk_enabled', '气泡自言自语'),
      textarea(c2, 'self_talk_texts', '候选内容', '每行一条；留空时恢复内置文本', '今天也要好好吃饭呀～'),
      select(c2, 'self_talk_bubble_style', '气泡方案', [
        { label: '经典暖黄 · 正上方', value: 'classic_top' },
        { label: '纸感卡片 · 左上方', value: 'paper_left' },
        { label: '深色玻璃 · 右上方', value: 'glass_right' },
        { label: '柔蓝对话 · 正上方', value: 'soft_blue_top' },
        { label: '吐气水泡 · 左上方', value: 'breath_bubble' },
      ], '贴近屏幕边缘时自动换位'),
      advanced(c2, '时机与外观', [
        slider(c2, 'self_talk_duration_seconds', '显示时间', 1, 20, 0.5, '每条气泡保持显示的秒数', ' 秒'),
        slider(c2, 'self_talk_min_interval', '最短间隔', 5, 300, 5, '上一条消失到下一条出现前', ' 秒'),
        slider(c2, 'self_talk_max_interval', '最长间隔', 10, 600, 5),
        slider(c2, 'bubble_text_scale', '气泡文字大小', 50, 300, 5, '字号等比放大', '%'),
        slider(c2, 'self_talk_image_scale', '配图大小', 30, 300, 5, '100% 为默认', '%'),
        slider(c2, 'self_talk_image_chance', '配图概率', 0, 1, 0.05, '0 表示只出文本'),
        text(c2, 'self_talk_image_dir', '图片目录', '留空时只显示文本', ''),
      ], 'settings'),
    ], 'chat'));

    const c3 = this.C(page, '趣味');
    fun.append(section(c3, '趣味玩法', '全部为本地玩法，不联网、不读取文件内容。', [
      button(c3, '拖文件模拟吃掉', '把文件拖到桌宠身上播放吃动画（不真实删除文件）', '试试看', () => {
        api.broadcast('feed-demo'); this.toast('把文件拖到桌宠身上试试～');
      }, 'fish'),
      button(c3, '投喂', '给桌宠投喂一次', '投喂', () => { api.broadcast('feed'); this.toast('投喂成功～'); }, 'gift'),
      button(c3, '扔蛋', '朝桌宠扔一个蛋', '扔一个', () => { api.broadcast('throw-egg'); }, 'star'),
      button(c3, '抽一支签', '本地签文库，不联网', '抽签', () => { api.broadcast('divination'); }, 'sparkles'),
      button(c3, '节日寄语', '按本机日期播放节日文案', '来一句', () => { api.broadcast('festival'); }, 'party'),
    ], 'party'));

    const c4 = this.C(page, '快捷键');
    hotkeys.append(section(c4, '快捷键', '设置窗内的固定组合键，不占用系统全局热键。', [
      notice('Ctrl + F', '聚焦侧栏搜索；回车 / ↓ 前进、↑ 后退，命中切到对应页并高亮。', 'search'),
      notice('右键桌宠', '打开菜单；左键点击互动，按住拖动移动，Ctrl + 滚轮缩放。', 'pet'),
    ], 'zap'));
  }

  private pageMenu(page: string, content: HTMLElement) {
    const c = this.C(page, '外观');
    const a = this.cfg.context_menu_appearance;
    const withA = (key: string, v: unknown) => {
      this.set('context_menu_appearance', { ...this.cfg.context_menu_appearance, [key]: v });
    };
    const ac: Ctx = { ...c, get: <T = unknown>(k: string) => (a as unknown as Record<string, unknown>)[k] as T, set: withA };
    content.append(section(ac, '菜单外观', '主题即时生效。', [
      select(ac, 'theme', '主题', [
        { label: '跟随系统', value: 'system', icon: 'appearance' }, { label: '浅色', value: 'light', icon: 'cloud' }, { label: '深色', value: 'dark', icon: 'moon' },
      ]),
      select(ac, 'density', '密度', [
        { label: '紧凑', value: 'compact' }, { label: '标准', value: 'standard' }, { label: '宽松', value: 'spacious' },
      ]),
      slider(ac, 'corner_radius', '圆角', 6, 28, 1, '', ' px'),
      toggle(ac, 'translucent', '半透明表面'),
      advanced(ac, '字体与配色', [
        text(ac, 'ui_font', '字体', 'system 使用系统 UI 字体', 'system'),
        slider(ac, 'ui_font_size', '字号', 10, 18, 1, '', ' px'),
        slider(ac, 'opacity', '表面不透明度', 0.72, 1, 0.01),
        color(ac, 'light_background', '浅色背景'),
        color(ac, 'light_foreground', '浅色文字'),
        color(ac, 'light_hover', '浅色悬停'),
        color(ac, 'dark_background', '深色背景'),
        color(ac, 'dark_foreground', '深色文字'),
        color(ac, 'dark_hover', '深色悬停'),
      ], 'appearance'),
    ], 'appearance'));
    const c2 = this.C(page, '彩蛋入口');
    const egg = this.cfg.menu_easter_egg;
    const ec: Ctx = { ...c2, get: <T = unknown>(k: string) => (egg as unknown as Record<string, unknown>)[k] as T,
      set: (k, v) => this.set('menu_easter_egg', { ...this.cfg.menu_easter_egg, [k]: v }) };
    content.append(section(ec, '彩蛋入口', '右键菜单首行的趣味入口。', [
      toggle(ec, 'enabled', '显示彩蛋入口'),
      text(ec, 'title', '标题', '', '厉害了我的鲸'),
      advanced(ec, '更多', [
        text(ec, 'hint', '副标题', '', '请点击'),
        text(ec, 'image_dir', '图片目录', '从目录随机选图作为头像'),
      ], 'sparkles'),
    ], 'sparkles'));
  }

  private featureConfig(c: Ctx, id: string): HTMLElement[] {
    switch (id) {
      case 'dynamic_island': return [
        toggle(c, 'island_enabled', '显示灵动岛'),
        toggle(c, 'island_show_clock', '显示时钟'), toggle(c, 'island_show_name', '显示名称'),
        toggle(c, 'island_show_cpu', '显示 CPU'), toggle(c, 'island_show_mem', '显示内存'),
        toggle(c, 'island_show_network', '显示网速'),
        select(c, 'island_info_mode', '信息栏内容', [
          { label: '时间', value: 'time' }, { label: '状态', value: 'status' }, { label: '自定义', value: 'custom' },
        ]),
        text(c, 'island_custom_text', '自定义文案'),
        slider(c, 'island_opacity', '不透明度', 0.3, 1, 0.05),
        select(c, 'island_edge', '停靠位置', [{ label: '顶部', value: 'top' }, { label: '底部', value: 'bottom' }]),
        toggle(c, 'island_collapsed', '收成细条'),
      ];
      case 'todo': return [
        toggle(c, 'todo_reminder_enabled', '启用提醒'),
        slider(c, 'todo_reminder_lead_minutes', '提前提醒', 0, 60, 1, '', ' 分钟'),
        toggle(c, 'system_notifications_enabled', '桌面通知'),
      ];
      case 'festival': return [toggle(c, 'festival_enabled', '节日提醒')];
      case 'divination': return [toggle(c, 'divination_enabled', '抽签')];
      case 'collision': return [
        toggle(c, 'collision_enabled', '启用碰撞'),
        slider(c, 'collision_restitution', '弹性系数', 0, 1, 0.02),
        slider(c, 'collision_friction', '摩擦系数', 0, 8, 0.1),
        slider(c, 'collision_mass_scale', '质量系数', 0.2, 3, 0.1, '', ' ×'),
        slider(c, 'collision_impulse_cap', '冲量上限', 200, 6000, 100),
      ];
      case 'edge_probe': return [toggle(c, 'edge_probe_enabled', '边缘探头')];
      case 'golden_spin': return [
        toggle(c, 'golden_spin_enabled', '黄金回旋'), toggle(c, 'click_golden_spin', '点击触发'),
        toggle(c, 'click_spin_skip_animation', '点击跳过动画'),
      ];
      case 'cross_screen': return [
        toggle(c, 'allow_cross_screen', '允许跨屏'),
      ];
      default: return [];
    }
  }

  private pageFeatures(page: string, content: HTMLElement) {
    const c = this.C(page, '功能');
    const feats: { id: string; name: string; desc: string; category: string; icon: string }[] = [
      { id: 'dynamic_island', name: '灵动岛', desc: '桌面胶囊，显示时间、网速、CPU / 内存。', category: '系统', icon: 'island' },
      { id: 'cross_screen', name: '多屏跨屏', desc: '浮层覆盖整块虚拟桌面，桌宠可跨屏。', category: '系统', icon: 'screen' },
      { id: 'todo', name: '待办提醒', desc: '到点用气泡或桌面通知提醒待办事项。', category: '生活', icon: 'todo' },
      { id: 'festival', name: '节日提醒', desc: '节日寄语，支持自定义文案。', category: '生活', icon: 'party' },
      { id: 'divination', name: '抽签', desc: '每天抽一支签，本地签文库。', category: '生活', icon: 'sparkles' },
      { id: 'collision', name: '碰撞', desc: '多只桌宠之间互相撞飞。', category: '互动', icon: 'zap' },
      { id: 'edge_probe', name: '边缘探头', desc: '拖到屏幕边缘自动探头。', category: '互动', icon: 'corner' },
      { id: 'golden_spin', name: '黄金回旋', desc: '连点逐圈加速的旋转彩蛋。', category: '互动', icon: 'star' },
    ];
    const catIcon: Record<string, string> = { 系统: 'screen', 生活: 'heart', 互动: 'paw' };
    const groups = [...new Set(feats.map((f) => f.category))];
    for (const g of groups) {
      const nodes: HTMLElement[] = [];
      for (const f of feats.filter((x) => x.category === g)) {
        const card = featureCard({
          name: f.name, desc: f.desc, icon: f.icon,
          on: this.cfg.feature_activation?.[f.id] !== false,
          onToggle: (on) => this.set('feature_activation', { ...this.cfg.feature_activation, [f.id]: on }),
          config: this.featureConfig(c, f.id),
        });
        nodes.push(card);
      }
      content.append(section(c, g, '', nodes, catIcon[g]));
    }
  }

  private pageAutomation(page: string, content: HTMLElement) {
    const c = this.C(page, '待办提醒');
    content.append(section(c, '待办提醒', '右键菜单 → 待办提醒 增删改；数据按实例落盘。', [
      toggle(c, 'todo_reminder_enabled', '启用待办提醒', '总开关'),
      slider(c, 'todo_reminder_lead_minutes', '提前提醒', 0, 60, 1, '默认提前 5 分钟', ' 分钟'),
      toggle(c, 'system_notifications_enabled', '桌面通知', '桌宠不可见时走系统通知'),
      button(c, '打开待办面板', '增删改与归档', '打开…', () => api.openTodo(), 'todo'),
    ], 'todo'));
    const c2 = this.C(page, '免打扰');
    content.append(section(c2, '免打扰', '免打扰期间普通提醒不往外冒；重新选一档 = 重新计时。', [
      slider(c2, 'quiet_minutes_default', '默认时长', 5, 240, 5, '右键「免打扰」里标「默认」的那一项', ' 分钟'),
      toggle(c2, 'quiet_also_on_fullscreen', '全屏应用时自动免打扰', '退出全屏后用气泡汇报攒了几条'),
    ], 'moon'));
    const c3 = this.C(page, '节日与抽签');
    content.append(section(c3, '节日与抽签', '纯本地文案，按本机日期触发，不联网。', [
      toggle(c3, 'festival_enabled', '节日提醒'),
      toggle(c3, 'divination_enabled', '抽签'),
    ], 'party'));
  }

  private pageUpdate(page: string, content: HTMLElement) {
    const c = this.C(page, '版本');
    content.append(section(c, '版本', '本版本不检查在线更新，请通过重新下载安装包升级。', [
      row(c, '当前版本', '桌宠浮层版', el('div', 'version-tag', 'v1.0.0'), 'version'),
      button(c, '数据目录', '配置与素材包所在位置', '打开文件夹', () => api.showDataDir().catch(() => {}), 'file'),
      button(c, '恢复默认设置', '一次性复位全部偏好', '恢复默认…', () => this.resetAll(), 'retry'),
    ], 'info'));
    const c2 = this.C(page, '项目与素材');
    content.append(section(c2, '项目与素材', '只读信息，不写入偏好。', [
      row(c2, '原项目', 'MerZlin/dsh-pet-indesktop（MIT）', el('div', 'version-tag', 'GitHub'), 'about.project'),
      row(c2, '内置素材', '106 段 640×360 透明 WebM + 点击音效', el('div', 'version-tag', 'MIT'), 'about.assets'),
      button(c2, '第三方声明', '查看素材与组件授权', '打开声明…', () => api.showDataDir().catch(() => {}), 'file'),
    ], 'heart'));
  }

  private set(key: string, value: unknown) {
    (this.cfg as unknown as Record<string, unknown>)[key] = value;
    this.markLocal();
    this.markDirty(key);
    this.scheduleSave();
  }
  private markDirty(key: string) {
    const d = (this.defaults as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(d) !== JSON.stringify((this.cfg as unknown as Record<string, unknown>)[key])) this.changed.add(key);
    else this.changed.delete(key);
    const dot = document.querySelector(`.setting-row[data-key="${CSS.escape(key)}"] .setting-dot`);
    dot?.classList.toggle('on', this.changed.has(key));
  }
  private markLocal() { this.localEditAt = Date.now(); }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 180);
  }
  private flush() { api.save(this.cfg).catch(() => {}); }
  private async resetAll() {
    if (!await api.confirm('恢复默认设置？将把全部偏好一次性复位。', '恢复默认设置')) return;
    this.cfg = mergeConfig(await api.reset());
    this.changed.clear();
    this.syncAll();
    this.applyTheme();
    this.toast('已恢复默认设置');
  }

  private syncAll() {
    document.querySelectorAll<HTMLElement & { _sync?: () => void }>('.setting-row').forEach((r) => r._sync?.());
    document.querySelectorAll('.setting-dot').forEach((d) => {
      const k = (d.closest('.setting-row') as HTMLElement)?.dataset.key ?? '';
      d.classList.toggle('on', this.changed.has(k));
    });
  }

  private showPage(label: string) {
    for (const [name, p] of this.pages) p.classList.toggle('active', name === label);
    this.sidebar.querySelectorAll<HTMLElement>('.nav-item').forEach((i) => i.classList.toggle('active', i.dataset.page === label));
    this.body.scrollTop = 0;
  }

  private search(advance: boolean) {
    const q = this.searchInput.value.trim().toLowerCase();
    document.querySelectorAll('.search-hit').forEach((n) => n.classList.remove('search-hit'));
    if (!q) { this.matches = []; this.matchIndex = -1; this.searchStatus.textContent = ''; return; }
    this.matches = this.searchable.filter((s) => s.text.toLowerCase().includes(q));
    this.matchIndex = advance && this.matches.length ? this.matchIndex : -1;
    this.searchStatus.textContent = this.matches.length ? `${this.matches.length} 项匹配 · 回车跳转` : '无匹配';
  }

  private jump(index: number) {
    if (!this.matches.length) return;
    const n = this.matches.length;
    this.matchIndex = ((index % n) + n) % n;
    const hit = this.matches[this.matchIndex];
    this.showPage(hit.page);
    const tab = this.tabs.get(hit.page);
    if (tab) {
      const body = tab.bodies.findIndex((b) => b.contains(hit.el));
      if (body >= 0) (tab.bar.children[body] as HTMLElement).click();
    }
    const acc = hit.el.closest('.advanced, .feature-card') as HTMLElement | null;
    if (acc && !acc.classList.contains('open')) {
      (acc.querySelector('.advanced-toggle, .feature-trigger') as HTMLElement | null)?.click();
    }
    requestAnimationFrame(() => hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    document.querySelectorAll('.search-hit').forEach((x) => x.classList.remove('search-hit'));
    hit.el.classList.add('search-hit');
    this.searchStatus.textContent = `${this.matchIndex + 1} / ${this.matches.length} · ${hit.section}`;
  }

  private bind() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault(); this.searchInput.focus(); this.searchInput.select();
      }
    });
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.select-wrap')) {
        document.querySelectorAll('.select-menu.open').forEach((m) => m.classList.remove('open'));
      }
    });
    window.addEventListener('beforeunload', () => { window.clearTimeout(this.saveTimer); this.flush(); });
    this.applyTheme();
  }

  private applyTheme() {
    const t = this.cfg.ui_theme;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.density = this.cfg.ui_density;
    document.documentElement.style.setProperty('--ui-font', `${this.cfg.ui_font_size}px`);
    document.documentElement.style.setProperty('--ui-radius', `${this.cfg.corner_radius}px`);
  }

  private previewSound() {
    const a = new Audio(petUrl('r/sounds/click-duck.wav'));
    a.volume = Number(this.cfg.click_sound_volume ?? 0.7);
    a.play().catch(() => this.toast('音效播放失败'));
  }

  private toast(msg: string) {
    const host = document.querySelector('.toast-host');
    if (!host) return;
    const t = el('div', 'toast', msg);
    host.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }
}

export async function start() {
  const app = new SettingsApp(await loadConfig());
  (window as unknown as { __settings: SettingsApp }).__settings = app;
  await app.start();
}
