/** 自包含课堂运行核心构建；只输出 IIFE 与本地样式，不生成跨文件模块依赖。 @author ahui */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  // 运行包与开发模式的 jsxDEV 不兼容；显式关闭开发 JSX，确保生成内容可直接嵌入生产课件。
  esbuild: { jsx: 'automatic', jsxDev: false },
  build: {
    target: 'chrome120',
    outDir: '.portable-build',
    emptyOutDir: true,
    write: false,
    minify: 'esbuild',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: fileURLToPath(new URL('./src/portable/entry.tsx', import.meta.url)),
      name: 'EnglishClassGamesClassroom',
      formats: ['iife'],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
