import { BUBBLE_PRESETS } from './catalog';

export interface BubbleOpts {
  style: string;
  scale: number;
  duration: number;
  subtitle?: string;
}

/** 名牌相对光标的放置：默认右下，贴边翻到反侧（对齐 dsh-pet 的 tooltipPlacement）。 */
const TAG_GAP = 18;
const EDGE = 6;

export class Bubble {
  readonly el: HTMLDivElement;      // 自言自语气泡，挂 pet.root（头顶定位）
  readonly tagEl: HTMLDivElement;   // 跟随光标的名牌，挂 layer（视口坐标定位）
  private timer = 0;

  constructor(host: HTMLElement, tagHost: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pet-bubble';
    this.el.innerHTML = '<div class="bubble-sub"></div><div class="bubble-body"></div>';
    host.append(this.el);

    this.tagEl = document.createElement('div');
    this.tagEl.className = 'pet-name-tag';
    this.tagEl.setAttribute('aria-hidden', 'true');
    tagHost.append(this.tagEl);
  }

  show(text: string, o: BubbleOpts) {
    const p = BUBBLE_PRESETS[o.style] ?? BUBBLE_PRESETS.classic_top;
    const k = Math.max(0.5, Math.min(3, o.scale / 100));
    this.el.dataset.place = p.placement;
    this.el.style.setProperty('--bubble-bg', p.background);
    this.el.style.setProperty('--bubble-border', p.border);
    this.el.style.setProperty('--bubble-fg', p.foreground);
    this.el.style.setProperty('--bubble-radius', `${p.radius}px`);
    this.el.style.setProperty('--bubble-shadow', p.shadow);
    this.el.style.setProperty('--bubble-scale', String(k));
    const sub = this.el.querySelector('.bubble-sub') as HTMLElement;
    const body = this.el.querySelector('.bubble-body') as HTMLElement;
    sub.textContent = o.subtitle ?? '';
    sub.style.display = o.subtitle ? 'block' : 'none';
    body.textContent = text;
    this.el.classList.add('show');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), Math.max(500, o.duration * 1000));
  }

  hide() {
    window.clearTimeout(this.timer);
    this.el.classList.remove('show');
  }

  /**
   * 悬停名牌：文本 = 角色名，位置 = 光标右下（贴边翻到左上），每次鼠标移动实时重摆。
   * 对齐 dsh-pet：坐标用视口 CSS 像素（与 elementFromPoint 同源），不自动消失，移开收起。
   */
  tag(text: string, x: number, y: number) {
    if (this.tagEl.textContent !== text) this.tagEl.textContent = text;
    const w = this.tagEl.offsetWidth;
    const h = this.tagEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 默认右下；右侧/下方放不下就翻到光标左上。用未显示时的 offsetWidth 需先显形。
    const flipX = x + TAG_GAP + w > vw - EDGE;
    const flipY = y + TAG_GAP + h > vh - EDGE;
    const left = flipX ? Math.max(EDGE, x - TAG_GAP - w) : x + TAG_GAP;
    const top = flipY ? Math.max(EDGE, y - TAG_GAP - h) : y + TAG_GAP;
    this.tagEl.style.left = `${left}px`;
    this.tagEl.style.top = `${top}px`;
    this.tagEl.classList.add('show');
  }

  moveTag(x: number, y: number) {
    if (!this.tagEl.classList.contains('show')) return;
    // 复用 tag 的摆位（文本不变），抽一次避免两处逻辑漂移。
    this.tag(this.tagEl.textContent ?? '', x, y);
  }

  dropTag() {
    window.clearTimeout(this.timer);
    this.tagEl.classList.remove('show');
  }
}
