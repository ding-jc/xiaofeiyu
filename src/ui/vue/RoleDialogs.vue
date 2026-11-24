<script setup lang="ts">
import { computed, reactive } from 'vue';
import {
  S, addClone, byId, closeDialog, openPrefs, pickImport,
  removePack, roles, saveMeta, setScale, type DialogState,
} from './store';

const d = computed(() => S.dialog as DialogState);
const role = computed(() => byId(d.value.packId));
const r = byId(d.value.packId);
const form = reactive({
  name: r?.name ?? '',
  theme: r?.theme ?? '#6f8fd0',
  prompt: r?.pack.prompt ?? '',
  scale: Math.round((r?.scale ?? 1) * 100),
  fps: r?.pack.fps ?? 24,
  w: r?.pack.canvas?.[0] ?? 640,
  h: r?.pack.canvas?.[1] ?? 360,
  feet_y: r?.pack.feet_y ?? 330,
});

function saveEdit() {
  if (!r) return;
  const size = Number(form.scale) / 100;
  saveMeta(r.id, {
    name: form.name.trim() || r.name, theme: form.theme, prompt: form.prompt,
    fps: Number(form.fps), canvas: [Number(form.w), Number(form.h)],
    feet_y: Number(form.feet_y), scale: size,
  });
  setScale(r.id, size);
  closeDialog();
}
</script>

<template>
  <div class="dlg">
    <!-- 添加角色 -->
    <template v-if="d.type === 'add'">
      <div class="dlg-head">
        <h2>添加角色</h2><span class="dlg-sub">本地导入，不联网</span>
        <button class="dlg-x" @click="closeDialog">×</button>
      </div>
      <div class="dlg-body">
        <div class="add-choice">
          <button @click="pickImport('folder')"><b>▤</b>选择素材包文件夹</button>
          <button @click="pickImport('zip')"><b>⇪</b>选择 .zip 素材包</button>
        </div>
        <p class="form-note" style="margin-top:14px">
          同时支持两种素材格式，自动识别并转换：<code>pixup-pet-asset-v1</code>（<code>config.json</code> + <code>videos/</code>），
          以及原项目 dsh-pet / dsh-pet-indesktop（<code>config.jsonc</code> / <code>manifest.json</code> 等）。
          文件夹与 .zip 都可导入，也可以直接拖进窗口。导入在本地完成，不联网。
        </p>
        <h4 style="margin:18px 0 8px;font-size:11.5px;color:#8f8084">已安装角色 · {{ roles.length }} 位</h4>
        <div v-for="x in roles" :key="x.id" class="clone-row">
          <span>{{ x.name }}</span>
          <span class="grow" style="color:#a3949a">{{ x.count }} 个动作 · {{ x.clones.length }} 个分身</span>
          <button class="btn-soft" @click="removePack(x.id)">移除</button>
        </div>
      </div>
      <div class="dlg-foot"><button class="btn-soft" @click="closeDialog">关闭</button></div>
    </template>

    <!-- 角色编辑 -->
    <template v-else>
      <div class="dlg-head">
        <h2>角色编辑</h2><span class="dlg-sub">{{ role?.name }}</span>
        <button class="dlg-x" @click="closeDialog">×</button>
      </div>
      <div class="dlg-body">
        <div class="form-row"><label>角色名称</label><input v-model="form.name" /></div>
        <div class="form-row"><label>主题色</label><input v-model="form.theme" type="color" /><span class="form-note">{{ form.theme }}</span></div>
        <div class="form-row"><label>角色简介</label><textarea v-model="form.prompt" rows="2"></textarea></div>
        <div class="dlg-grid" style="margin-top:6px">
          <div>
            <div class="form-row"><label>默认大小</label><input v-model.number="form.scale" type="number" min="30" max="160" /><span class="form-note">%</span></div>
            <div class="form-row"><label>帧率</label><input v-model.number="form.fps" type="number" min="1" max="120" /></div>
          </div>
          <div>
            <div class="form-row"><label>画布宽</label><input v-model.number="form.w" type="number" /></div>
            <div class="form-row"><label>画布高 / 脚线</label><input v-model.number="form.h" type="number" style="max-width:70px" /><input v-model.number="form.feet_y" type="number" style="max-width:70px" /></div>
          </div>
        </div>
        <p class="form-note">名称、主题色、默认大小、画布与脚线会立即同步到壁纸层；这些元数据保存在本地 data/character_meta.json，不改动素材包原文件。</p>
      </div>
      <div class="dlg-foot">
        <button class="btn-soft" @click="removePack(d.packId)">移除这套角色</button>
        <button class="btn-soft" @click="closeDialog">取消</button>
        <button class="btn-strong" @click="saveEdit">保存</button>
      </div>
    </template>
  </div>
</template>
