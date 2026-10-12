<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="title"
    :mask-closable="false"
    :close-on-esc="false"
    :closable="!running"
    style="width: 860px; max-width: 95vw"
    @update:show="updateShow"
  >
    <div class="dns-operation-content">
      <slot />
    </div>
    <template #action>
      <n-button
        :disabled="running"
        @click="updateShow(false)"
      >
        {{ t('common.close') }}
      </n-button>
      <slot name="action" />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const props = withDefaults(defineProps<{ show: boolean; title: string; running?: boolean }>(), { running: false });
const emit = defineEmits<{ 'update:show': [show: boolean] }>();
const { t } = useI18n();
function updateShow(show: boolean) { if (!props.running && !show) emit('update:show', false); }
</script>

<style scoped>
.dns-operation-content {
  max-height: calc(85vh - 130px);
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}
</style>
