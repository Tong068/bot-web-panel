<template><img :src="failed ? fallback : src || fallback" :alt="alt" @error="failed = true"></template>
<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ src?: string; alt?: string }>()
const fallback = '/bot-web/img/icons/AppIcon.png', failed = ref(false)
watch(() => props.src, () => failed.value = false)
</script>
