/** @author ahui：验收实际构建的应用与导出成品，不能用静态截图代替交互验证。 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // 便携成品须由独立配置在无本地 HTTP 服务时验收，不能混入应用开发服务器会话。
  testIgnore: 'materials-portable.spec.ts',
  outputDir: './test-results/application',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:1420', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
