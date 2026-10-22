/** @author ahui：规则使用 Node 环境；组件测试按文件注释显式切换 jsdom。 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // jsdom 词表与编辑器测试会加载完整依赖；限制并发，避免 Windows 上争用资源而误超时。
    // 保持原有单项超时与断言，不能通过放宽失败条件掩盖实际业务问题。
    maxWorkers: 2,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    restoreMocks: true,
  },
});
