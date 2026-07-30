<!--
  首页 Hero 沉浸背景：一层淡绿色网格纹 + 径向光晕（光晕由 CSS 变量 --vp-home-hero-image-background-image 提供）。
  注入到 home-hero-image 插槽；纯装饰，pointer-events: none 不挡交互。
  网格纹隐喻 flowcast 的"步骤/编排"框架感，光晕呼应品牌绿。
-->
<template>
  <div class="flowcast-hero-bg" aria-hidden="true" />
</template>

<script setup>
// 纯 CSS 组件，无逻辑
</script>
