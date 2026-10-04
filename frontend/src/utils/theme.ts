import type { GlobalThemeOverrides } from 'naive-ui';
import { ref, computed } from 'vue';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type GlassIntensity = 'low' | 'medium' | 'strong' | 'ultra';

export interface AccentPreset {
  id: string;
  nameKey: string;
  primary: string;
  hover: string;
  pressed: string;
  suppl: string;
  ambientLight: string;
  ambientDark: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'orange',
    nameKey: 'theme.orange',
    primary: '#f38020',
    hover: '#ff933b',
    pressed: '#d96a10',
    suppl: 'rgba(243, 128, 32, 0.16)',
    ambientLight: 'rgba(243, 128, 32, 0.09)',
    ambientDark: 'rgba(243, 128, 32, 0.14)',
  },
  {
    id: 'green',
    nameKey: 'theme.green',
    primary: '#10b981',
    hover: '#34d399',
    pressed: '#059669',
    suppl: 'rgba(16, 185, 129, 0.16)',
    ambientLight: 'rgba(16, 185, 129, 0.09)',
    ambientDark: 'rgba(16, 185, 129, 0.14)',
  },
  {
    id: 'blue',
    nameKey: 'theme.blue',
    primary: '#3b82f6',
    hover: '#60a5fa',
    pressed: '#2563eb',
    suppl: 'rgba(59, 130, 246, 0.16)',
    ambientLight: 'rgba(59, 130, 246, 0.09)',
    ambientDark: 'rgba(59, 130, 246, 0.14)',
  },
  {
    id: 'purple',
    nameKey: 'theme.purple',
    primary: '#8b5cf6',
    hover: '#a78bfa',
    pressed: '#7c3aed',
    suppl: 'rgba(139, 92, 246, 0.16)',
    ambientLight: 'rgba(139, 92, 246, 0.09)',
    ambientDark: 'rgba(139, 92, 246, 0.14)',
  },
  {
    id: 'cyan',
    nameKey: 'theme.cyan',
    primary: '#06b6d4',
    hover: '#22d3ee',
    pressed: '#0891b2',
    suppl: 'rgba(6, 182, 212, 0.16)',
    ambientLight: 'rgba(6, 182, 212, 0.09)',
    ambientDark: 'rgba(6, 182, 212, 0.14)',
  },
  {
    id: 'rose',
    nameKey: 'theme.rose',
    primary: '#f43f5e',
    hover: '#fb7185',
    pressed: '#e11d48',
    suppl: 'rgba(244, 63, 94, 0.16)',
    ambientLight: 'rgba(244, 63, 94, 0.09)',
    ambientDark: 'rgba(244, 63, 94, 0.14)',
  },
];

export function getPresetById(accentId: string): AccentPreset {
  return ACCENT_PRESETS.find((p) => p.id === accentId) || ACCENT_PRESETS[0];
}

// ===== 语义色系派生 =====
// 设计目标：
// 1. 整套语义色（info / success / warning / error）都使用主题色相，切换主题色时一起变化；
// 2. 同色系内靠明度阶梯拉开层次（error 最重 → success → info → warning 最轻）形成对比；
// 3. 明度刻度固定，保证每个语义色与页面背景的对比度都可读。

interface HslColor {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): HslColor {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: HslColor): string {
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const seg = Math.floor((((h % 360) + 360) % 360) / 60);
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[seg] || table[0];
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 保持色相不变，按比例缩放饱和度、按绝对值偏移明度 */
function shiftThemeColor(baseHex: string, sScale: number, lDelta: number): string {
  const { h, s, l } = hexToHsl(baseHex);
  return hslToHex({ h, s: s * sScale, l: l + lDelta });
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface SemanticColorGroup {
  color: string;
  hover: string;
  pressed: string;
  suppl: string;
}

export type SemanticColorName = 'info' | 'success' | 'warning' | 'error';

/** 语义色相对于主题色相的微偏移：整套同色系，仅做细腻区分 */
const SEMANTIC_HUE_OFFSET: Record<SemanticColorName, number> = {
  info: -6,
  success: 6,
  warning: 10,
  error: -10,
};

/** 饱和度系数：抑制高饱和带来的荧光感 */
const SEMANTIC_SATURATION_SCALE: Record<SemanticColorName, number> = {
  info: 0.85,
  success: 0.9,
  warning: 0.8,
  error: 1,
};

/** 固定色相锚点（不跟随主题色相）：用于保留必要的语义警示色。
    error 固定为红色，保证「删除 / 出错」仍有危险提示；
    其余语义色继续跟随主题色。清空此项即可让 error 也跟随主题。 */
const SEMANTIC_HUE_ANCHOR_OVERRIDE: Partial<Record<SemanticColorName, number>> = {
  error: 4,
};

/** 饱和度安全区间 */
const SATURATION_RANGE = [40, 78] as const;

/** 明度阶梯：error 最重 → success → info → warning 最轻。
    同一色系内靠明度拉开层次，同时保证与背景的对比度（浅色 / 深色两套刻度） */
const SEMANTIC_LIGHTNESS_STEPS: Record<SemanticColorName, { light: number; dark: number }> = {
  error: { light: 34, dark: 50 },
  success: { light: 40, dark: 55 },
  info: { light: 46, dark: 60 },
  warning: { light: 52, dark: 64 },
};

/** 主题明度对语义明度的轻微影响（只继承 20%），避免亮色主题把整套色一起拉亮 */
const THEME_LIGHTNESS_CENTER = 42;
const THEME_LIGHTNESS_INFLUENCE = 0.2;

/** 各语义色与背景的最小对比度目标（同色系下不同色相的感知亮度差异很大，需要逐个兜底） */
const SEMANTIC_MIN_CONTRAST: Record<SemanticColorName, number> = {
  info: 3.5,
  success: 3.5,
  warning: 2.6,
  error: 4.5,
};

/** 深色主题下的参照背景：取暗色玻璃面板叠在页面底上的合成色（约等于 --app-bg-card），
    用于校验语义色对比度；面板提亮后需同步，否则对比度会算虚高 */
const DARK_REFERENCE_BG = '#26292f';
const LIGHT_REFERENCE_BG = '#ffffff';

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized;
  const channels = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 对比度：1 ~ 21 */
function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 逐步调整明度直到与背景的对比度达标（浅色主题压暗、深色主题提亮） */
function ensureContrast(color: string, dark: boolean, minRatio: number): string {
  const background = dark ? DARK_REFERENCE_BG : LIGHT_REFERENCE_BG;
  const { h, s } = hexToHsl(color);
  let l = hexToHsl(color).l;
  let current = color;
  for (let step = 0; step < 40 && contrastRatio(current, background) < minRatio; step += 1) {
    l = clampNumber(l + (dark ? 1.5 : -1.5), 0, 100);
    current = hslToHex({ h, s, l });
  }
  return current;
}

export function deriveSemanticColorGroups(preset: AccentPreset, dark: boolean): Record<SemanticColorName, SemanticColorGroup> {
  const base = hexToHsl(preset.primary);

  const build = (name: SemanticColorName): SemanticColorGroup => {
    const fixedHue = SEMANTIC_HUE_ANCHOR_OVERRIDE[name];
    const h = fixedHue !== undefined
      ? fixedHue
      : ((base.h + SEMANTIC_HUE_OFFSET[name]) % 360 + 360) % 360;
    const s = clampNumber(base.s * SEMANTIC_SATURATION_SCALE[name], SATURATION_RANGE[0], SATURATION_RANGE[1]);
    const step = SEMANTIC_LIGHTNESS_STEPS[name][dark ? 'dark' : 'light'];
    const l = clampNumber(
      step + (base.l - THEME_LIGHTNESS_CENTER) * THEME_LIGHTNESS_INFLUENCE,
      step - 5,
      step + 5
    );
    const color = ensureContrast(hslToHex({ h, s, l }), dark, SEMANTIC_MIN_CONTRAST[name]);
    return {
      color,
      hover: shiftThemeColor(color, 1, 6),
      pressed: shiftThemeColor(color, 1, -8),
      suppl: hexToRgba(color, 0.16),
    };
  };

  return {
    info: build('info'),
    success: build('success'),
    warning: build('warning'),
    error: build('error'),
  };
}

const storedMode = (localStorage.getItem('themeMode') as ThemeMode) || (localStorage.getItem('darkMode') !== null ? (localStorage.getItem('darkMode') === 'true' ? 'dark' : 'light') : 'auto');
const storedAccent = localStorage.getItem('themeAccent') || 'orange';
const storedGlass = localStorage.getItem('frostedGlass') === 'true';
const storedIntensity = (localStorage.getItem('glassIntensity') as GlassIntensity) || 'strong';

export const currentMode = ref<ThemeMode>(storedMode);
export const currentAccent = ref<string>(storedAccent);
export const frostedGlass = ref<boolean>(storedGlass);
export const glassIntensity = ref<GlassIntensity>(storedIntensity);

function getSystemDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const systemDark = ref(getSystemDark());

if (typeof window !== 'undefined' && window.matchMedia) {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    systemDark.value = e.matches;
    if (currentMode.value === 'auto') {
      applyThemeToDocument();
    }
  });
}

export const isDark = computed(() => {
  if (currentMode.value === 'auto') {
    return systemDark.value;
  }
  return currentMode.value === 'dark';
});

// 暗色下背景缺少高频细节，同样的模糊半径「观感」会明显减弱，
// 因此暗色单独给一套更强的档位，保证磨砂能被看出来。
const intensityBlurMap: Record<GlassIntensity, { blur: string; heavy: string; darkBlur: string; darkHeavy: string }> = {
  low: { blur: 'blur(6px) saturate(140%)', heavy: 'blur(12px) saturate(150%)', darkBlur: 'blur(8px) saturate(150%)', darkHeavy: 'blur(14px) saturate(160%)' },
  medium: { blur: 'blur(18px) saturate(170%)', heavy: 'blur(26px) saturate(180%)', darkBlur: 'blur(22px) saturate(185%)', darkHeavy: 'blur(30px) saturate(195%)' },
  strong: { blur: 'blur(32px) saturate(205%)', heavy: 'blur(44px) saturate(215%)', darkBlur: 'blur(38px) saturate(220%)', darkHeavy: 'blur(50px) saturate(230%)' },
  ultra: { blur: 'blur(52px) saturate(240%)', heavy: 'blur(68px) saturate(250%)', darkBlur: 'blur(60px) saturate(255%)', darkHeavy: 'blur(78px) saturate(265%)' },
};

// 磨砂雾度：与 blur 同步由档位驱动。
// 背景只有柔和渐变时，单改 blur 数值在视觉上几乎不可分辨（实测两极端档位像素差≈0），
// 因此档位同时决定面板叠加的白色薄雾量，切换时「通透 ↔ 朦胧」的变化肉眼可辨。
// 雾度只作为「散射发白」的物理补充，不再承担主要差异：
// 磨砂感的主体来源是背景结构被 blur 糊掉的程度（见 style.css 的背景结构层），
// 白雾给太多会变成"面板只是变亮"，反而不像磨砂。
// 浅/暗量级不同：暗色底上白雾是直接提亮，取值必须远小于浅色。
const frostAlphaMap: Record<GlassIntensity, { light: number; dark: number }> = {
  low: { light: 0, dark: 0 },
  medium: { light: 0.08, dark: 0.02 },
  strong: { light: 0.16, dark: 0.05 },
  ultra: { light: 0.24, dark: 0.08 },
};

export function applyGlassIntensityToDocument() {
  if (typeof document === 'undefined') return;
  const config = intensityBlurMap[glassIntensity.value] || intensityBlurMap.strong;
  const dark = isDark.value;
  document.documentElement.style.setProperty('--glass-blur', dark ? config.darkBlur : config.blur);
  document.documentElement.style.setProperty('--glass-blur-heavy', dark ? config.darkHeavy : config.heavy);

  const frost = frostAlphaMap[glassIntensity.value] || frostAlphaMap.strong;
  document.documentElement.style.setProperty('--glass-frost-light', String(frost.light));
  document.documentElement.style.setProperty('--glass-frost-dark', String(frost.dark));
}

export function getThemeOverrides(dark: boolean, accentId: string = currentAccent.value, glass: boolean = frostedGlass.value): GlobalThemeOverrides {
  const preset = getPresetById(accentId);
  const semantic = deriveSemanticColorGroups(preset, dark);

  return {
    common: {
      // 主题色组
      primaryColor: preset.primary,
      primaryColorHover: preset.hover,
      primaryColorPressed: preset.pressed,
      primaryColorSuppl: preset.suppl,
      // 语义色组同样跟随主题色（同色相，按明度/饱和度分层）
      infoColor: semantic.info.color,
      infoColorHover: semantic.info.hover,
      infoColorPressed: semantic.info.pressed,
      infoColorSuppl: semantic.info.suppl,
      successColor: semantic.success.color,
      successColorHover: semantic.success.hover,
      successColorPressed: semantic.success.pressed,
      successColorSuppl: semantic.success.suppl,
      warningColor: semantic.warning.color,
      warningColorHover: semantic.warning.hover,
      warningColorPressed: semantic.warning.pressed,
      warningColorSuppl: semantic.warning.suppl,
      errorColor: semantic.error.color,
      errorColorHover: semantic.error.hover,
      errorColorPressed: semantic.error.pressed,
      errorColorSuppl: semantic.error.suppl,
      borderRadius: '10px',
      borderRadiusSmall: '6px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      ...(glass
        ? {
            // 玻璃卡片：保留适度通透感（过透会让背景色晕与内容混在一起显脏）
            cardColor: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.4)',
            // 浮层承载阅读内容，用近实心底色，避免下层卡片文字透出影响可读性
            modalColor: dark ? 'rgba(33, 38, 50, 0.96)' : 'rgba(255, 255, 255, 0.95)',
            popoverColor: dark ? 'rgba(33, 38, 50, 0.96)' : 'rgba(255, 255, 255, 0.95)',
            tableColor: dark ? 'rgba(33, 38, 50, 0.55)' : 'rgba(255, 255, 255, 0.60)',
            bodyColor: 'transparent',
          }
        : {}),
    },
    Layout: {
      color: 'transparent',
      // 面板色一律亮于页面底 --app-bg (#13161d)：暗色下靠「面板更亮」分层，
      // 而不是靠「比背景更黑」压暗，否则侧栏/顶栏会形成黑框把整屏拖黑
      headerColor: glass
        ? dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.74)'
        : dark ? '#1d222d' : '#ffffff',
      siderColor: glass
        ? dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.68)'
        : dark ? '#1b202a' : '#fcfcfd',
      footerColor: glass
        ? dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.55)'
        : dark ? '#181c25' : '#f8f9fa',
    },
    Card: {
      borderRadius: '14px',
      color: glass
        ? dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.4)'
        : dark ? '#212632' : '#ffffff',
      borderColor: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.85)',
      boxShadow: dark
        ? '0 12px 36px 0 rgba(0, 0, 0, 0.5), inset 0 1px 1px 0 rgba(255, 255, 255, 0.15)'
        : '0 10px 32px 0 rgba(31, 38, 135, 0.08), inset 0 1px 1px 0 rgba(255, 255, 255, 0.95)',
    },
    Menu: {
      borderRadius: '8px',
      itemBorderRadius: '8px',
      itemColorActive: preset.suppl,
      itemColorActiveHover: preset.suppl,
      itemTextColorActive: preset.primary,
      itemIconColorActive: preset.primary,
    },
    Button: {
      borderRadiusMedium: '8px',
      borderRadiusSmall: '6px',
      borderRadiusTiny: '4px',
      borderRadiusLarge: '10px',
    },
    Input: {
      borderRadius: '8px',
      color: dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.7)',
      colorFocus: dark ? 'rgba(255, 255, 255, 0.08)' : '#ffffff',
      border: dark ? '1px solid rgba(255, 255, 255, 0.12)' : '1px solid rgba(203, 213, 225, 0.8)',
    },
    Modal: {
      boxShadow: dark
        ? '0 25px 50px -12px rgba(0, 0, 0, 0.65)'
        : '0 25px 50px -12px rgba(31, 38, 135, 0.18)',
    },
    Dialog: {
      borderRadius: '14px',
      boxShadow: dark
        ? '0 25px 50px -12px rgba(0, 0, 0, 0.65)'
        : '0 25px 50px -12px rgba(31, 38, 135, 0.18)',
    },
    Popover: {
      borderRadius: '10px',
      boxShadow: dark
        ? '0 12px 32px -4px rgba(0, 0, 0, 0.55)'
        : '0 12px 32px -4px rgba(31, 38, 135, 0.14)',
    },
    Dropdown: {
      borderRadius: '10px',
    },
  };
}

export function applyThemeToDocument() {
  if (typeof document === 'undefined') return;
  const dark = isDark.value;
  const preset = getPresetById(currentAccent.value);

  document.documentElement.classList.toggle('app-dark', dark);
  document.documentElement.classList.toggle('app-glass', frostedGlass.value);
  applyGlassIntensityToDocument();

  document.documentElement.style.setProperty('--theme-primary', preset.primary);
  document.documentElement.style.setProperty('--theme-primary-hover', preset.hover);
  document.documentElement.style.setProperty('--theme-primary-pressed', preset.pressed);
  document.documentElement.style.setProperty('--theme-primary-suppl', preset.suppl);
  document.documentElement.style.setProperty(
    '--theme-ambient-accent',
    dark ? preset.ambientDark : preset.ambientLight
  );

  // 语义色同步暴露为 CSS 变量，供未经过 Naive 组件的样式/内联色使用
  const semantic = deriveSemanticColorGroups(preset, dark);
  (Object.keys(semantic) as SemanticColorName[]).forEach((name) => {
    document.documentElement.style.setProperty(`--theme-${name}`, semantic[name].color);
    document.documentElement.style.setProperty(`--theme-${name}-suppl`, semantic[name].suppl);
  });
}

export function setThemeMode(mode: ThemeMode) {
  currentMode.value = mode;
  localStorage.setItem('themeMode', mode);
  localStorage.setItem('darkMode', String(isDark.value));
  applyThemeToDocument();
}

export function setAccent(accentId: string) {
  currentAccent.value = accentId;
  localStorage.setItem('themeAccent', accentId);
  applyThemeToDocument();
}

export function setFrostedGlass(enable: boolean) {
  frostedGlass.value = enable;
  localStorage.setItem('frostedGlass', String(enable));
  applyThemeToDocument();
}

export function setGlassIntensity(intensity: GlassIntensity) {
  glassIntensity.value = intensity;
  localStorage.setItem('glassIntensity', intensity);
  applyGlassIntensityToDocument();
}

export function useAppTheme() {
  const themeOverrides = computed(() =>
    getThemeOverrides(isDark.value, currentAccent.value, frostedGlass.value)
  );

  return {
    currentMode,
    currentAccent,
    frostedGlass,
    glassIntensity,
    isDark,
    themeOverrides,
    setThemeMode,
    setAccent,
    setFrostedGlass,
    setGlassIntensity,
    applyThemeToDocument,
  };
}
