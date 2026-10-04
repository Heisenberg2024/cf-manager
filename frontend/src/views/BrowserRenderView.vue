<template>
  <div class="page-view">
    <n-h2>{{ t('browserRender.title') }}</n-h2>

    <!-- 用量统计 (compact) -->
    <div class="card-grid-scroll" style="width: 100%">
    <n-grid v-if="usageList.length > 0" :x-gap="8" :y-gap="8" cols="1 s:2 m:4 l:6 xl:8" responsive="screen" style="width: 100%; margin-bottom: 16px;">
      <n-gi v-for="u in usageList" :key="u.accountId">
        <n-popover trigger="click" placement="bottom" style="display: block; width: 100%;">
          <template #trigger>
            <div class="br-compact-card">
              <span class="br-compact-card__name" :title="u.accountName">{{ u.accountName }}</span>
              <n-progress
                type="line"
                :percentage="Math.min(u.used / u.limit * 100, 100)"
                :color="u.used > 500 ? 'var(--theme-error)' : 'var(--theme-primary)'"
                :rail-color="'#e8e8e8'"
                :height="6"
                :show-indicator="false"
                :style="{ flex: '1 1 0', minWidth: '24px', overflow: 'hidden' }"
              />
              <span class="br-compact-card__metric" :style="{ color: u.used > 500 ? 'var(--theme-error)' : '#666' }">{{ formatSeconds(u.used) }}</span>
            </div>
          </template>
          <div style="min-width: 220px; padding: 4px 0;">
            <div style="font-weight: bold; margin-bottom: 10px;">{{ u.accountName }}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
              <span>{{ t('browserRender.usedTotal') }}</span>
              <span><b :style="{ color: u.used > 500 ? 'var(--theme-error)' : 'var(--theme-primary)' }">{{ formatSeconds(u.used) }}</b> / {{ formatSeconds(u.limit) }}</span>
            </div>
            <n-progress
              type="line"
              :percentage="Math.min(u.used / u.limit * 100, 100)"
              :color="u.used > 500 ? 'var(--theme-error)' : 'var(--theme-primary)'"
              :rail-color="'#e8e8e8'"
              :height="12"
              :show-indicator="false"
              style="margin-bottom: 10px;"
            />
            <div style="display: flex; justify-content: space-between; font-size: 13px;">
              <span>{{ t('browserRender.usageRate') }}</span>
              <span>{{ Math.min(Math.round(u.used / u.limit * 100), 100) }}%</span>
            </div>
          </div>
        </n-popover>
      </n-gi>
    </n-grid>
    </div>

    <n-card size="small" style="margin-bottom: 16px">
      <n-space vertical>
        <n-space align="center" :wrap="true">
          <n-select
            v-model:value="selectedAccount"
            :options="accountOptions"
            placeholder=""
            style="width: 180px; max-width: 45vw;"
            size="small"
          />
          <n-input
            v-model:value="url"
            :placeholder="t('browserRender.enterUrl')"
            style="width: 400px; max-width: 60vw"
            :disabled="rendering"
            @keyup.enter="handleRender"
          />
          <n-button type="primary" @click="handleRender" :loading="rendering" :disabled="!url.trim()">
            {{ t('browserRender.startRender') }}
          </n-button>
        </n-space>
        <n-radio-group v-model:value="renderMode" size="small">
          <n-radio-button value="screenshot">{{ t('browserRender.screenshot') }}</n-radio-button>
          <n-radio-button value="content">{{ t('browserRender.html') }}</n-radio-button>
          <n-radio-button value="markdown">{{ t('browserRender.markdown') }}</n-radio-button>
          <n-radio-button value="pdf">{{ t('browserRender.pdf') }}</n-radio-button>
          <n-radio-button value="links">{{ t('browserRender.linkExtract') }}</n-radio-button>
        </n-radio-group>
        <n-space align="center" :wrap="true">
          <span style="font-size: 13px; color: var(--app-text-muted);">{{ t('browserRender.engine') }}</span>
          <n-select
            v-model:value="browserEngine"
            :options="engineOptions"
            size="small"
            style="width: 140px; max-width: 45vw;"
          />
        </n-space>
      </n-space>
    </n-card>

    <n-spin :show="rendering">
      <!-- 截图结果 -->
      <n-card v-if="result?.screenshot" :title="t('browserRender.screenshot')" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-button size="tiny" @click="downloadScreenshot">{{ t('browserRender.download') }}</n-button>
        </template>
        <img :src="result.screenshot" style="max-width: 100%; border: 1px solid var(--app-border-input); border-radius: 4px" />
      </n-card>

      <!-- HTML 渲染结果 -->
      <n-card v-if="result?.html" :title="t('browserRender.htmlRender')" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-space>
            <n-button size="tiny" :type="htmlViewMode === 'render' ? 'primary' : 'default'" @click="htmlViewMode = 'render'">{{ t('browserRender.previewMode') }}</n-button>
            <n-button size="tiny" :type="htmlViewMode === 'source' ? 'primary' : 'default'" @click="htmlViewMode = 'source'">{{ t('browserRender.sourceMode') }}</n-button>
          </n-space>
        </template>
        <iframe
          v-if="htmlViewMode === 'render'"
          class="br-result-frame"
          :srcdoc="result.html"
          style="width: 100%; height: 600px; border: 1px solid var(--app-border-input); border-radius: 4px;"
          sandbox="allow-same-origin"
        />
        <n-code v-else :code="result.html" language="html" :word-wrap="true" style="max-height: 600px; overflow: auto;" />
      </n-card>

      <!-- Markdown 结果 -->
      <n-card v-if="result?.markdown" :title="t('browserRender.markdown')" size="small" style="margin-bottom: 16px">
        <n-code :code="result.markdown" language="markdown" :word-wrap="true" style="max-height: 600px; overflow: auto;" />
      </n-card>

      <!-- PDF 结果 -->
      <n-card v-if="result?.pdf" :title="t('browserRender.pdf')" size="small" style="margin-bottom: 16px">
        <template #header-extra>
          <n-button size="tiny" @click="downloadPdf">{{ t('browserRender.downloadPdf') }}</n-button>
        </template>
        <iframe :src="result.pdf" class="br-result-pdf" style="width: 100%; border: 1px solid var(--app-border-input);" />
      </n-card>

      <!-- 链接提取结果 -->
      <n-card v-if="result?.links" :title="t('browserRender.extractedLinks')" size="small" style="margin-bottom: 16px">
        <div v-if="Array.isArray(result.links)">
          <div v-for="(link, i) in result.links" :key="i" style="padding: 4px 0; border-bottom: 1px solid var(--app-border-light); font-size: 13px;">
            <a :href="link" target="_blank" style="color: var(--theme-primary);">{{ link }}</a>
          </div>
          <div style="margin-top: 8px; color: var(--app-text-muted); font-size: 13px;">{{ t('browserRender.totalLinks', { count: result.links.length }) }}</div>
        </div>
        <n-code v-else :code="JSON.stringify(result.links, null, 2)" language="json" :word-wrap="true" />
      </n-card>

      <!-- 耗时 -->
      <div v-if="result" style="color: var(--app-text-muted); font-size: 13px; margin-top: 8px;">
        {{ t('browserRender.browserTime', { time: result.browserMsUsed ? (result.browserMsUsed / 1000).toFixed(2) : result.duration?.toFixed(2) }) }}
      </div>

      <n-empty v-if="!result && !rendering" :description="t('browserRender.inputHint')" style="padding: 60px 0" />
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useMessage } from 'naive-ui';
import { createRequestScope } from '../utils/requestScope';
import { useI18n } from 'vue-i18n';
import { browserRenderApi, type RenderMode, type BrowserEngine } from '../api/browserRender';
import { accountsApi } from '../api/accounts';

const { t } = useI18n();
const requests = createRequestScope();
const message = useMessage();
const url = ref('');
const selectedAccount = ref<string>('auto');
const accountOptions = ref<{ label: string; value: string }[]>([]);
interface UsageItem { accountId: number; accountName: string; used: number; limit: number; }
const usageList = ref<UsageItem[]>([]);
const renderMode = ref<RenderMode>('screenshot');
const browserEngine = ref<BrowserEngine>('chrome');
const engineOptions = [
  { label: 'Chrome', value: 'chrome' },
  { label: 'Kitesurf', value: 'kitesurf' },
];
const rendering = ref(false);
const htmlViewMode = ref<'render' | 'source'>('render');
const result = ref<any>(null);

async function fetchAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const accounts = (data.accounts || []).filter((a: any) => a.is_active && (a.enabled_features || '').includes('browser_render')).map((a: any) => ({
      label: a.name,
      value: String(a.id),
    }));
    accountOptions.value = [{ label: t('browserRender.autoAssign'), value: 'auto' }, ...accounts];
  } catch {
    accountOptions.value = [{ label: t('browserRender.autoAssign'), value: 'auto' }];
  }
}

async function handleRender() {
  if (!url.value.trim()) return;
  rendering.value = true;
  result.value = null;
  try {
    const acctId = selectedAccount.value !== 'auto' ? Number(selectedAccount.value) : undefined;
    const { data } = await browserRenderApi.render(url.value, renderMode.value, acctId, browserEngine.value);
    if (data.screenshot && !data.screenshot.startsWith('data:')) {
      data.screenshot = `data:image/png;base64,${data.screenshot}`;
    }
    result.value = data;
    message.success(t('browserRender.renderComplete', { time: data.duration?.toFixed(1) }));
    fetchUsage();
  } finally {
    rendering.value = false;
  }
}

function downloadScreenshot() {
  if (!result.value?.screenshot) return;
  const a = document.createElement('a');
  a.href = result.value.screenshot;
  a.download = `screenshot-${new Date().getTime()}.png`;
  a.click();
}

function downloadPdf() {
  if (!result.value?.pdf) return;
  const a = document.createElement('a');
  a.href = result.value.pdf;
  a.download = `page-${new Date().getTime()}.pdf`;
  a.click();
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? t('browserRender.formatMinutes', { m, s: sec }) : t('browserRender.formatSeconds', { s: sec });
}

async function fetchUsage() {
  const request = requests.begin('fetchUsage');
  try {
    const { data } = await browserRenderApi.getQuota();
    if (!request.current()) return;
    usageList.value = (data || [])
      .map((acct: any) => {
        const br = (acct.resources || []).find((r: any) => r.resource === 'browser_render_seconds');
        return br ? { accountId: acct.accountId, accountName: acct.accountName, used: br.count || 0, limit: br.limit || 600 } : null;
      })
      .filter(Boolean) as UsageItem[];
  } catch {
    if (!request.current()) return;
    usageList.value = [];
  }
}

onMounted(() => {
  fetchAccounts();
  fetchUsage();
});
</script>

<style scoped>
.br-compact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--app-border-input);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  background-color: var(--app-bg-card);
  box-sizing: border-box;
}
.br-compact-card:hover { background-color: var(--app-bg-hover); }
.br-compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}
.br-compact-card__metric {
  font-size: 11px;
  color: var(--app-text-primary);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 32px;
  text-align: right;
}

.br-result-frame {
  height: 600px;
}

.br-result-pdf {
  height: 700px;
}

.card-grid-scroll {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .br-compact-card {
    width: 100%;
    min-width: 100px;
  }
  .br-compact-card__name {
    min-width: 0;
  }
  .br-compact-card__metric {
    font-size: 10px;
  }
  .br-result-frame {
    height: 400px !important;
  }
  .br-result-pdf {
    height: 500px !important;
  }
}
</style>
