/**
 * Exercise the real Settings UI, its registered Tauri IPC and native SQLite.
 * Only the isolated native-smoke application may be mutated; original defaults
 * are restored and read back even when an assertion fails.
 * The isolated merged configuration temporarily permits Window.close() IPC so
 * the production onCloseRequested handler can be tested without OS automation.
 * @author ahui
 */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../target/native-validation/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes(':1420'));
  assert.ok(page, 'A real native WebView2 page is required.');
  const before = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const location = await invoke('get_data_location');
    if (!location.includes('native-smoke')) throw new Error('Only the smoke library is allowed.');
    return {
      preferences: await invoke('get_app_data', { key: 'preferences' }),
      dataEpoch: await invoke('get_data_epoch'),
    };
  });
  let result;
  try {
    await page.getByRole('button', { name: '资源与设置', exact: true }).click();
    await page.getByRole('heading', { name: '单词节拍 · 新课制作默认', exact: true }).waitFor();
    const target = page.getByLabel('目标时长（分钟）', { exact: true });
    // 每次都选与已保存值不同的时长，避免上次原偏好恰好为 7.5 时跳过离开保护。
    const targetMinutes = (await target.inputValue()) === '7.5' ? '7.25' : '7.5';
    await target.fill('');
    assert.equal(
      await page.getByRole('button', { name: '保存新课默认', exact: true }).isDisabled(),
      true,
    );
    await target.fill(targetMinutes);
    // 设置分区保留表单，真正离开设置才询问；使用实际平台导航，不能只直接调用表单回调。
    await page.getByRole('tab', { name: '音乐与口号', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '未保存的修改' }).count(), 0);
    await page.getByRole('tab', { name: '语音与制作默认', exact: true }).click();
    assert.equal(await target.inputValue(), targetMinutes);
    await page.getByRole('button', { name: 'AI 工作台', exact: true }).click();
    const leavePrompt = page.getByRole('dialog', { name: '未保存的修改' });
    await leavePrompt.waitFor();
    await leavePrompt.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await target.inputValue(), targetMinutes);
    // Window.close() 的正式 API 就是该 IPC；它发出 close-requested，不能用 destroy
    // 代替，否则会绕过 App 的原生关窗保护。此权限仅在隔离冒烟合并配置中追加。
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }),
    );
    await leavePrompt.waitFor();
    await leavePrompt.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(page.isClosed(), false);
    assert.equal(await target.inputValue(), targetMinutes);
    const afterCancelledClose = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('get_app_data', { key: 'preferences' }),
    );
    assert.deepEqual(afterCancelledClose, before.preferences);
    await page.getByLabel('新课默认练习预设', { exact: true }).selectOption('focus');
    await page.getByLabel('新课默认声音模式', { exact: true }).selectOption('teacher');
    await page.getByLabel('新课默认展示模式', { exact: true }).selectOption('blocks');
    await page.getByLabel('新课默认课堂推进方式', { exact: true }).selectOption('step');
    await page.getByRole('button', { name: '保存新课默认', exact: true }).click();
    await page
      .getByText('单词节拍新课默认已保存，仅用于之后创建的课件。', { exact: true })
      .waitFor();
    const stored = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('get_app_data', { key: 'preferences' }),
    );
    const saved = stored.gameDefaults['word-beat'];
    assert.equal(saved.targetDurationMs, Number(targetMinutes) * 60_000);
    assert.equal(saved.preset, 'focus');
    assert.equal(saved.soundMode, 'teacher');
    assert.equal(saved.displayMode, 'blocks');
    assert.equal(saved.progression, 'step');
    // 保存确实成功后宿主不再误拦；重新进入按真实原生保存值初始化。
    await page.getByRole('button', { name: 'AI 工作台', exact: true }).click();
    await page.getByRole('heading', { name: 'AI 工作台', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '未保存的修改' }).count(), 0);
    await page.getByRole('button', { name: '资源与设置', exact: true }).click();
    await page.getByRole('heading', { name: '单词节拍 · 新课制作默认', exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('目标时长（分钟）', { exact: true }).inputValue(),
      targetMinutes,
    );
    await page.screenshot({ path: `${output}/settings.png`, fullPage: true });
    await page.getByRole('tab', { name: '音乐与口号', exact: true }).click();
    await page.getByRole('heading', { name: '内置口号模板', exact: true }).waitFor();
    assert.equal(await page.getByLabel('声音类型筛选').inputValue(), 'music');
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('heading', { name: '本机导出副本', exact: true }).waitFor();
    assert.ok(
      (await page.getByLabel('数据位置', { exact: true }).inputValue()).includes('native-smoke'),
    );
    result = {
      checkedAt: new Date().toISOString(),
      dataEpoch: before.dataEpoch,
      checks: [
        'Unfinished default duration blocks actual UI save',
        'Unsaved defaults survive Settings tab changes without a redundant prompt',
        'Actual application navigation protects unsaved defaults and retains cancelled input',
        'Real Window.close request reaches the production App guard; cancel retains window, input and unchanged native preferences',
        'Per-game Settings defaults persist through real native SQLite IPC',
        'Successful native save releases the navigation guard and survives re-entry',
        'Music kind filter and read-only slogan templates',
        'Managed data and export-copy controls in actual WebView2',
        'A clean real Window.close request closes the native page after saving and restoring original preferences',
      ],
      saved,
    };
  } finally {
    await page.evaluate(
      ({ dataEpoch, preferences }) =>
        window.__TAURI_INTERNALS__.invoke('set_app_data', {
          dataEpoch,
          key: 'preferences',
          value: preferences,
        }),
      before,
    );
    const restored = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('get_app_data', { key: 'preferences' }),
    );
    assert.deepEqual(restored, before.preferences);
    // 成功路径马上通过正式关窗流程退出，不在此 reload：重载会异步重新注册监听，
    // 过早 close 可能尚未进入本次 App 的 handler，无法作为有效验收证据。
    if (!result) await page.reload();
  }
  // 原偏好先恢复并回读，再通过同一真实 close 请求干净退出；脚本不保留测试设置。
  const nativePageClosed = page.waitForEvent('close', { timeout: 15_000 });
  let closeRequestCompletionError;
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch((error) => {
      // 关闭会销毁 WebView，IPC 应答可能随页面消失；只有随后实际观察到关闭才接受。
      closeRequestCompletionError = String(error);
    });
  await nativePageClosed;
  await writeFile(
    `${output}/settings-results.json`,
    `${JSON.stringify(
      {
        ...result,
        restoredOriginalPreferences: true,
        nativeWindowClosedAfterPreferenceRestore: true,
        closeRequestCompletionError,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(
    'Real Settings UI/native SQLite roundtrip passed; original defaults restored.\n',
  );
} finally {
  await browser.close();
}
