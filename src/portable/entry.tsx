/** 离线 HTML 与桌面预演使用相同游戏注册和课堂组件，只替换素材获取。 @author ahui */
import { createRoot } from 'react-dom/client';
import { getGame } from '../platform/games';
import type { AssetMap, LessonDocument } from '../platform/types';
import { validateEmbeddedAssets } from './media';
import './shell.css';

/** 内嵌数据按文本读取，拒绝把教学文本解释为 HTML 或任意脚本。 */
async function startClassroom(): Promise<void> {
  const root = document.getElementById('root');
  const data = document.getElementById('ecg-data');
  if (!root || !data?.textContent) throw new Error('课堂文件缺少运行数据，请重新导出。');
  const payload = JSON.parse(data.textContent) as {
    formatVersion: number;
    runtimeVersion: number;
    lesson: LessonDocument;
    assets: AssetMap;
    exportedAt: string;
  };
  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.lesson ||
    typeof payload.lesson !== 'object' ||
    typeof payload.lesson.gameId !== 'string' ||
    !payload.assets ||
    typeof payload.assets !== 'object' ||
    Array.isArray(payload.assets)
  )
    throw new Error('课堂文件的课件或素材信息损坏，请重新复制或导出。');
  if (payload.formatVersion !== 1 || ![1, 2, 3].includes(payload.runtimeVersion))
    throw new Error('此课堂文件版本不受支持，请使用原版课堂文件。');
  const game = getGame(payload.lesson.gameId);
  if (!game) throw new Error('课堂文件缺少对应游戏模块。');
  const structure = game
    .validateStructure(payload.lesson)
    .filter((issue) => issue.severity === 'error');
  if (structure.length) throw new Error(`课堂数据损坏或版本不兼容：${structure[0].message}`);
  // 顺序核对原始字节不等于提前解码全部声音；后续仍由共享声音引擎按需解码。
  await validateEmbeddedAssets(payload.assets);
  const issues = game
    .validate(payload.lesson, payload.assets)
    .filter((issue) => issue.severity === 'error');
  if (issues.length > 0)
    throw new Error(
      `课堂文件内容不可用：${issues.map((issue) => issue.message).join('；')}请重新复制或从备课软件重新导出。`,
    );
  const Classroom = game.Classroom;
  createRoot(root).render(
    <Classroom lesson={payload.lesson} assets={payload.assets} exportedAt={payload.exportedAt} />,
  );
}

void startClassroom().catch((error: unknown) => {
  // 文件损坏时给出真实修复入口，不将失败伪装成空白课堂或已播放状态。
  const root = document.getElementById('root');
  if (root) {
    const heading = document.createElement('h1');
    heading.textContent = '课堂文件无法打开';
    const message = document.createElement('p');
    message.textContent =
      error instanceof Error ? error.message : '请重新复制文件或从备课软件重新导出。';
    root.replaceChildren(heading, message);
  }
});
