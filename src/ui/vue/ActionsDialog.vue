<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Container, Draggable, type DropResult } from 'vue3-smooth-dnd';
import { api } from '../../bridge';
import { CATEGORY_LABELS as LABELS, viewCategory } from '../../pet/catalog';
import { iconSvg } from '../../data/icons';
import type { Clip } from '../../types';
import {
  S, allClips, assetUrl, byId, closeDialog, saveActionLayout, toast,
  type DialogState,
} from './store';

const d = computed(() => S.dialog as DialogState);
const role = computed(() => byId(d.value.packId));
const clips = computed(() => role.value ? allClips(role.value.pack) : []);
const packId = computed(() => d.value.packId);

// 本地布局草稿：拖动/显隐改这里，并即时落盘同步右键菜单
const layout = reactive({
  catOrder: [] as string[], clipOrder: [] as string[],
  hiddenCats: [] as string[], hiddenClips: [] as string[],
});
function hydrateLayout() {
  const saved = S.actionLayouts[packId.value];
  layout.catOrder = saved ? [...saved.catOrder] : [];
  layout.clipOrder = saved ? [...saved.clipOrder] : [];
  layout.hiddenCats = saved ? [...saved.hiddenCats] : [];
  layout.hiddenClips = saved ? [...saved.hiddenClips] : [];
}
hydrateLayout();
const persist = () => saveActionLayout(packId.value, {
  catOrder: [...layout.catOrder], clipOrder: [...layout.clipOrder],
  hiddenCats: [...layout.hiddenCats], hiddenClips: [...layout.hiddenClips],
});

const current = ref<Clip | null>(d.value.clip ?? clips.value[0] ?? null);
function choose(c: Clip) {
  current.value = c;
  api.broadcast('home-preview', { character: packId.value, src: c.src, name: c.name }).catch(() => {});
}

// 分类顺序：先按用户拖动顺序，未列入的按素材视图分类首次出现顺序
const catKeys = computed(() => {
  const seen: string[] = [];
  for (const c of clips.value) { const k = viewCategory(packId.value, c); if (!seen.includes(k)) seen.push(k); }
  const known = layout.catOrder.filter((k) => seen.includes(k));
  return [...known, ...seen.filter((k) => !known.includes(k))];
});
// 每个分类下的动作：按用户拖动顺序，未列入的按素材原顺序
const clipsOf = (cat: string): Clip[] => {
  const list = clips.value.filter((c) => viewCategory(packId.value, c) === cat);
  const known = layout.clipOrder.filter((n) => list.some((c) => c.name === n));
  const sorted = [...list].sort((a, b) => {
    const ia = known.indexOf(a.name), ib = known.indexOf(b.name);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return 0;
  });
  return sorted;
};
const labelOf = (k: string) => LABELS[k] ?? k;

// 第一个正常显示（未被隐藏）的分类
const firstVisibleCat = () => catKeys.value.find((k) => !layout.hiddenCats.includes(k)) ?? '';
// 手风琴：默认展开第一个正常显示的分类，点分类头切换，同一时刻只展开一个
const openCat = ref<string>(firstVisibleCat());
watch(catKeys, (keys) => { if (!keys.includes(openCat.value)) openCat.value = firstVisibleCat(); });
function toggleFold(cat: string) { openCat.value = openCat.value === cat ? '' : cat; }

// 展开弹窗 / 隐藏全部：含第一个可见动作的分类滚到列表顶部，该动作滚到分类顶部
const listEl = ref<HTMLElement | null>(null);
let scrollTimer = 0;
function scrollFirstToTop() {
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    const root = listEl.value;
    const group = root?.querySelector('.clip-group.open') as HTMLElement | null;
    const body = group?.querySelector('.clip-group-body') as HTMLElement | null;
    const item = body?.querySelector('.clip-item:not(.hidden)') as HTMLElement | null;
    if (!root || !group || !body || !item) return;
    // 先算好两层目标值再触发动画：外层滚动会改变内层 rect，边算边滚会算错
    const ir = item.getBoundingClientRect(), br = body.getBoundingClientRect();
    const gr = group.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const bodyTop = body.scrollTop + ir.top - br.top;
    const rootTop = root.scrollTop + gr.top - rr.top;
    body.scrollTo({ top: bodyTop, behavior: 'smooth' });
    root.scrollTo({ top: rootTop, behavior: 'smooth' });
  }, 280);
}
onMounted(scrollFirstToTop);

// 显隐
const catHidden = (k: string) => layout.hiddenCats.includes(k);
const clipHidden = (n: string) => layout.hiddenClips.includes(n);
// 剩余可见动作数：按「具体动作」计数，分类本身不算一个动作。
// 一个动作可见当且仅当：自身未被单独隐藏，且其所属分类未被隐藏——
// 分类被隐藏会连带其内部所有动作都不可见，故隐藏分类内的动作不能算作可见。
function visibleAfter(hiddenCats: string[], hiddenClips: string[]): number {
  const hc = new Set(hiddenClips), hcat = new Set(hiddenCats);
  return clips.value.filter((c) => !hc.has(c.name) && !hcat.has(viewCategory(packId.value, c))).length;
}
function toggleCat(k: string) {
  const hiding = !catHidden(k);
  const next = hiding ? [...layout.hiddenCats, k] : layout.hiddenCats.filter((x) => x !== k);
  if (hiding && visibleAfter(next, layout.hiddenClips) === 0) { toast('至少要保留一个可见动作'); return; }
  layout.hiddenCats = next;
  persist();
}
function toggleClip(n: string) {
  const hiding = !clipHidden(n);
  const next = hiding ? [...layout.hiddenClips, n] : layout.hiddenClips.filter((x) => x !== n);
  if (hiding && visibleAfter(layout.hiddenCats, next) === 0) { toast('至少要保留一个可见动作'); return; }
  layout.hiddenClips = next;
  persist();
}
// 批量隐藏：保留待机分类的第一个动作可见（其余分类与动作全隐藏）
function hideAll() {
  const idleClips = clipsOf('idle');
  const keep = idleClips[0] ?? clips.value[0];
  // 保留项所属分类不能进 hiddenCats，否则分类连带隐藏会把它也变成不可见
  const keepCat = keep ? viewCategory(packId.value, keep) : '';
  layout.hiddenCats = catKeys.value.filter((k) => k !== keepCat);
  layout.hiddenClips = clips.value.filter((c) => c.name !== keep?.name).map((c) => c.name);
  openCat.value = firstVisibleCat();
  persist();
  scrollFirstToTop();
  toast(keep ? `已隐藏，保留待机「${keep.name}」` : '已全部隐藏');
}
function showAll() {
  layout.hiddenCats = [];
  layout.hiddenClips = [];
  persist();
  toast('已全部显示');
}

// smooth-dnd：仅动作项可拖动排序（分类不参与拖拽），拖动只从 grip 手柄发起
const clipPayload = (cat: string) => (i: number) => clipsOf(cat)[i]?.name;
function applyMove(list: string[], r: DropResult): string[] {
  const out = [...list];
  if (r.removedIndex == null) return out;
  const [moved] = out.splice(r.removedIndex, 1);
  if (moved === undefined) return out;
  if (r.addedIndex != null) out.splice(r.addedIndex, 0, moved);
  return out;
}
function onClipDrop(cat: string, r: DropResult) {
  if (r.removedIndex == null || r.addedIndex == null) return;
  const names = applyMove(clipsOf(cat).map((c) => c.name), r);
  // 写回全局 clipOrder：按当前分类顺序拼接，目标分类用新序
  const full: string[] = [];
  for (const k of catKeys.value) full.push(...(k === cat ? names : clipsOf(k).map((c) => c.name)));
  layout.clipOrder = full;
  persist();
}

</script>

<template>
  <div class="dlg">
    <div class="dlg-head">
      <h2>{{ role?.name }}</h2>
      <span class="dlg-sub">{{ clips.length }} 个动作 · {{ catKeys.length }} 个分类（拖动排序，眼睛控制显示）</span>
      <button class="dlg-x" @click="closeDialog">×</button>
    </div>

    <div class="dlg-body dlg-grid">
      <div class="dlg-panel">
        <div class="clip-toolbar">
          <span>动作列表</span>
          <div class="toolbar-actions">
            <button class="eye-all" @click="hideAll">
              <span class="mi" v-html="iconSvg('hide', 14)"></span>隐藏全部
            </button>
            <button class="eye-all" @click="showAll">
              <span class="mi" v-html="iconSvg('eye', 14)"></span>显示全部
            </button>
          </div>
        </div>
        <div class="clip-list" ref="listEl">
          <div v-for="cat in catKeys" :key="cat" class="clip-group" :class="{ hidden: catHidden(cat), open: openCat === cat }">
            <div class="clip-group-head" @click="toggleFold(cat)">
              <span class="fold-caret" :class="{ open: openCat === cat }" v-html="iconSvg('back', 13)"></span>
              <b>{{ labelOf(cat) }} · {{ clipsOf(cat).length }}</b>
              <button class="eye-btn" :class="{ off: catHidden(cat) }"
                :title="catHidden(cat) ? '显示该分类' : '隐藏该分类'" @click.stop="toggleCat(cat)"
                v-html="iconSvg(catHidden(cat) ? 'hide' : 'eye', 18)"></button>
            </div>
            <div class="acc-wrap" :class="{ open: openCat === cat }">
              <div class="acc-inner">
                <div class="clip-group-body">
                  <Container :group-name="`anim-clips-${cat}`" drag-handle-selector=".clip-grip"
                    :get-child-payload="clipPayload(cat)" @drop="(r) => onClipDrop(cat, r)">
                    <Draggable v-for="c in clipsOf(cat)" :key="c.name">
                      <div class="clip-item" :class="{ on: current?.name === c.name, hidden: clipHidden(c.name) || catHidden(cat) }"
                        @click="choose(c)">
                        <span class="grip clip-grip" title="拖动排序" v-html="iconSvg('grip', 12)"></span>
                        <span class="clip-name">{{ c.name }}</span>
                        <button class="eye-btn" :class="{ off: clipHidden(c.name) }"
                          :title="clipHidden(c.name) ? '显示该动作' : '隐藏该动作'" @click.stop="toggleClip(c.name)"
                          v-html="iconSvg(clipHidden(c.name) ? 'hide' : 'eye', 18)"></button>
                      </div>
                    </Draggable>
                  </Container>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="dlg-panel">
        <h4>预览</h4>
        <div class="preview-box" :style="{ background: role?.gradient }">
          <video v-if="current" :key="current.src" :src="assetUrl(current.src)" autoplay muted playsinline></video>
          <span v-else>选择一个动作开始预览</span>
        </div>
        <p class="preview-name">{{ current?.name ?? '—' }}</p>
      </div>
    </div>

    <div class="dlg-foot">
      <button class="btn-soft" @click="closeDialog">关闭</button>
    </div>
  </div>
</template>
