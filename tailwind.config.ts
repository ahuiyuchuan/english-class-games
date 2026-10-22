/** @author ahui：组件仅引用语义变量，颜色来源集中在 tokens.css。 */
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        surface: 'var(--surface)',
        primary: 'var(--primary)',
        foreground: 'var(--text)',
        muted: 'var(--text-muted)',
      },
    },
  },
  plugins: [],
} satisfies Config;
