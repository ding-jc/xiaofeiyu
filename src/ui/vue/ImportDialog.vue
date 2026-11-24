<script setup lang="ts">
import { computed } from 'vue';
import { S, cancelImport, confirmImport, setImportMerge, setImportNewName, type DialogState } from './store';
import { iconSvg } from '../../data/icons';

const d = computed(() => (S.dialog as DialogState)?.preview);
const loading = computed(() => (S.dialog as DialogState)?.importLoading !== false);
const isMerge = computed(() => (S.dialog as DialogState)?.importMerge === true);
const newName = computed(() => (S.dialog as DialogState)?.importNewName ?? '');
const exists = computed(() => d.value?.exists === true);
const nameInvalid = computed(() => !newName.value.trim() || newName.value.trim() === d.value?.name);
const catLabel: Record<string, string> = {
  idle: '待机', turn: '转身', idle_turn: '待机转身', move: '移动',
  click: '点击', drag: '拖拽', random: '随机', events: '彩蛋',
};
const cats = computed(() => Object.entries(d.value?.categories ?? {})
  .map(([k, n]) => ({ k, n, label: catLabel[k] ?? k })));
const canConfirm = computed(() => !loading.value && (!exists.value || isMerge.value || !nameInvalid.value));
</script>

<template>
  <div class="dlg import-dlg">
    <div class="dlg-head">
      <h2>确认导入角色</h2><span class="dlg-sub">来自网页</span>
      <button class="dlg-x" @click="cancelImport">×</button>
    </div>

    <!-- 清单拉取中：先弹框显示 loading，避免主窗渲染卡顿 -->
    <div v-if="loading" class="imp-loading">
      <span class="imp-spinner"></span>
      <p>正在读取导入清单…</p>
      <small>稍后可选择合并或新建</small>
    </div>

    <template v-else-if="d">
      <div class="dlg-body">
        <div class="imp-hero" :style="{ '--imp': d.theme || '#6f8fd0' }">
          <span class="imp-avatar" v-html="iconSvg('sparkles', 26)"></span>
          <div class="imp-id">
            <strong>{{ d.name || d.id }}</strong>
            <small>{{ d.id }}</small>
          </div>
        </div>
        <p class="imp-desc">网页想把这只桌宠导入到你的应用。确认后会下载所选素材并添加到角色列表。</p>
        <div class="imp-stat">
          <span class="imp-count">共 <b>{{ d.count }}</b> 段动作</span>
          <span v-for="c in cats" :key="c.k" class="imp-tag">{{ c.label }} {{ c.n }}</span>
        </div>
        <p v-if="d.source" class="imp-source">来源：{{ d.source }}</p>

        <!-- 同名包已存在：提示有相同角色，选合并 / 新角色 -->
        <div v-if="exists" class="imp-dupe">
          <p class="imp-dupe-title">检测到相同角色「{{ d.name || d.id }}」</p>
          <label class="imp-opt">
            <input type="radio" name="import-mode" :checked="isMerge" @change="setImportMerge(true)" />
            <span><b>合并导入</b><small>只补充新视频及其对应配置，原有角色不变</small></span>
          </label>
          <label class="imp-opt">
            <input type="radio" name="import-mode" :checked="!isMerge" @change="setImportMerge(false)" />
            <span><b>导入为新角色</b><small>另建一个文件夹，和现有角色并存</small></span>
          </label>
          <div v-if="!isMerge" class="imp-rename">
            <label :for="'imp-name'">新角色名称</label>
            <input id="imp-name" type="text" :value="newName" maxlength="40"
              placeholder="请输入一个不同的名称" @input="setImportNewName(($event.target as HTMLInputElement).value)" />
            <small v-if="nameInvalid" class="imp-rename-err">名称不能为空，且需与原角色不同</small>
          </div>
        </div>
      </div>
      <div class="dlg-foot">
        <button class="btn-soft" @click="cancelImport">取消</button>
        <button class="btn-strong" :disabled="!canConfirm" @click="confirmImport">
          {{ exists ? (isMerge ? '合并导入' : '导入为新角色') : '确认导入' }}
        </button>
      </div>
    </template>
  </div>
</template>
