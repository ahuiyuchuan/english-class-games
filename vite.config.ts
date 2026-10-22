/** @author ahui：固定本机开发端口，供 Tauri 使用；发布页不请求任何远程资源。 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 便携交付和验收基线不是开发入口，避免扫描内嵌运行核心。
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: 1420,
    strictPort: true,
    // 构建、保护基线和验证下载不是热更新源；下载锁定的临时文件在 Windows 上会报 EBUSY。
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/releases/**',
        '**/test-results/**',
        '**/validation/**',
      ],
    },
  },
  build: { target: 'chrome120', sourcemap: true },
});
