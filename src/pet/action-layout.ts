// 动作布局：用户在「查看动作」里拖动排序、眼睛显隐的结果，统一驱动弹窗与右键菜单。
// 落本地 data/character_action_layout.json；clip.category 不受影响，仅作用于显示。
export interface ActionLayout {
  catOrder: string[];    // viewCategory 分类 key 的显示顺序
  clipOrder: string[];   // 动作名的显示顺序（全局，跨分类拖动也据此排）
  hiddenCats: string[];  // 隐藏的分类 key
  hiddenClips: string[]; // 隐藏的动作名
}

export const emptyLayout = (): ActionLayout => ({ catOrder: [], clipOrder: [], hiddenCats: [], hiddenClips: [] });

const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** 容忍旧数据/手工编辑；缺字段一律回退空，交给调用方用默认顺序补齐。 */
export function normLayout(v: unknown): ActionLayout {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  return {
    catOrder: arr(o.catOrder), clipOrder: arr(o.clipOrder),
    hiddenCats: arr(o.hiddenCats), hiddenClips: arr(o.hiddenClips),
  };
}

export const isLayoutEmpty = (l: ActionLayout) =>
  !l.catOrder.length && !l.clipOrder.length && !l.hiddenCats.length && !l.hiddenClips.length;
