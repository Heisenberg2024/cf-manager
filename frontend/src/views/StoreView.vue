<template>
  <div class="page-view">
    <n-h2>{{ t('store.title') }}</n-h2>

    <!-- Source Status Bar -->
    <n-space
      v-if="sources.length > 0"
      align="center"
      style="margin-bottom: 12px"
    >
      <n-button
        size="small"
        :loading="refreshing"
        @click="loadTemplates(true)"
      >
        {{ t('store.refreshCatalog') }}
      </n-button>
    </n-space>

    <n-space
      v-if="sources.length"
      style="margin-bottom:12px"
      :wrap="true"
    >
      <n-space
        v-for="source in sources"
        :key="source.id"
        align="center"
      >
        <n-tag
          size="small"
          :type="source.sync?.errorKind?'warning':'default'"
        >
          {{ source.name }} · {{ t(`catalogState.${source.sync?.state || 'unknown'}`) }}<template v-if="source.sync?.errorKind">
            ({{ source.sync.errorKind }})
          </template>
        </n-tag>
        <small style="opacity:.65">{{ t('catalogState.lastSuccess') }} {{ source.sync?.lastSuccessAt ? formatCN(source.sync.lastSuccessAt) : '—' }}</small>
        <n-button
          text
          size="tiny"
          @click="refreshSource(source.id)"
        >
          {{ t('common.refresh') }}
        </n-button>
      </n-space>
    </n-space>
    <!-- Category Nav -->
    <StoreCategoryNav
      :types="typeCounts"
      :selected-type="selectedType"
      :tags="allTags"
      :selected-tags="selectedTags"
      @update:selected-type="(v) => (selectedType = v)"
      @toggle-tag="toggleTag"
    />

    <!-- Toolbar -->
    <StoreToolbar
      :search-text="searchText"
      :sort-by="sortBy"
      :fav-only="favOnly"
      :has-active-filter="hasActiveFilter"
      @update:search-text="(v) => (searchText = v)"
      @update:sort-by="(v) => (sortBy = v)"
      @update:fav-only="(v) => (favOnly = v)"
      @clear="clearFilters"
    />

    <!-- Template Cards -->
    <n-spin :show="loading">
      <n-grid
        v-if="filteredTemplates.length > 0"
        :cols="isMobile ? 1 : 3"
        :x-gap="12"
        :y-gap="12"
        responsive="screen"
        item-responsive
      >
        <n-gi
          v-for="item in filteredTemplates"
          :key="item.template.id"
          span="1 m:1 l:1"
        >
          <StoreCard
            :item="item"
            @detail="showDetail"
            @deploy="openDeploy"
            @toggle-fav="toggleFav"
          />
        </n-gi>
      </n-grid>
      <n-empty
        v-else-if="!loading"
        :description="t('store.noTemplates')"
        style="padding: 40px"
      />
    </n-spin>

    <!-- Detail Drawer -->
    <n-drawer
      v-model:show="detailVisible"
      :width="isMobile ? '100%' : 720"
      placement="right"
    >
      <n-drawer-content
        :title="detailItem?.template.name || t('store.detail')"
        :native-scrollbar="true"
        body-content-style="height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;"
        closable
      >
        <template v-if="detailItem">
          <div class="detail-layout">
            <!-- 头部：描述信息 + 按钮（不滚动） -->
            <div class="detail-header">
              <n-descriptions
                label-placement="left"
                :column="1"
                size="small"
                bordered
              >
                <n-descriptions-item :label="t('common.version')">
                  {{ detailItem.template.version }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('common.type')">
                  {{ detailItem.template.type }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('store.author')">
                  <a
                    v-if="detailItem.template.author?.url"
                    :href="detailItem.template.author.url"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ detailItem.template.author.name }}</a>
                  <span v-else>{{ detailItem.template.author?.name || '-' }}</span>
                </n-descriptions-item>
                <n-descriptions-item :label="t('store.source')">
                  {{ detailItem.sourceName }}
                </n-descriptions-item>
                <n-descriptions-item
                  v-if="detailItem.sourceCount > 1"
                  :label="t('store.multiSource', { count: detailItem.sourceCount })"
                >
                  {{ t('store.multiSource', { count: detailItem.sourceCount }) }}
                </n-descriptions-item>
                <n-descriptions-item
                  v-if="detailItem.template.homepage"
                  :label="t('store.homepage')"
                >
                  <a
                    :href="detailItem.template.homepage"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ detailItem.template.homepage }}</a>
                </n-descriptions-item>
              </n-descriptions>

              <n-space style="margin: 8px 0">
                <n-button
                  v-if="sourceRepoUrl"
                  size="small"
                  tag="a"
                  :href="sourceRepoUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <template #icon>
                    <n-icon :component="LogoGithub" />
                  </template>
                  {{ t('store.goToRepo') }}
                </n-button>
                <n-button
                  v-if="readmeGithubUrl"
                  size="small"
                  secondary
                  tag="a"
                  :href="readmeGithubUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ t('store.viewOnGithub') }}
                </n-button>
              </n-space>
            </div>

            <!-- 中部：README 独立滚动 -->
            <div class="detail-readme">
              <n-spin
                v-if="readmeLoading"
                size="small"
                style="padding: 8px 0"
              >
                {{ t('store.loadingReadme') }}
              </n-spin>
              <MarkdownRenderer
                v-else
                :content="readmeContent || detailItem.template.description || t('store.noReadme')"
                :base-url="readmeBaseUrl"
                :repo-url="repoRootUrl"
              />
            </div>

            <!-- 底部：绑定 + 环境变量 + 部署按钮（不滚动） -->
            <div class="detail-footer">
              <div v-if="detailItem.template.bindings?.length">
                <n-h4 style="margin: 8px 0">
                  {{ t('store.bindings') }}
                </n-h4>
                <n-list
                  size="small"
                  bordered
                >
                  <n-list-item
                    v-for="b in detailItem.template.bindings"
                    :key="b.name"
                  >
                    <n-tag
                      size="tiny"
                      :type="bindingTagType(b.type)"
                    >
                      {{ b.type }}
                    </n-tag>
                    <span style="margin-left: 8px">{{ b.name }}</span>
                    <span
                      v-if="b.title"
                      style="color: var(--text-color-3); margin-left: 8px"
                    >→ {{ b.title }}</span>
                  </n-list-item>
                </n-list>
              </div>

              <div v-if="detailItem.template.env && Object.keys(detailItem.template.env).length">
                <n-h4 style="margin: 8px 0">
                  {{ t('store.envVars') }}
                </n-h4>
                <n-list
                  size="small"
                  bordered
                >
                  <n-list-item
                    v-for="(v, k) in detailItem.template.env"
                    :key="k"
                  >
                    <span style="font-family: monospace">{{ k }}</span> = <span style="color: var(--text-color-3)">{{ v }}</span>
                  </n-list-item>
                </n-list>
              </div>

              <n-button
                type="primary"
                block
                @click="openDeploy(detailItem)"
              >
                {{ t('store.deployTemplate') }}
              </n-button>
            </div>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- Deploy Dialog -->
    <StoreDeployDialog
      v-model:show="deployVisible"
      :template="deployItem?.template"
      @deployed="onDeployed"
    />
  </div>
</template>

<script setup lang="ts">
import {formatCN} from '../utils/dateFormat';
import { onUnmounted, watch } from 'vue';
import { ReadmeLoader } from '../utils/readmeLoader';
import { createRequestScope } from '../utils/requestScope';
import { ref, computed, onMounted, h } from 'vue';
import { LogoGithub } from '@vicons/ionicons5';
import { NSpace, NA } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { storeApi } from '../api/store';
import StoreDeployDialog from '../components/StoreDeployDialog.vue';
import StoreCard from '../components/store/StoreCard.vue';
import StoreCategoryNav from '../components/store/StoreCategoryNav.vue';
import StoreToolbar from '../components/store/StoreToolbar.vue';
import MarkdownRenderer from '../components/store/MarkdownRenderer.vue';
import { isFav, toggleFav } from '../utils/favorites';
import { message, dialog } from '../utils/discreteApi';
import type { CatalogBindingType, TemplateItem } from '../types/store';

const { t } = useI18n();
const loading = ref(false);
const refreshing = ref(false);
const templates = ref<TemplateItem[]>([]);
const sources = ref<any[]>([]);
const requestScope=createRequestScope();const sessionController=new AbortController();const readmes=new ReadmeLoader();let readmeRevision=0;
const sourceTemplates=new Map<number,TemplateItem[]>();const sourceRevisions=new Map<number,number>();

const searchText = ref('');
const selectedType = ref<string | null>(null);
const selectedTags = ref<string[]>([]);
const sortBy = ref<'name' | 'version'>('name');
const favOnly = ref(false);

const detailVisible = ref(false);
const detailItem = ref<TemplateItem | null>(null);
const readmeContent = ref('');
const readmeBaseUrl = ref('');
const readmeLoading = ref(false);
const deployVisible = ref(false);
const deployItem = ref<TemplateItem | null>(null);

const isMobile = ref(window.innerWidth <= 768);

const typeCounts = computed(() => {
  const map: Record<string, number> = { worker: 0, pages: 0, hybrid: 0 };
  templates.value.forEach((it) => {
    const t = it.template.type;
    if (map[t] !== undefined) map[t]++;
  });
  return (['worker', 'pages', 'hybrid'] as const).map((v) => ({
    value: v,
    label: v === 'worker' ? 'Worker' : v === 'pages' ? 'Pages' : 'Hybrid',
    count: map[v],
  }));
});

const allTags = computed(() => {
  const tags = new Set<string>();
  templates.value.forEach((t) => (t.template.tags || []).forEach((tag: string) => tags.add(tag)));
  return Array.from(tags).sort();
});

const hasActiveFilter = computed(
  () => !!searchText.value || !!selectedType.value || selectedTags.value.length > 0 || favOnly.value,
);

// 源仓库地址：优先用 homepage，其次从 readmeBaseUrl（raw.githubusercontent）推断
const sourceRepoUrl = computed(() => {
  const homepage = detailItem.value?.template.homepage;
  if (homepage) return homepage;
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
});

// 在 GitHub 上查看完整 README（图片等资产由 GitHub 正确渲染，绕开 raw 拉取限制）
const readmeGithubUrl = computed(() => {
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/README.md` : sourceRepoUrl.value;
});

// 仓库根目录（用于把相对仓库根目录的图片/链接也解析为绝对地址）
const repoRootUrl = computed(() => {
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/` : '';
});

const filteredTemplates = computed(() => {
  let list = templates.value;
  const q = searchText.value.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => {
      const tm = t.template;
      return (
        tm.name?.toLowerCase().includes(q) ||
        tm.description?.toLowerCase().includes(q) ||
        (tm.tags || []).some((tag: string) => tag.toLowerCase().includes(q))
      );
    });
  }
  if (selectedType.value) {
    list = list.filter((t) => t.template.type === selectedType.value);
  }
  if (selectedTags.value.length) {
    list = list.filter((t) => (t.template.tags || []).some((tag) => selectedTags.value.includes(tag)));
  }
  if (favOnly.value) {
    list = list.filter((t) => isFav(t));
  }
  return [...list].sort((a, b) => {
    const fa = isFav(a) ? 1 : 0;
    const fb = isFav(b) ? 1 : 0;
    if (fa !== fb) return fb - fa; // 收藏置顶
    if (sortBy.value === 'name') return a.template.name.localeCompare(b.template.name);
    return compareSemver(b.template.version, a.template.version);
  });
});

function compareSemver(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function bindingTagType(type: CatalogBindingType) {
  const map: Record<string, any> = { kv: 'success', d1: 'info', r2: 'warning', ai: 'default', var: 'error' };
  return map[type] || 'default';
}

function toggleTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag);
  if (idx >= 0) selectedTags.value.splice(idx, 1);
  else selectedTags.value.push(tag);
}

function clearFilters() {
  searchText.value = '';
  selectedType.value = null;
  selectedTags.value = [];
  favOnly.value = false;
}

function mergeTemplates(){const merged=new Map<string,TemplateItem>();for(const source of sources.value){for(const item of sourceTemplates.get(source.id)??[]){const previous=merged.get(item.template.id);if(previous)previous.sourceCount++;else merged.set(item.template.id,{...item,sourceCount:1});}}templates.value=[...merged.values()];}
async function loadTemplates(force = false) {
  requestScope.invalidate();const request=requestScope.begin('templates');loading.value=!templates.value.length;refreshing.value=force;
  try{
    const {data}=await storeApi.getTemplates({cacheOnly:true},sessionController.signal);if(!request.current())return;
    sources.value=data.sources||[];sourceTemplates.clear();for(const source of sources.value)sourceTemplates.set(source.id,(data.templates||[]).filter((item:TemplateItem)=>item.sourceId===source.id));mergeTemplates();loading.value=false;
    let index=0;await Promise.all(Array.from({length:Math.min(3,sources.value.length)},async()=>{while(index<sources.value.length){const source=sources.value[index++],sourceRevision=sourceRevisions.get(source.id)??0;try{if(force)await storeApi.refresh(source.id);const {data}=await storeApi.getTemplates({sourceId:source.id},sessionController.signal);if(!request.current())return;if(sourceRevision!==(sourceRevisions.get(source.id)??0))continue;sourceTemplates.set(source.id,data.templates||[]);const next=data.sources?.[0];if(next)sources.value=sources.value.map(s=>s.id===source.id?next:s);mergeTemplates();}catch{/* keep other successful sources */}}}));
  }catch{/* preserve last successful display */}finally{if(request.current()){loading.value=false;refreshing.value=false;}}
}
async function refreshSource(id:number){sourceRevisions.set(id,(sourceRevisions.get(id)??0)+1);const request=requestScope.begin(`source-${id}`);try{await storeApi.refresh(id);const {data}=await storeApi.getTemplates({sourceId:id,cacheOnly:true},sessionController.signal);if(!request.current())return;sourceTemplates.set(id,data.templates||[]);if(data.sources?.[0])sources.value=sources.value.map(s=>s.id===id?data.sources[0]:s);mergeTemplates();}catch{/* preserve snapshot */}}

// 从 GitHub 仓库地址推断 README 原始地址（支持 main/master 分支回退）
function githubReadmeCandidates(url?: string): string[] {
  if (!url) return [];
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)/i);
  if (!m) return [];
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  const base = `https://raw.githubusercontent.com/${owner}/${repo}`;
  return [`${base}/main/README.md`, `${base}/master/README.md`];
}

async function showDetail(item: TemplateItem) {
  const revision=++readmeRevision;detailItem.value=item;detailVisible.value=true;readmeContent.value='';readmeBaseUrl.value='';readmeLoading.value=true;
  const urls=item.template.readmeUrl?[item.template.readmeUrl]:githubReadmeCandidates(item.template.homepage||item.template.source?.url||item.template.author?.url);
  try{const result=await readmes.load(urls);if(revision===readmeRevision&&detailVisible.value){readmeContent.value=result.content;readmeBaseUrl.value=result.baseUrl;}}
  catch{/* description remains available */}finally{if(revision===readmeRevision)readmeLoading.value=false;}
}
watch(detailVisible,visible=>{if(!visible){readmeRevision++;readmes.cancel();readmeContent.value='';readmeBaseUrl.value='';readmeLoading.value=false;}});
function clearSession(){requestScope.invalidate();sessionController.abort();readmes.clear();sourceTemplates.clear();templates.value=[];sources.value=[];detailItem.value=null;detailVisible.value=false;deployItem.value=null;deployVisible.value=false;}
onUnmounted(()=>{clearSession();window.removeEventListener('auth-expired',clearSession);});

function openDeploy(item: TemplateItem) {
  deployItem.value = item;
  deployVisible.value = true;
}

function onDeployed(result: any) {
  const data = result.data || result;
  if (data.error) {
    message.error(t('store.deployFailed', { error: data.error }));
    if (data.rolledBack) message.warning(t('store.autoRollback'));
    return;
  }
  deployVisible.value = false;
  const accountInfo = data.accountName ? t('store.deploySuccessAccount', { name: data.accountName }) : '';
  const urls = (data.url || '').split(' | ').filter(Boolean);
  if (urls.length === 0) {
    message.success(t('store.deploySuccess', { account: accountInfo }));
    return;
  }
  // 部署成功：弹框询问是否打开新部署的地址
  dialog.success({
    title: t('store.deployDialogTitle', { account: accountInfo }),
    content: () =>
      h('div', [
        h('p', { style: 'margin: 0 0 8px' }, t('store.openUrlPrompt')),
        h(
          NSpace,
          { vertical: true },
          () => urls.map((u: string) =>
            h(NA, { href: u, target: '_blank', style: 'word-break: break-all' }, { default: () => u })
          )
        ),
      ]),
    positiveText: t('store.openUrl'),
    negativeText: t('common.close'),
    onPositiveClick: () => {
      urls.forEach((u: string) => window.open(u, '_blank'));
    },
  });
}

onMounted(async () => {
  await storeApi.init();
  await loadTemplates();
  window.addEventListener('auth-expired',clearSession);
});
</script>

<style scoped>
.page-view {
  max-width: 1100px;
  margin: 0 auto;
}

/* 详情抽屉三段式布局：上固定 / 中 README 独立滚动 / 下固定 */
/* Drawer body 的高度链通过公开 body-content-style 设置，不依赖内部 DOM 类名。 */
.detail-layout {
  display: flex;
  flex-direction: column;
  /* 占满抽屉 body 的高度 */
  height: 100%;
  min-height: 0;
}
.detail-header {
  flex-shrink: 0;
}
.detail-readme {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 给 README 一点内边距，避免贴边 */
  padding: 4px 8px 4px 0;
  scrollbar-gutter: stable;
}
.detail-footer {
  flex-shrink: 0;
  /* 与 README 之间留点空隙 */
  margin-top: 12px;
}

/* 长代码块在 README 内换行，避免横向溢出 */
.detail-readme :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-readme :deep(pre code) {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
