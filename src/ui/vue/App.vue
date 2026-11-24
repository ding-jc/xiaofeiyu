<script setup lang="ts">
import { onMounted } from 'vue';
import Sidebar from './Sidebar.vue';
import CharactersView from './CharactersView.vue';
import PreferencesView from './PreferencesView.vue';
import DialogHost from './DialogHost.vue';
import { S, STAGE_LABEL, init } from './store';

onMounted(() => {
  init();
  // 窗口被隐藏时（关闭 = hide）停掉主界面的所有视频解码。
  document.addEventListener('visibilitychange', () => {
    document.querySelectorAll<HTMLVideoElement>('video').forEach((v) => {
      if (document.hidden) v.pause();
      else if (v.classList.contains('cover-video')) v.play().catch(() => {});
    });
  });
});
</script>

<template>
  <div class="home-app">
    <Sidebar />
    <main class="home-main">
      <!-- 常驻不销毁：偏好设置首次挂载要走异步 import + IPC，反复 v-if 重建导致切 tab 白屏几十秒 -->
      <div class="view-slot" v-show="S.tab === '我的角色'"><CharactersView /></div>
      <div class="view-slot" v-show="S.tab === '偏好设置'"><PreferencesView /></div>
    </main>
    <DialogHost />
    <Transition name="toast"><div v-if="S.toast" class="home-toast">{{ S.toast }}</div></Transition>
    <Transition name="progress">
      <div v-if="S.progress" class="progress-mask">
        <div class="progress-card">
          <div class="progress-ring">
            <svg viewBox="0 0 60 60">
              <circle class="ring-bg" cx="30" cy="30" r="26" />
              <circle class="ring-fg" cx="30" cy="30" r="26"
                :stroke-dashoffset="163.4 * (1 - S.progress.percent / 100)" />
            </svg>
            <div class="progress-pct">{{ S.progress.percent }}%</div>
          </div>
          <div class="progress-title">{{ S.progress.title }}</div>
          <div class="progress-stage">{{ STAGE_LABEL[S.progress.stage] || S.progress.stage }}</div>
          <div class="progress-detail">{{ S.progress.detail }}</div>
          <div class="progress-bar"><div class="progress-bar-fill" :style="{ width: S.progress.percent + '%' }" /></div>
        </div>
      </div>
    </Transition>
    <div v-if="!S.ready" class="home-loading">正在唤醒桌宠…</div>
  </div>
</template>
