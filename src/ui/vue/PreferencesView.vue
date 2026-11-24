<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { S } from './store';

const host = ref<HTMLElement | null>(null);

// 11 域设置系统仍是原生的（widgets/menu-editor），Vue 只做页面容器与生命周期。
// 配置直接用主界面已加载的 S.cfg，不再 await loadConfig()——后者在 IPC 偶发超时时
// 会重试 20 次（近 30 秒），切到偏好设置就白屏几十秒。
let started = false;
onMounted(async () => {
  if (started) return;
  started = true;
  const { SettingsApp } = await import('../settings');
  const app = new SettingsApp(S.cfg);
  (window as unknown as { __settings: unknown }).__settings = app;
  if (host.value) await app.start(host.value);
});
</script>

<template>
  <div ref="host" class="prefs-host"></div>
</template>
