import { defineConfig } from 'vitest/config';

// 单元测试使用 node 环境（加密/配额等纯逻辑，不依赖 DOM）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
