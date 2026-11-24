<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/vue';
import { iconSvg } from '../../data/icons';
import {
  S, assetUrl, addClone, reduceClone, setEnabled, openDialog, resetScale, setScale,
  exportDsh, writeDsh, type RoleView,
} from './store';

const props = defineProps<{ role: RoleView }>();
const live = ref(Math.round(props.role.scale * 100));
watch(() => props.role.scale, (v) => { live.value = Math.round(v * 100); });
const pct = computed(() => `${Math.round(((live.value - 30) / 90) * 100)}%`);
const onInput = (e: Event) => { live.value = Number((e.target as HTMLInputElement).value); };
const onChange = () => setScale(props.role.id, live.value / 100);

// ··· 下拉：共享状态保证同时只开一个；floating-ui 定位 + Teleport 到 body 避免被卡片 overflow 裁剪
const moreRef = ref<HTMLElement | null>(null);
const floatRef = ref<HTMLElement | null>(null);
const { floatingStyles } = useFloating(moreRef, floatRef, {
  placement: 'bottom-end',
  middleware: [offset(6), flip(), shift({ padding: 8 })],
  whileElementsMounted: autoUpdate,
});
const moreOpen = computed(() => S.openMoreId === props.role.id);
function toggleMore() { S.openMoreId = moreOpen.value ? '' : props.role.id; }

function onDocClick(e: MouseEvent) {
  if (!S.openMoreId) return;
  const t = e.target as HTMLElement;
  if (t.closest && (t.closest('.more-menu') || t.closest('.more-btn'))) return;
  S.openMoreId = '';
}
function onBlur() { S.openMoreId = ''; }
window.addEventListener('click', onDocClick);
window.addEventListener('blur', onBlur);
onBeforeUnmount(() => {
  window.removeEventListener('click', onDocClick);
  window.removeEventListener('blur', onBlur);
});
function dshAction(kind: 'import' | 'export') {
  S.openMoreId = '';
  if (kind === 'import') writeDsh(props.role.id); else exportDsh(props.role.id);
}
</script>

<template>
  <article class="role-card" :data-id="role.id" @mouseenter="S.hoverId = role.id" @mouseleave="S.hoverId = ''">
    <div class="card-preview" :style="{ background: role.gradient }">
      <span class="state-badge" :class="{ on: role.enabled }">{{ role.status }}</span>
      <video v-if="role.cover" class="cover-video" :src="assetUrl(role.cover.src)"
        autoplay loop muted playsinline></video>
      <div v-else class="cover-empty">暂无预览</div>
    </div>

    <div class="card-title-row">
      <div>
        <div class="role-name">{{ role.name }}</div>
        <div class="role-count">{{ role.count }} 个动作</div>
      </div>
      <button class="sw" :style="{ '--sw': role.theme }" :class="{ on: role.enabled }"
        :title="role.enabled ? '隐藏这只桌宠' : '显示这只桌宠'" :aria-label="role.enabled ? '隐藏这只桌宠' : '显示这只桌宠'"
        @click="setEnabled(role.id, !role.enabled)"><span class="sw-knob"></span></button>
    </div>

    <div class="card-actions">
      <button @click="openDialog({ type: 'actions', packId: role.id, tab: '查看动作' })">查看动作</button>
      <button @click="addClone(role.id)">添加分身</button>
      <button @click="reduceClone(role.id)" :disabled="!role.clones.length">减少分身</button>
      <button ref="moreRef" class="more-btn" :class="{ on: moreOpen }" title="更多操作"
        @click.stop="toggleMore" v-html="iconSvg('more', 16)"></button>
    </div>

    <Teleport to="body">
      <div v-if="moreOpen" ref="floatRef" class="more-menu" :style="floatingStyles" @click.stop>
        <button @click="dshAction('import')"><span class="mi" v-html="iconSvg('download', 14)"></span>导入到dsh-pet</button>
        <button @click="dshAction('export')"><span class="mi" v-html="iconSvg('save', 14)"></span>导出文件dsh-pet</button>
      </div>
    </Teleport>

    <div class="card-scale">
      <span class="scale-label">大小</span>
      <input type="range" min="30" max="120" :value="live" :style="{ '--sw': role.theme, '--p': pct }"
        @input="onInput" @change="onChange" />
      <span class="scale-value">{{ live }}%</span>
      <button class="reset-link" @click="resetScale(role.id)">恢复</button>
    </div>
  </article>
</template>
