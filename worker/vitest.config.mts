import { defineConfig } from 'vitest/config';

// 单元测试使用 node 环境；worker 加密模块依赖全局 Web Crypto（Node 20+ 已内置 globalThis.crypto）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
