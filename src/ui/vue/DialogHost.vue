<script setup lang="ts">
import ActionsDialog from './ActionsDialog.vue';
import RoleDialogs from './RoleDialogs.vue';
import ImportDialog from './ImportDialog.vue';
import { S, cancelImport, closeDialog } from './store';

const isActions = (t: string) => t === 'actions';
</script>

<template>
  <Transition name="fade">
    <div v-if="S.dialog" class="dlg-mask" @click.self="S.dialog?.type === 'import' ? cancelImport() : closeDialog()">
      <ImportDialog v-if="S.dialog.type === 'import'" />
      <ActionsDialog v-else-if="isActions(S.dialog.type)" />
      <RoleDialogs v-else />
    </div>
  </Transition>
</template>
