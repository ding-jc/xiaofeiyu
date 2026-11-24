// 抛掷物理 / 边界回弹 / 宠物间碰撞。
// 物理只在「扔出」时触发：飞行中（速度 > FLY_MIN 且未拖拽）的宠物才参与碰撞；
// 静止放置 / 拖拽中的宠物互不推开 —— 可重叠，放置动作不触发物理。
// 但飞行的宠物撞到静止宠物时，静止方按真实质量参与求解被撞开（拖拽/锁定方固定不动）。
// 物理参数对齐原项目 shared/physics：重力 1400 / 碰边恢复 0.78(法向+切向分解)
// / 互撞 e=0.995(质量∝size²) / 子步积分防穿透 / 接触面静止阈值防抖。
// 多宠同窗沿用多体求解器(圆链检测 + 冲量 + 每对独立计时 TTL)，仅恢复系数/摩擦/质量口径对齐原项目。
// 边界使用 Windows 工作区（屏幕减任务栏），撞墙/落地带挤压变形信号（body.hit）。
// 贴边/落地按身体框（body_box×scale，对齐原项目 _sprite_bounds V-2）：
// 地面 = 身体框底缘贴工作区底，画布透明边允许越界；区域比身体还小时钳回防死循环。
// 大小统一：视频帧拉伸填满画布（对齐原项目 IgnoreAspectRatio scaled），画布坐标系恒一致。
// 碰撞只做物理与变形，无音效。
import type { Config } from '../types';

export interface Body {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; dragging: boolean; angle: number;
  // 碰撞扩展字段
  scale: number;
  circles: number[][];   // 屏幕坐标圆链 [cx, cy, r]
  mass: number;          // 0.5 ~ 2.5
  infinite: boolean;     // 兼容字段（碰撞以 flying() 判定为准）
  px: number; py: number; // 上一帧位置（扫掠用）
  tag: string;           // 稳定 id（重合方向哈希）
  hit: number;           // 本帧撞击速度（边界回弹信号，驱动挤压变形）
  // 击退态：被撞后进入，力度连续决定加速度与衰减，无固定阈值 snap。
  // knock∈(0,1] 击退强度(剩多少)，随力度衰减；knockDamp 阻尼率(力度大→衰减慢→滑得远)。
  // knock>0 期间抑制重力：让被撞方先滑行，力竭后重力才接管（速度已归零→悬停，仍有速度→掉落）。
  knock: number; knockDamp: number;
  // 身体框相对 pet 左上角的偏移（body_box × scale，缺省 = 整画布）。
  // 对齐原项目 _sprite_bounds(V-2)：贴边/落地按身体框，画布透明边允许越界。
  box: { l: number; t: number; r: number; b: number };
}

// ---- 物理常量 ----
// 对齐原项目 shared/physics：重力/碰边/互撞同一套参数。
const GRAVITY = 1400;                       // 抛掷重力（原项目 GRAVITY）
const MAX_STEP_DT = 0.05;                   // 单步最大 dt：防卡顿恢复的巨帧跳变
const SUBSTEP_PX = 8;                       // 单步最大位移：超过就拆步，防高速穿过落地/反弹帧
const SUBSTEP_MAX = 64;                     // 单帧最多拆步数
const WALL_BOUNCE = 0.78;                   // 碰边法向恢复系数（原项目 RESTITUTION）
const GROUND_FRICTION = 2.5;                // 接触面切向摩擦率 /s（原项目 GROUND_FRICTION）
const REST_NORMAL = 40;                     // 法向速度低于它就贴边归零，防贴面抖动（原项目 REST_NORMAL）
const REST_TANGENT = 15;                    // 切向速度低于它视为静止（原项目 REST_TANGENT）
const REST_NORMAL_EPS = 1;                  // 判静止的法向容差（原项目 REST_NORMAL_EPS）
// 宠物互撞：原项目 collidePet 用 e=0.995 近完全弹性 + 质量∝size²，写绝对速度一次算定。
// 当前保留多体求解器（多宠同窗），但恢复系数对齐 0.995、无切向摩擦、低速不强制吸能。
export const COLLISION_RESTITUTION = 0.995; // 宠物互撞恢复系数（原项目 PET_BOUNCE_E）
export const COLLISION_FRICTION = 0;        // 宠物互撞无切向摩擦（对齐原项目 collidePet）
export const COLLISION_MASS_SCALE = 1.0;
export const COLLISION_IMPULSE_CAP = 9000;
export const COLLISION_MIN_APPROACH = 0;    // 原项目无接近速度门槛：vrel>0 即弹性分离
const FLY_MIN = 60;          // 高于此速度视为「扔出飞行中」才触发物理
const EVENT_MIN_IMPULSE = 80; // 低于此冲量不上报事件（变形）
const CONTACT_TTL = 2.5;     // 每对碰撞最长生效秒数：无新主动碰撞则倒计时关闭，最终允许重叠
const FADE_TAIL = 0.8;       // 末段渐弱窗口：分离力度线性降到 0，物理碰撞逐渐关闭

// 被动碰撞连续击退模型（无固定阈值 snap）：
// 被撞方吃下的加速度、阻尼、击退时长全部是撞击力度(法向接近速度 approach)的连续函数。
// 力度小 → 初速小、阻尼大、击退短 → 滑几 px 就停稳、重力来不及接管 → 不掉；
// 力度大 → 初速大、阻尼小、击退长 → 滑很远且力竭时仍有速度 → 重力接管掉落。
// 撞击方(飞行中)不受影响，扔出手感不变。
const KNOCK_SOFT = 800;        // 力度曲线半饱和点：approach=此值时 gain=0.5
const KNOCK_DAMP = 40;         // 阻尼基准：damp = KNOCK_DAMP·(1-gain)³，力度越大衰减越慢
const KNOCK_DECAY = 0.36;      // knock 强度每秒衰减量：击退时长 ≈ gain/DECAY
const KNOCK_REST = 6;          // 击退速度(曼哈顿)低于它就归零停稳，避免残留微速导致长期漂移

// 每对碰撞独立计时（tag 有序 key → 剩余生效秒数）：主动碰撞重置为满值；
// 之后倒计时，末段位置分离渐弱到 0，到期该对允许重叠（不再被推开）。
const contacts = new Map<string, number>();
function pairKey(a: Body, b: Body): string {
  return a.tag < b.tag ? `${a.tag}|${b.tag}` : `${b.tag}|${a.tag}`;
}

export interface Bounds { x: number; y: number; w: number; h: number }
export interface CollisionEvent { a: string; b: string; impulse: number }

/** 是否处于扔出飞行状态：只有飞行中的宠物触发物理，其余可重叠。 */
export function flying(b: Body): boolean {
  return !b.dragging && Math.abs(b.vx) + Math.abs(b.vy) > FLY_MIN;
}

/**
 * 接触面求解（对齐原项目 contact.ts resolveContact）：法向按恢复系数反弹、低于阈值贴边归零，
 * 切向按摩擦率衰减、不改方向。四边共用一套公式，法向恒指向可通行一侧。
 * 返回出射法向/切向速度，供判静止用。
 */
function resolveContact(vx: number, vy: number, edge: 'left' | 'right' | 'ceiling' | 'floor', dt: number)
  : { vx: number; vy: number; normal: number; tangent: number } {
  const N: Record<string, [number, number]> = { left: [1, 0], right: [-1, 0], ceiling: [0, 1], floor: [0, -1] };
  const [nx, ny] = N[edge];
  const tx = -ny, ty = nx;
  const vn = vx * nx + vy * ny;
  const vt = vx * tx + vy * ty;
  const normal = Math.abs(vn) < REST_NORMAL ? 0 : Math.abs(vn) * WALL_BOUNCE;
  const tangent = vt * Math.max(0, 1 - GROUND_FRICTION * dt);
  return { vx: normal * nx + tangent * tx, vy: normal * ny + tangent * ty, normal, tangent };
}

/** 单步积分（抛掷一步）：重力 + 位移 + 四边接触。返回本步是否移动。 */
function stepOnce(b: Body, dt: number, bounds: Bounds): boolean {
  // 身体框贴工作区四边（原项目 throwBoundsIn）；区域比身体小时钳回防死循环
  const minY = bounds.y - b.box.t;
  const floor = Math.max(minY, bounds.y + bounds.h - b.box.b);
  const minX = bounds.x - b.box.l;
  const maxX = Math.max(minX, bounds.x + bounds.w - b.box.r);

  // 击退期间关闭重力：让被撞方按力度滑行、纯阻尼衰减；力竭(knock→0)后重力才接管。
  // 关键：重力恢复只看 knock 不够——速度已衰减到很小的被撞方本就该悬停，
  // 若 RAMP 仍注入重力，它会脱离静止分支被拉下去(非单调掉落的根因)。
  // 故 knock>0 时一律 0 重力；knock<=0 时才按速度大小决定：
  //   速度极小(<=REST_TANGENT)→靠静止分支悬停，重力 0；有速度→全额重力接管掉落。
  const still = Math.abs(b.vx) + Math.abs(b.vy) <= KNOCK_REST;
  const gravScale = b.knock > 0 ? 0 : still ? 0 : 1;
  b.vy += GRAVITY * gravScale * dt;
  const x0 = b.x, y0 = b.y;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  // 撞飞时头部跟随速度方向整帧旋转，低速触碰边界或其它桌宠回正
  const spin = Math.max(-45, Math.min(45, b.vx * 0.035));
  b.angle = Math.abs(b.vx) > 60 ? spin : b.angle * 0.9;

  let bounced = false;
  const edges: string[] = [];
  if (b.x < minX) { b.hit = Math.max(b.hit, Math.abs(b.vx)); b.x = minX; const r = resolveContact(b.vx, b.vy, 'left', dt); b.vx = r.vx; b.vy = r.vy; b.angle *= 0.5; bounced = true; edges.push('left'); }
  else if (b.x > maxX) { b.hit = Math.max(b.hit, Math.abs(b.vx)); b.x = maxX; const r = resolveContact(b.vx, b.vy, 'right', dt); b.vx = r.vx; b.vy = r.vy; b.angle *= 0.5; bounced = true; edges.push('right'); }

  if (b.y < minY) { b.hit = Math.max(b.hit, Math.abs(b.vy)); b.y = minY; const r = resolveContact(b.vx, b.vy, 'ceiling', dt); b.vx = r.vx; b.vy = r.vy; bounced = true; edges.push('ceiling'); }
  else if (b.y >= floor) { b.hit = Math.max(b.hit, Math.abs(b.vy)); b.y = floor; const r = resolveContact(b.vx, b.vy, 'floor', dt); b.vx = r.vx; b.vy = r.vy; bounced = true; edges.push('floor'); }

  // 判静止（对齐原项目 isRestingOnContacts）：所有接触面法向≈0 且切向低于阈值 → 停稳。
  if (bounced && Math.abs(b.vy) < REST_NORMAL_EPS && Math.abs(b.vx) < REST_TANGENT) {
    b.vx = 0; b.vy = 0;
  }
  return b.x !== x0 || b.y !== y0 || b.angle !== 0;
}

/**
 * 单只桌宠一帧积分（重力/抛掷/落地回正/工作区边界回弹）。
 * 按位移拆子步（对齐原项目 throwSubsteps）：高速甩出时一帧跨过上百 px，不拆会跳过落地/反弹帧。
 */
export function stepBody(b: Body, dtRaw: number, cfg: Config, bounds: Bounds): boolean {
  if (b.dragging) return false;
  b.hit = 0;
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  // 击退态衰减：knock 线性力竭；速度按与力度关联的阻尼率指数衰减
  // （力度小→damp 大→衰减快；力度大→damp 小→滑得远）。knock 归零后重力完全接管。
  let knocked = false;
  if (b.knock > 0) {
    knocked = true;
    b.knock = Math.max(0, b.knock - KNOCK_DECAY * dt);
    const damp = Math.exp(-b.knockDamp * dt);
    b.vx *= damp; b.vy *= damp;
    // 速度衰减到极小 → 归零并立即结束击退态：让 stepBody 静止分支接管悬停，
    // 不再走 stepOnce(否则 knock 力竭/衰减时重力恢复会把静止的悬空宠拉下去)。
    // 重撞则相反：力竭时速度仍大 → knock 自然到 0 → 重力全额接管 → 掉落。
    if (Math.abs(b.vx) + Math.abs(b.vy) < KNOCK_REST) {
      b.vx = 0; b.vy = 0; b.knock = 0;
      knocked = false; // 击退已结束，放行静止分支接管悬停（否则本帧仍走 stepOnce 被重力拉走）
    }
  }
  const travel = Math.hypot(b.vx, b.vy) * dt;
  const steps = travel > SUBSTEP_PX ? Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX)) : 1;
  // 静止且贴地：直接停稳归位，零开销（击退未结束时不冻结，让滑行继续）
  const floor = Math.max(bounds.y - b.box.t, bounds.y + bounds.h - b.box.b);
  if (!knocked && steps === 1 && Math.abs(b.vx) < 1 && Math.abs(b.vy) < 1 && Math.abs(b.angle) < 0.2 && b.y <= floor) {
    if (b.y <= floor && b.angle === 0) return false;
    b.y = Math.min(b.y, floor);
    b.angle *= 0.86;
    if (Math.abs(b.angle) < 0.2) b.angle = 0;
    return true;
  }
  const sub = dt / steps;
  let moved = false;
  for (let i = 0; i < steps; i++) moved = stepOnce(b, sub, bounds) || moved;
  return moved || knocked;
}

// ---- 圆链几何 ----
/** 在可见内容矩形内切 3 个等圆（横宽则水平排列，竖长则竖直排列）。 */
export function circlesFromRect(left: number, top: number, width: number, height: number): number[][] {
  left = +left; top = +top;
  width = Math.max(0, +width); height = Math.max(0, +height);
  const r = Math.max(1e-4, Math.min(width, height) / 2);
  const cx = left + width / 2, cy = top + height / 2;
  if (width >= height) {
    return [[left + r, cy, r], [cx, cy, r], [left + width - r, cy, r]];
  }
  return [[cx, top + r, r], [cx, cy, r], [cx, top + height - r, r]];
}

/** 两中心完全重合时，用稳定哈希生成固定单位方向（禁用随机，避免抖动）。 */
function stableDir(idA: string, idB: string): [number, number] {
  const ordered = [idA, idB].sort();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < ordered.join('--').length; i++) {
    h ^= ordered.join('--').charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const angle = ((h >>> 0) % 360000) / 1000 * (Math.PI / 180);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  return idA === ordered[0] ? [ux, uy] : [-ux, -uy];
}

/** 两圆链最深重叠检测（对齐 check_collision_circles）。 */
function circleOverlap(c1: number[][], c2: number[][], idA: string, idB: string)
  : [boolean, number, number, number, number, number] {
  let best: number[] | null = null;
  for (const a of c1) {
    for (const b of c2) {
      const x1 = a[0], y1 = a[1], r1 = Math.max(1e-4, a[2]);
      const x2 = b[0], y2 = b[1], r2 = Math.max(1e-4, b[2]);
      const dx = x2 - x1, dy = y2 - y1;
      const d = Math.hypot(dx, dy);
      if (d >= r1 + r2) continue;
      let nx: number, ny: number;
      if (d < 1e-6) [nx, ny] = stableDir(idA, idB);
      else { nx = dx / d; ny = dy / d; }
      const overlap = r1 + r2 - d;
      const cx = (x1 + nx * r1 + x2 - nx * r2) / 2;
      const cy = (y1 + ny * r1 + y2 - ny * r2) / 2;
      if (!best || overlap > best[0]) best = [overlap, nx, ny, cx, cy];
    }
  }
  if (!best) return [false, 0, 0, 0, 0, 0];
  return [true, best[1], best[2], best[0], best[3], best[4]];
}

function chainAt(b: Body, x: number, y: number): number[][] {
  const ox = x - b.x, oy = y - b.y;
  return b.circles.map((c) => [c[0] + ox, c[1] + oy, c[2]]);
}

/** 当前帧（或指定偏移位置）两圆链碰撞。 */
function collide(a: Body, b: Body, x1?: number, y1?: number, x2?: number, y2?: number)
  : [boolean, number, number, number, number, number] {
  const ca = chainAt(a, x1 ?? a.x, y1 ?? a.y);
  const cb = chainAt(b, x2 ?? b.x, y2 ?? b.y);
  return circleOverlap(ca, cb, a.tag, b.tag);
}

/** 扫掠检测：上一帧→当前帧圆心轨迹若穿过对方，返回首次接触法线（近似单圆）。 */
function swept(a: Body, b: Body): [number, number] | null {
  const ra = Math.max(...a.circles.map((c) => c[2]));
  const rb = Math.max(...b.circles.map((c) => c[2]));
  const rsum = ra + rb;
  const sx = a.px - b.px, sy = a.py - b.py;
  const dx = (a.x - a.px) - (b.x - b.px);
  const dy = (a.y - a.py) - (b.y - b.py);
  const A = dx * dx + dy * dy;
  if (A <= 1e-12) return null;
  const B = 2 * (sx * dx + sy * dy);
  const C = sx * sx + sy * sy - rsum * rsum;
  if (C <= 0) return null; // 帧首已重叠，交静态检测处理
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t < 0 || t > 1) return null;
  const rx = sx + dx * t, ry = sy + dy * t;
  const d = Math.hypot(rx, ry);
  if (d > 1e-6) return [-rx / d, -ry / d];
  return stableDir(a.tag, b.tag);
}

/** 冲量求解（对齐 solve_collision_impulse）。拖拽/锁定方 = 无限质量吸能(e=0)；低速贴贴只挡不弹。 */
function solveImpulse(a: Body, b: Body, nx: number, ny: number,
  rest: number, fric: number, cap: number): [number, number, number, number] {
  const invA = a.infinite ? 0 : 1 / Math.max(1e-6, a.mass);
  const invB = b.infinite ? 0 : 1 / Math.max(1e-6, b.mass);
  if (invA === 0 && invB === 0) return [0, 0, 0, 0];
  const vrx = b.vx - a.vx, vry = b.vy - a.vy;
  const vn = vrx * nx + vry * ny;
  if (vn >= 0) return [0, 0, 0, 0];
  let e = Math.max(0, Math.min(1, rest));
  if (invA === 0 || invB === 0) e = 0;                 // 拖拽/锁定方：吸能，不弹飞
  if (vn >= -COLLISION_MIN_APPROACH) e = 0;            // 低速接近不弹（原项目门槛为 0，即分离帧不注入动量）
  const sumInv = invA + invB;
  if (sumInv <= 0) return [0, 0, 0, 0];
  let jn = -(1 + e) * vn / sumInv;
  const maxJ = cap / Math.max(invA, invB || 1e-9);
  if (maxJ > 0) jn = Math.min(jn, maxJ);
  // 切向摩擦（库仑）
  const tx = -ny, ty = nx;
  const vt = vrx * tx + vry * ty;
  let jt = 0;
  if (Math.abs(vt) > 1e-6 && fric > 0) {
    const jtIdeal = -vt / sumInv;
    const muMax = fric * Math.abs(jn);
    jt = Math.max(-muMax, Math.min(muMax, jtIdeal));
  }
  const jx = jn * nx + jt * tx, jy = jn * ny + jt * ty;
  return [-jx * invA, -jy * invA, jx * invB, jy * invB];
}

/**
 * 撞击力度→击退强度 gain∈[0,1)，连续无阈值：approach/(approach+SOFT)。
 * approach 是碰撞前法向接近速度；gain 越大：吃下初速越大、阻尼越小、击退越久。
 */
function impactPassGain(approach: number): number {
  return approach <= 0 ? 0 : approach / (approach + KNOCK_SOFT);
}

/** 位置分离（对齐 calculate_position_separation）。 */
function positionSep(overlap: number, nx: number, ny: number,
  invA: number, invB: number, forceFull: boolean): [number, number, number, number] {
  const sumInv = invA + invB;
  if (sumInv <= 0) return [0, 0, 0, 0];
  const eff = Math.max(0, overlap - 0.5);
  let sepDist: number;
  if (forceFull) sepDist = Math.min(overlap, 12 * 4);
  else sepDist = Math.max(1, Math.min(12, eff * 0.6));
  const fa = invA / sumInv, fb = invB / sumInv;
  return [-nx * sepDist * fa, -ny * sepDist * fa, nx * sepDist * fb, ny * sepDist * fb];
}

/**
 * 多体碰撞求解：只有「扔出飞行中」的宠物触发碰撞 —— 静止放置 / 拖拽中的宠物
 * 互不推开（可重叠，放置动作不触发物理）；但飞行的宠物撞到静止宠物时，
 * 静止方按真实质量参与求解被撞开（拖拽/锁定方为无限质量固定）。
 * 每对碰撞独立计时：主动碰撞重置 CONTACT_TTL，之后倒计时；末段(FADE_TAIL)
 * 分离力度渐弱到 0，到期该对允许重叠（不再强行推开）。返回达到事件阈值的碰撞（供变形）。
 */
export function resolveCollisions(bodies: Body[], cfg: Config, dt = 0): CollisionEvent[] {
  // 恢复系数/摩擦取配置（缺省对齐原项目 0.995 / 0）。旧默认 0.82/0.08 迁移到对齐值，
  // 避免已存在的 config.json 仍带着上一版「小反弹」参数（HMR 不重载 Rust 侧配置内存）。
  const restRaw = cfg.collision_restitution ?? COLLISION_RESTITUTION;
  const fricRaw = cfg.collision_friction ?? COLLISION_FRICTION;
  const rest = restRaw === 0.82 ? COLLISION_RESTITUTION : restRaw;
  const fric = fricRaw === 0.08 ? COLLISION_FRICTION : fricRaw;
  const cap = cfg.collision_impulse_cap ?? COLLISION_IMPULSE_CAP;
  const n = bodies.length;
  if (n < 2) return [];

  // 每对独立倒计时
  for (const [k, t] of contacts) { const nt = t - dt; if (nt > 0) contacts.set(k, nt); else contacts.delete(k); }

  // 1. 收集 pair（至少一方飞行中，或该对仍在生效期；双方静止时末段 fade 渐弱）
  // 同时记录碰撞前的飞行状态与法向接近速度：用于区分主动撞击方 / 被动被撞方。
  type Pair = { a: Body; b: Body; nx: number; ny: number; overlap: number; fade: number;
    flyA: boolean; flyB: boolean; approach: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bodies[i], b = bodies[j];
      const fa = flying(a), fb = flying(b);
      const grace = contacts.get(pairKey(a, b)) ?? 0;
      if (!fa && !fb && grace <= 0) continue; // 生效期结束且都静止 → 允许重叠
      const fade = !fa && !fb ? Math.min(1, grace / FADE_TAIL) : 1;
      // AABB 快速排除
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      const add = (nx: number, ny: number, overlap: number) => {
        const approach = -((b.vx - a.vx) * nx + (b.vy - a.vy) * ny); // >0 = 正在接近
        pairs.push({ a, b, nx, ny, overlap, fade, flyA: fa, flyB: fb, approach });
      };
      if (Math.abs(ax - bx) >= a.w / 2 + b.w / 2 && Math.abs(ay - by) >= a.h / 2 + b.h / 2) {
        const sw = swept(a, b);
        if (!sw) continue;
        add(sw[0], sw[1], 1);
        continue;
      }
      const [hit, nx, ny, ov] = collide(a, b);
      if (hit && ov > 0) add(nx, ny, ov);
    }
  }
  if (!pairs.length) return [];

  // 2. 速度冲量（仅飞行方；发生实际冲量=主动碰撞 → 重置该对生效时间）
  // 被动方（碰撞前静止/低速、被撞的那一方）按撞击力度衰减吃下的速度：
  // 轻撞→几乎不吃速度（只靠下方位置分离位移），重撞→吃满被撞飞落地。
  // 双方都在飞（主动对撞）不衰减，保持原项目弹性手感。
  const events: CollisionEvent[] = [];
  for (const p of pairs) {
    if (!flying(p.a) && !flying(p.b)) continue;
    const [dax, day, dbx, dby] = solveImpulse(p.a, p.b, p.nx, p.ny, rest, fric, cap);
    if (Math.abs(dax) + Math.abs(day) + Math.abs(dbx) + Math.abs(dby) > 1e-6) {
      contacts.set(pairKey(p.a, p.b), CONTACT_TTL); // 主动碰撞 → 重新计时
    }
    const bothFly = p.flyA && p.flyB;
    const gain = bothFly ? 1 : impactPassGain(p.approach);
    // 飞行方=主动撞击方 → 全额吃下冲量；静止方=被撞方 → 按力度 gain 吃下，
    // 并进入击退态（knock=gain、knockDamp 随力度反比）。加速度与衰减都是力度的连续函数，
    // 没有任何"够不够阈值就整份吃/丢"的 snap。位移由速度积分产生（比单纯位置分离更自然）。
    p.a.vx += dax * (p.flyA ? 1 : gain); p.a.vy += day * (p.flyA ? 1 : gain);
    p.b.vx += dbx * (p.flyB ? 1 : gain); p.b.vy += dby * (p.flyB ? 1 : gain);
    if (!bothFly) {
      // 被撞方进入/加强击退态（多次撞取更强者，阻尼取对应力度）
      if (!p.flyA && gain > p.a.knock) { p.a.knock = gain; p.a.knockDamp = KNOCK_DAMP * Math.pow(1 - gain, 3); }
      if (!p.flyB && gain > p.b.knock) { p.b.knock = gain; p.b.knockDamp = KNOCK_DAMP * Math.pow(1 - gain, 3); }
    }
    const ka = p.flyA ? 1 : gain, kb = p.flyB ? 1 : gain;
    const impulse = Math.hypot(dax * ka, day * ka) * Math.max(1e-6, p.a.mass) * 0.5
      + Math.hypot(dbx * kb, dby * kb) * Math.max(1e-6, p.b.mass) * 0.5;
    if (impulse > EVENT_MIN_IMPULSE) {
      events.push({ a: p.a.tag, b: p.b.tag, impulse: Math.min(cap * 0.5, impulse) });
    }
  }

  // 3. 迭代位置分离（只推飞行方；最多 4 轮）
  const pos = new Map<Body, [number, number]>();
  const total = new Map<Body, [number, number]>();
  for (const b of bodies) { pos.set(b, [b.x, b.y]); total.set(b, [0, 0]); }
  for (let iter = 0; iter < 4; iter++) {
    const cur: { ov: number; p: typeof pairs[number]; nx: number; ny: number }[] = [];
    for (const p of pairs) {
      const [x1, y1] = pos.get(p.a)!, [x2, y2] = pos.get(p.b)!;
      const [hit, nx, ny, ov] = collide(p.a, p.b, x1, y1, x2, y2);
      if (hit && ov > 0.5) cur.push({ ov, p, nx, ny });
    }
    if (!cur.length) break;
    cur.sort((u, v) => v.ov - u.ov);
    for (const c of cur) {
      const invA = c.p.a.infinite ? 0 : 1 / Math.max(1e-6, c.p.a.mass);
      const invB = c.p.b.infinite ? 0 : 1 / Math.max(1e-6, c.p.b.mass);
      const [dxa, dya, dxb, dyb] = positionSep(c.ov, c.nx, c.ny, invA, invB, false);
      const f = c.p.fade; // 末段渐弱：分离力度随剩余生效时间降到 0
      const pa = pos.get(c.p.a)!, pb = pos.get(c.p.b)!;
      pa[0] += dxa * f; pa[1] += dya * f; pb[0] += dxb * f; pb[1] += dyb * f;
      const ta = total.get(c.p.a)!, tb = total.get(c.p.b)!;
      ta[0] += dxa * f; ta[1] += dya * f; tb[0] += dxb * f; tb[1] += dyb * f;
    }
  }
  for (const b of bodies) { const [dx, dy] = total.get(b)!; b.x += dx; b.y += dy; }
  return events;
}
