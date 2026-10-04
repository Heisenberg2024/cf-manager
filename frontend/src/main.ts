import { createApp } from 'vue';
import { createPinia } from 'pinia';
import {
  create, NA, NAlert, NBreadcrumb, NBreadcrumbItem, NButton, NButtonGroup,
  NCard, NCheckbox, NCheckboxGroup, NCode, NCollapse, NCollapseItem, NCollapseTransition,
  NConfigProvider, NDataTable, NDatePicker, NDescriptions, NDescriptionsItem, NDialogProvider, NDivider,
  NDrawer, NDrawerContent, NDropdown, NDynamicTags, NEmpty, NForm, NFormItem,
  NFormItemGi, NGi, NGrid, NH2, NH3, NH4, NIcon,
  NInput, NInputGroup, NInputNumber, NLayout, NLayoutContent, NLayoutFooter, NLayoutHeader,
  NLayoutSider, NList, NListItem, NLoadingBarProvider, NMenu, NMessageProvider, NModal,
  NNotificationProvider, NPopconfirm, NPopover, NProgress, NRadio, NRadioButton, NRadioGroup,
  NSelect, NSlider, NSpace, NSpin, NStatistic, NSwitch, NTab,
  NTabPane, NTabs, NTag, NText, NTimeline, NTimelineItem, NTooltip,
  NUpload,
} from 'naive-ui';
import App from './App.vue';
import router from './router';
import i18n from './i18n';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
// Register only components used by templates; add new template components here.
app.use(create({ components: [
  NA, NAlert, NBreadcrumb, NBreadcrumbItem, NButton, NButtonGroup, NCard,
  NCheckbox, NCheckboxGroup, NCode, NCollapse, NCollapseItem, NCollapseTransition, NConfigProvider,
  NDataTable, NDatePicker, NDescriptions, NDescriptionsItem, NDialogProvider, NDivider, NDrawer,
  NDrawerContent, NDropdown, NDynamicTags, NEmpty, NForm, NFormItem, NFormItemGi,
  NGi, NGrid, NH2, NH3, NH4, NIcon, NInput,
  NInputGroup, NInputNumber, NLayout, NLayoutContent, NLayoutFooter, NLayoutHeader, NLayoutSider,
  NList, NListItem, NLoadingBarProvider, NMenu, NMessageProvider, NModal, NNotificationProvider,
  NPopconfirm, NPopover, NProgress, NRadio, NRadioButton, NRadioGroup, NSelect,
  NSlider, NSpace, NSpin, NStatistic, NSwitch, NTab, NTabPane,
  NTabs, NTag, NText, NTimeline, NTimelineItem, NTooltip, NUpload,
] }));
app.mount('#app');
