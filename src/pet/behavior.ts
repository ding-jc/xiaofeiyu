// 动画链：30% 待机 / 10% 转向 / 40% 动作 / 20% 走位（对齐 dsh-pet 原版概率）。
import type { CharacterPack, Clip, Config } from '../types';
import {
  P_ACTS, P_IDLE, P_TURN, MOVE_MARGIN, MOVE_MIN_PX, strideOf, sampleCurve,
  clips,
} from './catalog';
import { flying } from './physics';
import { layerLock } from './layer-cfg';
import type { Pet } from './pet';

type State = 'idle' | 'turn' | 'move' | 'click' | 'drag' | 'acts' | 'gap';

export class Behavior {
  state: State = 'idle';
  idleFor = 0;
  private elapsed = 0;
  private duration = 1;
  private loops = 1;
  private grace = 0;
  private finished = false;
  private gap = 0;
  private selfTalkIn = 0;
  private loopDur = 1;
  // 走位：一段 move 动画期间从起点平缓平移到终点。
  private walkFrom = 0;
  private walkTo = 0;
  private mediaDuration = 0; // 当前动画媒体时长（秒），0 = onReady 未拿到有限时长
  private moveCurve: number[] | undefined; // 本次走位的逐帧位移进度曲线，逐帧采样以对齐起步/到位停顿

  constructor(private pet: Pet, private cfg: () => Config) {}

  /** 每宠档案覆盖全局同名键 */
  private pc(): Config { return this.pet.effective(this.cfg()); }

  start() {
    this.armSelfTalk();
    this.chain();
  }

  private pack(): CharacterPack { return this.pet.pack; }

  /** 自动播放统一取片：只从可见池取（隐藏分类/动作不参与），无可见项返回 null。 */
  private visPick(cat: string, exclude?: string): Clip | null {
    const list = this.pet.world.visibleClips(this.pack(), cat).filter((c) => c.name !== exclude);
    return list.length ? list[(Math.random() * list.length) | 0] : null;
  }
  /** 待机兜底：可见 idle → 可见 random → 任意可见动作，绝不回退到含隐藏的原始桶。 */
  private visIdle(): Clip | null {
    return this.pet.world.visibleClips(this.pack(), 'idle')[0]
      ?? this.visPick('random')
      ?? this.pet.world.pickVisibleAny(this.pack());
  }

  private bind(clip: Clip, loop: boolean, state: State, loops = 1) {
    this.state = state;
    this.elapsed = 0;
    this.grace = 0;
    this.finished = false;
    this.loops = loops;
    this.duration = 1e9;
    this.mediaDuration = 0;
    const rate = this.pc().playback_speed;
    this.pet.setMirror(this.pet.facing === 'right' && !clip.no_mirror);
    this.pet.player.play(clip.src, {
      loop,
      rate,
      fitBox: this.pack().body_box ?? undefined,
      onReady: (d) => {
        this.loopDur = Math.max(0.05, d / rate);
        this.duration = this.loopDur * loops;
        this.mediaDuration = Math.max(0.05, d);
        // 视频首帧真正开播才计时：此前 bind→reveal 的加载延迟不该算进动画时长，
        // 否则位移/结束都相对动画提前，出现「没开始就移动 / 播完了还在滑」。
        this.elapsed = 0;
      },
      onEnd: () => { this.finished = true; },
    });
  }

  private cancelGap() { this.gap = 0; }

  private startGap() {
    const s = this.pc().animation_gap_seconds;
    if (s <= 0) { this.chain(); return; }
    this.gap = s;
    this.state = 'gap';
    this.elapsed = 0;
    this.duration = s;
    const c = this.visIdle();
    if (c) this.bind(c, true, 'gap', 1);
    else this.state = 'gap';
  }

  private endState() {
    if (this.state === 'idle' || this.state === 'gap') { this.chain(); return; }
    this.startGap();
  }

  private chain() {
    const roll = Math.random();
    if (roll < P_IDLE) { this.enterIdle(1 + ((Math.random() * 2) | 0)); return; }
    if (roll < P_TURN) {
      if (this.pet.world.visibleClips(this.pack(), 'turn').length) { this.enterTurn(); return; }
      this.enterIdle(1);
      return;
    }
    if (roll < P_ACTS) {
      const a = this.pet.world.nextRandom(this.pack(), 'random')
        ?? this.pet.world.pickVisible(this.pack(), 'random')
        ?? this.pet.world.pickVisible(this.pack(), 'events');
      if (a) { this.enterActs(a); return; }
    }
    // 末档 20% 走位：走不了（锁定/飞行/无 move 素材/贴边）就退回待机。
    if (this.enterMove()) return;
    this.enterIdle(1);
  }

  private enterIdle(loops: number) {
    const c = this.visIdle();
    if (!c) { this.duration = 2; return; }
    this.bind(c, true, 'idle', loops);
  }

  private enterTurn() {
    const c = this.visPick('turn');
    if (!c) { this.chain(); return; }
    // 转向动画决定新朝向：翻转 facing（走位方向据此而定）。
    this.pet.facing = this.pet.facing === 'right' ? 'left' : 'right';
    this.bind(c, false, 'turn');
  }

  private enterActs(c: Clip) { this.bind(c, false, 'acts'); }

  /** 尝试发起一次走位；clip 为空则随机取 move 素材。成功进入 move 状态返回 true。 */
  private enterMove(clip?: Clip): boolean {
    const c = this.pc();
    if (c.no_move || layerLock(c, this.pet.world.view)) return false;
    if (this.pet.body.dragging || flying(this.pet.body) || this.pet.body.knock > 0) return false;
    const moveClip = clip ?? this.visPick('move');
    if (!moveClip) return false;

    // 只给素材自带走位配置（stride/curve）的动画位移；其余角色/动画不硬加移动效果。
    const { stride, curve, configured } = strideOf(this.pack(), moveClip);
    if (!configured) return false;
    this.moveCurve = curve;

    const b = this.pet.world.workBounds();
    // 位移距离严格取素材配置的 stride（基于 640 基准宽）随宠物缩放，不套最小值兜底。
    const dist = stride * this.pet.scale;
    const from = this.pet.x;
    const min = b.x + MOVE_MARGIN;
    const max = b.x + b.w - this.pet.width - MOVE_MARGIN;
    const clamp = (x: number) => Math.max(min, Math.min(max, x));
    // 优先沿当前朝向；贴边走不通就翻面走另一侧，避免手动点走路动画却原地不动。
    let dir = this.pet.facing === 'right' ? 1 : -1;
    let to = clamp(from + dir * dist);
    if (Math.abs(to - from) < MOVE_MIN_PX * 0.5) {
      dir = -dir;
      to = clamp(from + dir * dist);
      if (Math.abs(to - from) < MOVE_MIN_PX * 0.5) return false;
      this.pet.facing = dir > 0 ? 'right' : 'left';
    }

    this.walkFrom = from;
    this.walkTo = to;
    this.bind(moveClip, false, 'move');
    return true;
  }

  /** 判断一个动画是否属于「移动」分类（素材目录 move 桶或素材自带 category=move）。 */
  private isMoveClip(c: Clip): boolean {
    return c.category === 'move' || clips(this.pack(), 'move').some((m) => m.name === c.name);
  }

  reset() { this.cancelGap(); this.chain(); }

  playOnce(c: Clip) {
    this.cancelGap();
    // 手动触发（右键菜单动作）：移动类动画必须真的位移，和自主走位共用插值路径。
    if (this.isMoveClip(c) && this.enterMove(c)) return;
    this.enterActs(c);
  }

  onClick() {
    this.idleFor = 0;
    this.cancelGap();
    const c = this.visPick('click');
    if (c) this.bind(c, false, 'click');
    else this.enterIdle(1);
  }

  onDoubleClick() {
    this.idleFor = 0;
    const c = this.pet.world.pickVisible(this.pack(), 'random')
      ?? this.pet.world.pickVisible(this.pack(), 'events');
    if (c) this.bind(c, false, 'acts');
  }

  onDragStart() {
    this.idleFor = 0;
    this.cancelGap();
    // 拖拽期间不改变朝向：恢复 bind 可能翻转的镜像
    const keep = this.pet.stage.style.transform;
    const c = this.visPick('drag');
    if (c) this.bind(c, true, 'drag');
    else this.state = 'drag';
    this.pet.stage.style.transform = keep;
  }

  onDragEnd() { this.enterIdle(1); }

  onThrown() {
    this.idleFor = 0;
    this.cancelGap();
    this.state = 'idle';
    this.duration = 0.6;
  }

  update(dt: number) {
    this.idleFor += dt;
    if (this.pc().self_talk_enabled) {
      this.selfTalkIn -= dt;
      if (this.selfTalkIn <= 0) {
        const texts = this.pc().self_talk_texts;
        if (texts.length) {
          this.pet.bubble.show(texts[(Math.random() * texts.length) | 0], {
            style: this.pc().self_talk_bubble_style,
            scale: this.pc().bubble_text_scale,
            duration: this.pc().self_talk_duration_seconds,
          });
        }
        this.armSelfTalk();
      }
    }
    if (this.state === 'drag') return;

    this.elapsed += dt;
    if (this.state === 'gap') {
      this.gap -= dt;
      if (this.gap <= 0) this.chain();
      return;
    }
    if (this.state === 'move') {
      // 中途被拖拽/抛掷/锁定/击飞 → 立即收尾，别继续插值把宠物拽回去。
      const c = this.pc();
      if (this.pet.body.dragging || flying(this.pet.body) || c.no_move || layerLock(c, this.pet.world.view)) {
        this.endState();
        return;
      }
      // 播放进度 → 位移进度：素材带 curve 就按逐帧累计曲线采样，起步/到位停顿段自然停住；
      // 无 curve 的素材回退线性。视频卡帧/变速/延迟解码都靠播放头对齐，finished 钉在 1 防瞬移。
      const head = this.pet.player.time();
      const t = this.finished ? 1 : this.mediaDuration > 0
        ? Math.max(0, Math.min(1, head / this.mediaDuration))
        : (this.duration < 1e8 ? Math.max(0, Math.min(1, this.elapsed / this.duration)) : 0);
      const progress = this.finished ? 1 : (sampleCurve(this.moveCurve, t) ?? t);
      this.pet.walkTo(this.walkFrom + (this.walkTo - this.walkFrom) * progress);
    }
    if (this.elapsed < this.duration) return;
    if (this.state === 'idle') { this.chain(); return; }
    if (this.finished || this.grace >= 0.5) { this.endState(); return; }
    this.grace += dt;
  }

  private armSelfTalk() {
    const c = this.pc();
    const a = Math.max(3, c.self_talk_min_interval);
    const b = Math.max(a, c.self_talk_max_interval);
    this.selfTalkIn = a + Math.random() * (b - a);
  }

  say(text: string, duration = 3) {
    this.pet.bubble.show(text, {
      style: this.pc().self_talk_bubble_style,
      scale: this.pc().bubble_text_scale,
      duration,
    });
  }
}
