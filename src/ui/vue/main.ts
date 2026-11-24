// 主界面（设置窗）由 Vue 渲染；壁纸层仍是零框架的原生 TS 引擎。
import { createApp } from 'vue';
import App from './App.vue';

export async function start() {
  // 主界面去掉 WebView 默认右键菜单（原生桌面应用没有浏览器菜单）；
  // 输入框保留系统编辑菜单，保证复制 / 粘贴可用。
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  }, true);
  createApp(App).mount('#app');
}
