import './styles.css';
import './ui/vue/style.css';

// 每个窗的 URL 都显式带 ?view=（settings/overlay/todo），以它为准。
// 不能用 getCurrentWindow().label 判定：WebView 刚起时该 IPC 可能拿不到 label。
const urlView = new URLSearchParams(location.search).get('view');
const known = ['settings', 'overlay', 'todo', 'menu'];
const view = urlView && known.includes(urlView) ? urlView : 'overlay';
document.body.dataset.view = view;
const boot = view === 'settings'
  ? () => import('./ui/vue/main').then((m) => m.start())
  : view === 'todo'
    ? () => import('./ui/todo/main').then((m) => m.start())
    : view === 'menu'
      ? () => import('./ui/menu/main').then((m) => m.start())
      : () => import('./pet/engine').then((m) => m.start());
boot().catch((e) => console.error('启动失败', e));
