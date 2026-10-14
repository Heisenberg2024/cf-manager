<template>
  <div class="usage-trend">
    <div class="trend-title">
      <strong>{{ title }}</strong><span>{{ unit }}</span>
    </div>
    <n-empty
      v-if="!points.length"
      size="small"
      :description="t('overview.noHistory')"
    />
    <template v-else>
      <svg
        viewBox="0 0 460 130"
        role="img"
        :aria-label="`${title} (${unit})`"
      >
        <line
          x1="40"
          y1="8"
          x2="40"
          y2="106"
          class="axis"
        /><line
          x1="40"
          y1="106"
          x2="450"
          y2="106"
          class="axis"
        />
        <text
          x="0"
          y="16"
        >{{ max.toLocaleString() }}</text><text
          x="24"
          y="108"
        >0</text>
        <polyline
          :points="path"
          fill="none"
          stroke="var(--primary-color, #18a058)"
          stroke-width="2.5"
        />
        <circle
          v-for="(point,index) in points"
          :key="point.date"
          :cx="x(index)"
          :cy="y(point.count)"
          r="3"
          fill="currentColor"
        ><title>{{ point.date }}: {{ point.count.toLocaleString() }} {{ unit }}</title></circle>
        <text
          x="40"
          y="127"
        >{{ points[0]?.date.slice(5) }}</text><text
          x="400"
          y="127"
        >{{ points.at(-1)?.date.slice(5) }}</text>
      </svg>
      <details>
        <summary>{{ t('overview.dataTable') }}</summary><div class="trend-values">
          <span
            v-for="point in points"
            :key="point.date"
          >{{ point.date }} · {{ point.count.toLocaleString() }} {{ unit }}</span>
        </div>
      </details>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
const props=defineProps<{title:string;unit:string;points:Array<{date:string;count:number}>}>();
const {t}=useI18n();
const max=computed(()=>Math.max(1,...props.points.map(p=>p.count)));
const x=(i:number)=>40+(props.points.length<2?205:i/(props.points.length-1)*410);
const y=(n:number)=>106-n/max.value*94;
const path=computed(()=>props.points.map((p,i)=>`${x(i)},${y(p.count)}`).join(' '));
</script>
<style scoped>
.usage-trend{min-width:0}.trend-title{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px}.trend-title span,summary{font-size:12px;opacity:.65}svg{width:100%;max-height:180px;color:var(--n-text-color);overflow:visible}svg text{fill:currentColor;font-size:10px;opacity:.6}.axis{stroke:currentColor;opacity:.15}.trend-values{display:grid;font-size:12px;gap:4px;max-height:140px;overflow:auto}
</style>
