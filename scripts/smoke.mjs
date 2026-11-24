// 端到端冒烟测试：通过 WebView2 CDP 直接查询运行中的浮层 DOM 与 Tauri IPC 结果。
// 启动应用前需设置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// 用法：node scripts/smoke.mjs [端口]
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.argv[2] || process.env.CDP_PORT || '9333';
const BASE = `http://127.0.0.1:${PORT}`;

const targets = async () => {
  const r = await fetch(`${BASE}/json/list`);
  if (!r.ok) throw new Error(`CDP /json/list 返回 ${r.status}`);
  return r.json();
};

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const evaluate = (expression, awaitPromise = false) => new Promise((ok, fail) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) return fail(new Error(JSON.stringify(m.error)));
      const r = m.result;
      if (r?.exceptionDetails) return fail(new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      ok(r?.result?.value);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
  });
  return { ws, evaluate };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const list = await targets();
const overlay = list.find((t) => t.type === 'page' && (t.url.includes('view=overlay')
  || (t.url.includes('tauri.localhost') && !t.url.includes('view=settings'))));
if (!overlay) throw new Error('未找到浮层页面，请确认应用已启动且 CDP 端口正确');
console.log(`已连接：${overlay.title} (${overlay.url})\n`);

const { ws, evaluate } = await connect(overlay);

// 单浮层：不应再出现壁纸层窗口
const wallTargets = list.filter((t) => t.url.includes('view=wallpaper') || t.url.includes('label=wallpaper'));
check('壁纸层窗口已移除', wallTargets.length === 0, `found=${JSON.stringify(wallTargets.map((t) => t.url))}`);

// 等浮层异步 chunk 执行完再断言（WebView2 可能在页面加载完成前就暴露 CDP target）
for (let i = 0; i < 20; i++) {
  const n = await evaluate(`document.querySelectorAll('.pet').length`).catch(() => 0);
  if (n >= 1) break;
  await delay(500);
}
const expectPets = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.length)`, true)
  .catch(() => 1) || 1;

// 1) 多桌宠 DOM
const dom = await evaluate(`(() => ({
  pets: document.querySelectorAll('.pet').length,
  ids: [...document.querySelectorAll('.pet')].map(e => e.dataset.id),
  videos: document.querySelectorAll('video').length,
  srcs: [...document.querySelectorAll('video')].map(v => v.currentSrc || v.src).filter(Boolean),
  island: !!document.querySelector('.island'),
  todo: !!document.querySelector('.todo'),
  layer: !!document.getElementById('pet-layer')
}))()`);
check('浮层根节点', !!dom?.layer);
check('桌宠实例数与配置一致', dom?.pets === expectPets,
  `expected=${expectPets} pets=${dom?.pets} ids=${JSON.stringify(dom?.ids)}`);
check('每宠 A/B 双缓冲视频', dom?.videos === expectPets * 2, `videos=${dom?.videos}`);
const bound = (dom?.srcs || []).filter((s) => s.includes('pet.localhost/')).length;
check('视频已绑定 pet.localhost 素材', bound >= 1, `${bound} 路`);
check('灵动岛 / 待办组件已挂载', !!(dom?.island || dom?.todo), `island=${dom?.island} todo=${dom?.todo}`);

// 2) 视频素材真的能被解码（ERR_UNKNOWN_URL_SCHEME 会留下 MEDIA_ERR_SRC_NOT_SUPPORTED）
const vstate = await evaluate(`[...document.querySelectorAll('video')].map(v => ({
  err: v.error?.code ?? 0, msg: v.error?.message ?? '', ready: v.readyState, net: v.networkState
}))`);
const bad = (vstate || []).filter((v) => v.err);
check('WebM 素材请求无失败', bad.length === 0, `errors=${JSON.stringify(bad)}`);

const t1 = await evaluate(`[...document.querySelectorAll('video')].map(v => v.currentTime)`);
await delay(1600);
const t2 = await evaluate(`[...document.querySelectorAll('video')].map(v => v.currentTime)`);
const advancing = (t1 || []).filter((v, i) => (t2?.[i] ?? 0) > v + 0.01).length;
check('WebM 正在解码播放', advancing > 0, `${advancing} 路 currentTime 前进 ${JSON.stringify(t1)} → ${JSON.stringify(t2)}`);

// 3) Rust IPC：配置与素材扫描
const cfg = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => ({
  pets: c.pets.map(p => p.id)
}))`, true);
check('配置读回槽位', cfg?.pets?.length === expectPets, `pets=${JSON.stringify(cfg?.pets)}`);

// 壁纸插件命令应已不存在
const wallCmd = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:wallpaper|is_attached', {
  payload: { windowLabel: 'wallpaper' }
})`, true).then(() => 'ok').catch(() => 'missing');
check('壁纸插件命令已移除', wallCmd === 'missing', `result=${wallCmd}`);

const packs = await evaluate(`window.__TAURI_INTERNALS__.invoke('list_packs').then(ps => ps.map(p => ({
  id: p.id, clips: Object.values(p.clips).reduce((n, v) => n + v.length, 0),
  cats: Object.keys(p.clips).sort(), strides: Object.keys(p.strides).length,
  noMirror: p.no_mirror.length, bodyBox: p.body_box
})))`, true);
const p0 = packs?.slice().sort((a, b) => b.clips - a.clips)[0];
check('内置角色包被扫描', !!p0 && p0.clips >= 100, `id=${p0?.id} clips=${p0?.clips}`);
check('动画分类齐全', ['click', 'drag', 'events', 'idle', 'move', 'random', 'turn'].every((c) => p0?.cats?.includes(c)),
  JSON.stringify(p0?.cats));
check('步幅 / 不镜像 / 命中区 JSON 生效', p0?.strides > 0 && !!p0?.noMirror && !!p0?.bodyBox,
  `strides=${p0?.strides} noMirror=${p0?.noMirror} bodyBox=${JSON.stringify(p0?.bodyBox)}`);

// 4) Vue 主界面（静态窗口，show 而非重建）
const list2 = await targets();
const set = list2.find((t) => t.type === 'page' && t.url.includes('view=settings'));
if (!set) {
  check('Vue 主界面窗口存在', false, 'CDP 未出现 settings target');
} else {
  const sw = await connect(set);
  for (let i = 0; i < 20; i++) {
    const n = await sw.evaluate(`document.querySelectorAll('.role-card').length`).catch(() => 0);
    if (n > 0) break;
    await delay(400);
  }
  await sw.evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('我的角色'))?.click()`);
  await delay(350);
  const home = await sw.evaluate(`(() => {
    const txt = document.body.innerText;
    const cards = [...document.querySelectorAll('.role-card')];
    return {
      app: !!document.querySelector('.home-app'), nav: !!document.querySelector('.home-nav'),
      head: !!document.querySelector('.page-head .stat-row'),
      cards: cards.length,
      tabs: [...document.querySelectorAll('.nav-item')].map(b => b.textContent.trim()),
      filters: ['全部开启','全部隐藏'].filter(l => !txt.includes(l)),
      add: !!document.querySelector('.btn-primary'),
      badges: cards.reduce((n, c) => n + c.querySelectorAll('.state-badge').length, 0),
      switches: cards.reduce((n, c) => n + c.querySelectorAll('.card-title-row .sw').length, 0),
      sliders: cards.reduce((n, c) => n + c.querySelectorAll('input[type=range]').length, 0),
      buttons: [...cards[0]?.querySelectorAll('.card-actions button') ?? []].map(b => b.textContent.trim()),
      url: location.href,
    };
  })()`);
  check('Vue 主界面已渲染（非 about:blank）', !!home?.app && !!home?.nav && !!home?.head
    && home?.url?.includes('view=settings'),
  `app=${home?.app} nav=${home?.nav} head=${home?.head}`);
  check('侧栏两项齐全', ['我的角色','偏好设置'].every(l => home?.tabs?.includes(l)),
    `tabs=${JSON.stringify(home?.tabs)}`);
  check('标题统计 / 筛选 / 添加角色', home?.filters?.length === 0 && !!home?.add,
    `missing=${JSON.stringify(home?.filters)}`);
  check('角色卡数量与素材包一致', home?.cards === packs?.length, `cards=${home?.cards} packs=${packs?.length}`);
  check('卡片操作按钮齐全', ['查看动作','添加分身','减少分身'].every(l => home?.buttons?.some((b) => b.startsWith(l))),
    JSON.stringify(home?.buttons));
  check('每卡显示隐藏开关 / 状态标记 / 大小滑块',
    home?.switches === packs?.length && home?.badges === packs?.length && home?.sliders === packs?.length,
    `switches=${home?.switches} badges=${home?.badges} sliders=${home?.sliders}`);

  // 卡片更多菜单（Teleport + floating-ui）
  await sw.evaluate(`document.querySelector('.role-card .more-btn').click()`);
  await delay(250);
  const more = await sw.evaluate(`(() => ({
    open: !!document.querySelector('.more-menu'),
    items: [...document.querySelectorAll('.more-menu button')].map(b => b.textContent.trim()),
  }))()`);
  check('卡片更多菜单可打开', !!more?.open
    && ['导入到dsh-pet','导出文件dsh-pet'].every(l => more.items.some((t) => t.includes(l))),
  JSON.stringify(more?.items));
  await sw.evaluate(`document.body.click()`);

  // 弹窗：查看动作
  await sw.evaluate(`document.querySelector('.card-actions button').click()`);
  await delay(250);
  const dlg = await sw.evaluate(`(() => ({
    open: !!document.querySelector('.dlg'),
    list: !!document.querySelector('.clip-list'),
    sub: document.querySelector('.dlg-sub')?.textContent ?? '',
    clips: document.querySelectorAll('.clip-item').length,
  }))()`);
  check('查看动作弹窗可用', !!dlg?.open && !!dlg?.list && dlg?.clips > 0 && dlg?.sub?.includes('分类'),
    `list=${dlg?.list} clips=${dlg?.clips} sub=${dlg?.sub}`);

  // 动作弹窗：手风琴 / 批量显隐 / 双层滚动（测试结束恢复原布局）
  const layoutBefore = await sw.evaluate(`window.__TAURI_INTERNALS__.invoke('get_data', { name: 'character_action_layout' })`, true);
  const acc = await sw.evaluate(`(() => ({
    groups: document.querySelectorAll('.clip-group').length,
    open: document.querySelectorAll('.clip-group.open').length,
    allBtns: [...document.querySelectorAll('.eye-all')].map(b => b.textContent.trim()),
    listScroll: (() => { const e = document.querySelector('.clip-list'); return !!e && e.scrollHeight > e.clientHeight; })(),
    bodyScroll: [...document.querySelectorAll('.clip-group-body')].some(e => e.scrollHeight > e.clientHeight),
    eyeSize: (() => { const e = document.querySelector('.eye-btn'); return e ? Math.round(e.getBoundingClientRect().width) : 0; })(),
  }))()`);
  check('手风琴默认只展开一个分类', acc?.groups > 0 && acc?.open === 1, `groups=${acc?.groups} open=${acc?.open}`);
  check('批量显隐按钮带文字', acc?.allBtns?.length === 2
    && acc.allBtns.some((t) => t.includes('隐藏全部')) && acc.allBtns.some((t) => t.includes('显示全部')),
  JSON.stringify(acc?.allBtns));
  check('动作列表双层可滚动', !!acc?.listScroll && !!acc?.bodyScroll,
    `list=${acc?.listScroll} body=${acc?.bodyScroll}`);
  check('眼睛图标放大到 30px', acc?.eyeSize === 30, `size=${acc?.eyeSize}`);

  await sw.evaluate(`[...document.querySelectorAll('.eye-all')].find(b => b.textContent.includes('隐藏全部')).click()`);
  await delay(400);
  const hidden = await sw.evaluate(`(() => ({
    visible: document.querySelectorAll('.clip-item:not(.hidden)').length,
    hiddenCats: document.querySelectorAll('.clip-group.hidden').length,
    open: document.querySelectorAll('.clip-group.open').length
  }))()`);
  check('隐藏全部保留待机第一个动作', hidden?.visible === 1
    && hidden?.hiddenCats === acc?.groups - 1 && hidden?.open === 1, JSON.stringify(hidden));

  await sw.evaluate(`[...document.querySelectorAll('.eye-all')].find(b => b.textContent.includes('显示全部')).click()`);
  await delay(300);
  const shown = await sw.evaluate(`(() => ({
    hidden: document.querySelectorAll('.clip-item.hidden').length,
    hiddenCats: document.querySelectorAll('.clip-group.hidden').length
  }))()`);
  check('显示全部清除隐藏状态', shown?.hidden === 0 && shown?.hiddenCats === 0, JSON.stringify(shown));

  await sw.evaluate(`window.__TAURI_INTERNALS__.invoke('set_data', { name: 'character_action_layout', value: ${JSON.stringify(layoutBefore)} })`, true);
  await sw.evaluate(`document.querySelector('.dlg-x').click()`);

  // 主界面 → set_config → 浮层增量同步（测试后恢复原配置 / 元数据）
  const cfgBefore = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config')`, true);
  const metaBefore = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_data', { name: 'character_meta' })`, true);
  const before = cfgBefore.pets.length;

  // 角色开关 + 多分身：给陪伴中的角色补到 3 只 → 隐藏（记住数量）→ 打开应恢复 3 只，不是 1 只
  const swIdx = await sw.evaluate(`[...document.querySelectorAll('.role-card .card-title-row .sw')].findIndex(b => b.classList.contains('on'))`);
  if (swIdx >= 0) {
    const pid = await sw.evaluate(`document.querySelectorAll('.role-card')[${swIdx}].dataset.id`);
    const card = `document.querySelector('.role-card[data-id="${pid}"]')`;
    // 补到 3 只（受已有分身数影响，最多补到 3）
    for (let k = 0; k < 4; k++) {
      const cnt = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.filter(p => p.character === '${pid}').length)`, true);
      if (cnt >= 3) break;
      await sw.evaluate(`[...${card}.querySelectorAll('.card-actions button')].find(b => b.textContent.includes('添加分身')).click()`);
      await delay(450);
    }
    const three = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.filter(p => p.character === '${pid}').length)`, true);
    check('角色可分身到多只', three === 3, `id=${pid} clones=${three}`);

    await sw.evaluate(`${card}.querySelector('.card-title-row .sw').click()`);
    await delay(850);
    const off = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.filter(p => p.character === '${pid}').length)`, true);
    const remembered = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_data', { name: 'character_meta' }).then(m => m['${pid}']?.restore)`, true);
    check('关闭角色开关隐藏全部分身', off === 0, `clones after off=${off}`);
    check('隐藏时记住分身数量', remembered === three, `restore=${remembered} expected=${three}`);

    await sw.evaluate(`${card}.querySelector('.card-title-row .sw').click()`);
    await delay(850);
    const restored = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.filter(p => p.character === '${pid}').length)`, true);
    check('打开角色开关恢复全部分身', restored === three, `clones after on=${restored} expected=${three}`);

    // store 对 config://changed / data:// 有 900ms 本地编辑保护窗：写盘恢复前必须先等它过期，
    // 否则事件在 emit 瞬间被丢弃，前端内存停留在脏值（shenshen=3）污染后续断言。
    await delay(1000);
    await evaluate(`window.__TAURI_INTERNALS__.invoke('set_config', { value: ${JSON.stringify(cfgBefore)} })`, true);
    await evaluate(`window.__TAURI_INTERNALS__.invoke('set_data', { name: 'character_meta', value: ${JSON.stringify(metaBefore)} })`, true);
    await delay(350);
  } else {
    check('角色可分身到多只', false, '未找到陪伴中的角色开关');
    check('关闭角色开关隐藏全部分身', false, '未找到陪伴中的角色开关');
    check('隐藏时记住分身数量', false, '未找到陪伴中的角色开关');
    check('打开角色开关恢复全部分身', false, '未找到陪伴中的角色开关');
  }

  // 批量隐藏 / 全部开启：多分身数量同样保留
  const batchCfg = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config')`, true);
  const cloneCounts = Object.fromEntries([...new Set(batchCfg.pets.map((p) => p.character))]
    .map((id) => [id, batchCfg.pets.filter((p) => p.character === id).length]));
  await sw.evaluate(`[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.includes('全部隐藏')).click()`);
  await delay(700);
  const batchOff = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.length)`, true);
  check('全部隐藏清空桌宠', batchOff === 0, `pets=${batchOff}`);
  await sw.evaluate(`[...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.includes('全部开启')).click()`);
  await delay(800);
  const batchOn = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets)`, true);
  const batchOk = Object.entries(cloneCounts).every(([id, n]) => batchOn.filter((p) => p.character === id).length === n);
  check('全部开启恢复各角色原分身数', batchOk,
    `before=${JSON.stringify(cloneCounts)} after=${JSON.stringify(Object.fromEntries([...new Set(batchOn.map((p) => p.character))].map((id) => [id, batchOn.filter((p) => p.character === id).length])))}`);
  await delay(1000); // 等 store 900ms 本地编辑保护窗过期，外部恢复才会被接纳
  await evaluate(`window.__TAURI_INTERNALS__.invoke('set_config', { value: ${JSON.stringify(cfgBefore)} })`, true);
  await evaluate(`window.__TAURI_INTERNALS__.invoke('set_data', { name: 'character_meta', value: ${JSON.stringify(metaBefore)} })`, true);
  await delay(350);

  await sw.evaluate(`[...document.querySelectorAll('.card-actions button')].find(b => b.textContent.includes('添加分身')).click()`);
  await delay(1000);
  const after = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_config').then(c => c.pets.length)`, true);
  const overlayPets = await evaluate(`document.querySelectorAll('.pet').length`);
  check('添加分身后浮层同步新增桌宠', after === before + 1 && overlayPets === after,
    `before=${before} after=${after} overlay=${overlayPets}`);
  await evaluate(`window.__TAURI_INTERNALS__.invoke('set_config', { value: ${JSON.stringify(cfgBefore)} })`, true);
  await delay(400);

  // 偏好设置页：原生设置系统作为 Vue 页面容器挂载
  await sw.evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('偏好设置')).click()`);
  await delay(1700);
  const labels = ['常规', '桌宠', '互动', '菜单', '功能', '自动化与联动', '更新'];
  const ui = await sw.evaluate(`(() => {
    const txt = document.body.innerText;
    return { missing: ${JSON.stringify(labels)}.filter(l => !txt.includes(l)),
             sidebar: !!document.querySelector('.settings-sidebar'),
             blank: txt.trim().length === 0 };
  })()`);
  check('偏好设置页能力域齐全', !!ui?.sidebar && !ui?.blank && ui?.missing?.length === 0,
    `sidebar=${ui?.sidebar} missing=${JSON.stringify(ui?.missing)}`);
  const mounted = await sw.evaluate(`!!window.__settings`);
  check('偏好设置应用已挂载', !!mounted, `mounted=${mounted}`);
  sw.ws.close();
}

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
