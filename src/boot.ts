// 窗口可能在 Tauri setup() 完成前就加载，首个 IPC 会挂起或报错；等到 AppState 就绪。
import { api } from './bridge';
import { defaultConfig, mergeConfig } from './data/defaults';
import type { Config } from './types';

const timeout = (ms: number) =>
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('IPC 超时')), ms));

export async function loadConfig(): Promise<Config> {
  for (let i = 0; i < 20; i++) {
    try {
      return mergeConfig(await Promise.race([api.config(), timeout(1200)]));
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return defaultConfig();
}
