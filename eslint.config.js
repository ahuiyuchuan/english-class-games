/** @author ahui：使用 TypeScript 和 React Hooks 规则阻止隐式 any 与失效依赖。 */
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-portable/**',
      'node_modules/**',
      'src-tauri/**',
      'resources/**',
      // 只检查实际项目源码；验证目录含冻结副本和编译产物，不能再当第二套源码扫描。
      'releases/**',
      'validation/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
