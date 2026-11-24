<script setup lang="ts">
import { S } from './store';
import { iconSvg } from '../../data/icons';
import logo from '../../assets/logo.jpg';

const items = [
  { label: '我的角色', icon: 'application' },
  { label: '偏好设置', icon: 'settings' },
];
</script>

<template>
  <header class="home-topbar">
    <div class="brand">
      <div class="brand-avatar"><img :src="logo" alt="logo" /></div>
      <div class="brand-name">小肥鱼宠物</div>
    </div>

    <nav class="home-nav">
      <button v-for="it in items" :key="it.label" class="nav-item"
        :class="{ active: S.tab === it.label }"
        @click="S.tab = it.label as typeof S.tab">
        <span class="nav-icon" v-html="iconSvg(it.icon, 19)"></span>
        <span>{{ it.label }}</span>
      </button>
    </nav>
  </header>
</template>
