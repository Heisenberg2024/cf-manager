<template>
  <n-card hoverable size="small" class="store-card" @click="emit('detail', item)">
    <template #header>
      <n-space align="center" :size="8">
        <span class="cover-thumb">{{ isIconUrl ? '' : (item.template.icon || '📦') }}</span>
        <img v-if="isIconUrl" :src="item.template.icon" class="cover-thumb-img" alt="" />
        <span class="tpl-name">{{ item.template.name }}</span>
      </n-space>
    </template>

    <template #header-extra>
      <n-button
        text
        size="small"
        @click.stop="emit('toggle-fav', item)"
        :title="faved ? t('storeCard.unfav') : t('storeCard.fav')"
      >
        <n-icon
          :component="faved ? Star : StarOutline"
          :color="faved ? 'var(--theme-warning)' : 'var(--text-color-3)'"
          :size="18"
        />
      </n-button>
    </template>

    <p class="tpl-desc">{{ item.template.description || t('storeCard.noDesc') }}</p>

    <n-space v-if="bindingTypes.length" class="binding-row" size="small">
      <n-tag
        v-for="b in bindingTypes"
        :key="b"
        size="tiny"
        round
        :type="bindingTagType(b)"
        :bordered="false"
      >
        {{ b.toUpperCase() }}
      </n-tag>
    </n-space>

    <n-space class="tag-row" size="small">
      <n-tag v-for="tag in displayTags" :key="tag" size="tiny">{{ tag }}</n-tag>
    </n-space>

    <template #footer>
      <n-space justify="space-between" align="center">
        <span class="meta">
          <template v-if="item.template.author?.url">
            <a :href="item.template.author.url" target="_blank" rel="noopener noreferrer" @click.stop>{{ item.template.author.name }}</a>
          </template>
          <template v-else>{{ t('storeCard.by', { name: item.template.author?.name || t('storeCard.unknown') }) }}</template>
          <n-tag size="tiny" round class="ver-tag">{{ item.template.version }}</n-tag>
        </span>
        <n-space :size="6">
          <n-button
            v-if="repoUrl"
            size="tiny"
            tertiary
            @click.stop="openRepo"
          >
            <template #icon><n-icon :component="LogoGithub" /></template>
            {{ t('storeCard.repo') }}
          </n-button>
          <n-button size="tiny" type="primary" @click.stop="emit('deploy', item)">{{ t('storeCard.deploy') }}</n-button>
        </n-space>
      </n-space>
    </template>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Star, StarOutline } from '@vicons/ionicons5';
import { LogoGithub } from '@vicons/ionicons5';
import type { CatalogBindingType, TemplateItem } from '../../types/store';
import { isFav } from '../../utils/favorites';

const { t } = useI18n();

const props = defineProps<{ item: TemplateItem }>();
const emit = defineEmits<{
  (e: 'detail', item: TemplateItem): void;
  (e: 'deploy', item: TemplateItem): void;
  (e: 'toggle-fav', item: TemplateItem): void;
}>();

const faved = computed(() => isFav(props.item));

// 仓库地址：优先用模板的 homepage（真正的项目仓库），
// 再退化到 source.url（raw 源文件地址，从中能反推 GitHub 仓库），
// 最后才到 author.url（仅是作者个人主页，不一定是仓库本身）。
const repoUrl = computed(() => {
  return (
    props.item.template.homepage ||
    props.item.template.source?.url ||
    props.item.template.author?.url ||
    ''
  );
});

function openRepo() {
  if (repoUrl.value) {
    window.open(repoUrl.value, '_blank', 'noopener,noreferrer');
  }
}

const isIconUrl = computed(() =>
  /^(https?:|data:)/.test(props.item.template.icon || ''),
);

const bindingTypes = computed(() => {
  const set = new Set<CatalogBindingType>();
  (props.item.template.bindings || []).forEach((b) => set.add(b.type));
  return Array.from(set);
});

const displayTags = computed(() => (props.item.template.tags || []).slice(0, 4));

function bindingTagType(type: CatalogBindingType) {
  const map: Record<string, any> = {
    kv: 'success',
    d1: 'info',
    r2: 'warning',
    ai: 'default',
    var: 'error',
  };
  return map[type] || 'default';
}
</script>

<style scoped>
.store-card {
  height: 100%;
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  transition: border-color 0.15s ease;
}
.store-card:hover {
  box-shadow: var(--glass-shadow-hover) !important;
  border-color: var(--theme-primary-hover) !important;
}
.cover-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--theme-primary);
  color: #fff;
  font-size: 15px;
}
.cover-thumb-img {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  object-fit: cover;
}
.tpl-name {
  font-weight: 600;
  font-size: 14px;
}
.tpl-desc {
  margin: 0 0 10px;
  color: var(--text-color-3);
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}
.binding-row {
  margin-bottom: 8px;
}
.tag-row {
  margin-bottom: 4px;
  min-height: 22px;
}
.meta {
  font-size: 12px;
  color: var(--text-color-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.meta a {
  color: var(--primary-color);
  text-decoration: none;
}
.ver-tag {
  margin-left: 2px;
}
</style>
