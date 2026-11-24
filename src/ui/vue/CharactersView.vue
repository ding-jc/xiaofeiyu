<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CharacterCard from './CharacterCard.vue';
import { S, roles, activeCount, enableAll, hideAll, openDialog, setAllSizes, anyCustomScale } from './store';

// 只解码视口内的角色预览，滚出视口即暂停，避免多角色时多路 WebM 同时解码。
let io: IntersectionObserver | null = null;
function bindVideos() {
  io?.disconnect();
  const root = document.querySelector('.home-scroll');
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) v.play().catch(() => {});
      else v.pause();
    }
  }, { root, threshold: 0.02 });
  document.querySelectorAll<HTMLVideoElement>('.cover-video').forEach((v) => io!.observe(v));
}
onMounted(() => {
  watch(() => [S.ready, roles.value.length], () => nextTick(bindVideos), { immediate: true, flush: 'post' });
});
onBeforeUnmount(() => io?.disconnect());

// 全局大小：统一调整全部角色；有角色被单独设置过时滑块黯淡禁用
const gLive = ref(70);
// 滑块反映已保存的配置：取当前生效宠物的实际大小（与角色卡片一致），而不是永远 70。
// 设置窗是运行时新建的 WebView，每次 init 都会重新读盘，这里跟着 S.ready / 角色变化同步。
watch([() => S.ready, () => S.cfg.pets, () => anyCustomScale.value], () => {
  if (!S.ready || anyCustomScale.value) return;
  const v = S.cfg.pets[0]?.scale ?? S.meta[roles.value[0]?.id ?? '']?.scale;
  if (typeof v === 'number') gLive.value = Math.round(v * 100);
}, { immediate: true });
const gPct = computed(() => `${Math.round(((gLive.value - 30) / 90) * 100)}%`);
const onGlobalInput = (e: Event) => { gLive.value = Number((e.target as HTMLInputElement).value); };
const applyGlobal = () => setAllSizes(gLive.value / 100);
</script>

<template>
  <div class="home-scroll">
    <header class="page-head">
      <div class="stat-row">
        <span class="stat-chip">{{ roles.length }} 位角色</span>
        <span class="stat-chip">{{ activeCount ? `${activeCount} 只陪伴中` : '都在休息' }}</span>
      </div>
      <div class="head-actions">
        <button class="btn-primary" @click="openDialog({ type: 'add', packId: '' })">
          <span>＋</span> 添加角色
        </button>
      </div>
    </header>

    <div class="filter-bar">
      <div class="filter-left">
        <button @click="enableAll">全部开启</button>
        <button @click="hideAll">全部隐藏</button>
        <span class="filter-sep"></span>
        <button v-if="anyCustomScale" class="gs-unify-btn" @click="applyGlobal"
          title="点击重新统一全部角色大小">设置全部大小</button>
        <div v-else class="global-scale" title="统一调整全部角色大小">
          <span class="gs-label">全部大小</span>
          <input type="range" min="30" max="120" :value="gLive"
            :style="{ '--p': gPct }" @input="onGlobalInput" @change="applyGlobal" />
          <span class="gs-value">{{ gLive }}%</span>
        </div>
      </div>
    </div>

    <div class="role-grid">
      <CharacterCard v-for="r in roles" :key="r.id" :role="r" />
      <div v-if="roles.length > 0 && roles.length < 3" class="role-invite"
        @click="openDialog({ type: 'add', packId: '' })">
        <b>＋</b>
        <span>添加更多角色</span>
        <small>导入视频 + JSON 素材包<br />或把文件夹 / zip 拖进窗口</small>
      </div>
      <div v-if="!roles.length" class="grid-empty">
        还没有角色，点右上角「添加角色」导入视频 + JSON 素材包，或直接把文件夹 / zip 拖进窗口。
      </div>
    </div>
  </div>
</template>
