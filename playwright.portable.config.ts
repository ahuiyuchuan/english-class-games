/**
 * 独立运行真实 file:// 课堂验收，不启动应用开发服务器或任何本地 HTTP 服务。
 * 执行：pnpm exec playwright test --config playwright.portable.config.ts
 * @author ahui
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'materials-portable.spec.ts',
  // 与应用 E2E 分别保留截图和实际 HTML，后一套运行不得清除前一套验收证据。
  outputDir: './test-results/portable',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'portable-chromium', use: { ...devices['Desktop Chrome'] } }],
});
