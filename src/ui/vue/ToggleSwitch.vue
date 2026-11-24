<script setup lang="ts">
withDefaults(defineProps<{
  on: boolean;
  color?: string;
  label?: string;
  title?: string;
  disabled?: boolean;
  small?: boolean;
}>(), { color: 'var(--h-accent)', label: '', title: '', disabled: false, small: false });

const emit = defineEmits<{ 'update:on': [value: boolean] }>();
</script>

<template>
  <button type="button" class="sw" :class="{ on, small }" :style="{ '--sw': color }"
    role="switch" :aria-checked="on" :aria-label="label || title" :title="title"
    :disabled="disabled" @click="emit('update:on', !on)">
    <span class="sw-knob"></span>
  </button>
</template>
