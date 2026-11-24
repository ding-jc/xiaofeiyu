// 待办独立窗：CRUD 面板在这里；到期提醒由壁纸层世界的 TodoScheduler 统一跑。
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadConfig } from '../../boot';
import { TodoPanel } from '../todo';

export async function start() {
  const host = document.getElementById('app');
  if (!host) return;
  const cfg = await loadConfig();
  new TodoPanel(host, () => cfg, () => { getCurrentWindow().close().catch(() => {}); });
}
