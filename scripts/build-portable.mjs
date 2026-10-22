/**
 * 先构建共享游戏课堂组件，再把实际 IIFE 与 CSS 写成供桌面导出读取的数据资源。
 * 执行：node scripts/build-portable.mjs；生成文件不可手工修改。
 * @author ahui
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
// 与运行资源一起更新实际依赖许可；离线 HTML 与安装包不得携带过期许可清单。
import './prepare-notices.mjs';
import './build-source.mjs';

// 此入口只生成发布用课堂资源。Vite 还会依据 NODE_ENV 解析依赖的条件导出，
// 仅在配置中替换代码里的 process.env.NODE_ENV 无法固定依赖入口。
// 显式固定当前构建进程，避免测试启动它时继承 test 而生成另一份运行核心。
process.env.NODE_ENV = 'production';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  root: projectDirectory,
  configFile: resolve(projectDirectory, 'vite.portable.config.ts'),
});
const builds = Array.isArray(result) ? result : [result];
const files = builds.flatMap((item) => item.output ?? []);
const scripts = files.filter((item) => item.type === 'chunk');
if (scripts.length !== 1 || scripts[0].imports.length > 0 || scripts[0].dynamicImports.length > 0)
  throw new Error('课堂必须只包含一个无外部模块引用的运行脚本。');
const style = files
  .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
  .map((item) => String(item.source))
  .join('\n');
const directory = resolve(projectDirectory, 'src/portable/generated');
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, 'runtime.json'),
  `${JSON.stringify({ script: scripts[0].code, style })}\n`,
  'utf8',
);
process.stdout.write(`已从共享课堂组件构建 ${scripts[0].code.length} 字符运行核心。\n`);
// Receipt binds the actual executable script/style to its distributed source.
const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = JSON.parse(await readFile(resolve(directory, 'source.json'), 'utf8'));
await writeFile(
  resolve(projectDirectory, 'resources/source/portable-build.json'),
  JSON.stringify(
    {
      productVersion: '1.0.0',
      license: 'GPL-3.0-only',
      source,
      scriptSha256: hash(scripts[0].code),
      styleSha256: hash(style),
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
