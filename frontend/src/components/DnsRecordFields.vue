<template>
  <n-form-item
    v-if="field('type')"
    :label="t('dns.recordType')"
    path="type"
  >
    <n-select
      v-model:value="model.type"
      :options="typeOptions"
      :disabled="lockType"
    />
  </n-form-item>
  <n-form-item
    v-if="field('name')"
    :label="t('dns.recordName')"
    path="name"
  >
    <n-input
      v-model:value="model.name"
      :placeholder="t('dns.recordNamePlaceholder')"
    />
  </n-form-item>
  <n-form-item
    v-if="field('content')"
    :label="t('dns.recordContent')"
    path="content"
  >
    <n-input
      v-model:value="model.content"
      :placeholder="t('dns.recordContentPlaceholder')"
    />
  </n-form-item>
  <n-form-item
    v-if="field('priority') && ['MX', 'SRV'].includes(model.type)"
    :label="t('dns.priority')"
  >
    <n-input-number
      v-model:value="model.priority"
      :min="0"
      :max="65535"
    />
  </n-form-item>
  <n-form-item
    v-if="field('weight') && model.type === 'SRV'"
    label="Weight"
  >
    <n-input-number
      v-model:value="model.weight"
      :min="0"
      :max="65535"
    />
  </n-form-item>
  <n-form-item
    v-if="field('port') && model.type === 'SRV'"
    label="Port"
  >
    <n-input-number
      v-model:value="model.port"
      :min="0"
      :max="65535"
    />
  </n-form-item>
  <template v-if="model.type === 'CAA'">
    <n-form-item
      v-if="field('flags')"
      label="Flags"
    >
      <n-input-number
        v-model:value="model.flags"
        :min="0"
        :max="255"
      />
    </n-form-item>
    <n-form-item
      v-if="field('tag')"
      label="Tag"
    >
      <n-select
        v-model:value="model.tag"
        :options="['issue', 'issuewild', 'iodef'].map(value => ({label: value, value}))"
      />
    </n-form-item>
  </template>
  <n-form-item
    v-if="field('ttl')"
    :label="t('dns.ttl')"
  >
    <n-select
      v-model:value="model.ttl"
      :options="ttlOptions"
      :disabled="!patch && model.proxied"
    /><n-input-number
      v-model:value="model.ttl"
      :min="1"
      :max="86400"
      :disabled="!patch && model.proxied"
      style="margin-left: 8px; width: 130px"
    />
  </n-form-item>
  <n-form-item
    v-if="field('proxied')"
    :label="t('dns.proxied')"
  >
    <n-switch
      v-model:value="model.proxied"
      :disabled="!PROXY_TYPES.includes(model.type)"
    />
  </n-form-item>
  <n-form-item
    v-if="field('comment')"
    :label="t('dns.multi.comment')"
  >
    <n-input v-model:value="model.comment" />
  </n-form-item>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DNS_TYPES, PROXY_TYPES, type DnsRecordForm } from '../utils/dnsRecord';
const model = defineModel<DnsRecordForm>({ required: true });
const props = defineProps<{ fields?: string[]; lockType?: boolean; patch?: boolean }>();
const { t } = useI18n();
const field = (key: string) => !props.fields || props.fields.includes(key);
const typeOptions = DNS_TYPES.map(value => ({label: value, value}));
const ttlOptions = computed(() => [1, 60, 120, 300, 600, 1800, 3600, 86400].map(value => ({ label: value === 1 ? t('dns.ttlAuto') : String(value), value })));
watch(() => model.value.proxied, value => { if(value && !props.patch) model.value.ttl = 1; }, {immediate: true});
watch(() => model.value.type, type => { if (!PROXY_TYPES.includes(type)) model.value.proxied = false; if(type === 'CAA') { model.value.flags ??= 0; model.value.tag ||= 'issue'; } });
</script>
