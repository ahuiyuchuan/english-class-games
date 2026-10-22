/**
 * Actual WebView2/Tauri IPC smoke check against a separate smoke application ID.
 * Start Tauri with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
 * and identifier com.ahui.english-class-games.native-smoke, then run with Node.
 * This script never substitutes browser mocks for native SQLite or WinRT calls.
 * @author ahui
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../target/native-validation/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes(':1420'));
  assert.ok(page, 'A live Tauri WebView2 page is required.');
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
  const result = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const dataEpoch = await invoke('get_data_epoch');
    if (!Number.isSafeInteger(dataEpoch) || dataEpoch <= 0)
      throw new Error('The registered epoch getter must return a positive safe integer.');
    const call = (command, args = {}) => invoke(command, { ...args, dataEpoch });
    const location = await call('get_data_location');
    if (!location.includes('native-smoke'))
      throw new Error('Refusing to mutate a non-smoke data directory.');
    const id = crypto.randomUUID();
    const checks = [];
    const taskIds = [];
    // JSON object member order is not part of the IPC contract; native Serde may
    // reorder keys without changing the preserved teaching/provenance values.
    const canonical = (value) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
            )
          : item,
      );
    const originalShared = {
      materials: await call('get_app_data', { key: 'materials' }),
      commonWords: await call('get_app_data', { key: 'commonWords' }),
    };
    try {
      let missingEpoch;
      try {
        await invoke('set_app_data', { key: 'preferences', value: { shouldNotWrite: true } });
      } catch (error) {
        missingEpoch = error.code;
      }
      if (missingEpoch !== 'DATA_REPLACED') throw new Error('An epoch-less write was admitted.');
      checks.push('Actual get_data_epoch registration and missing-epoch write rejection');
      const entry = {
        id: crypto.randomUUID(),
        english: 'responsibility',
        meaning: '责任',
        priority: true,
        partOfSpeech: '😀'.repeat(40),
        unit: '单'.repeat(80),
        tags: Array.from({ length: 10 }, (_, index) => `${'😀'.repeat(23)}${index}`),
        confirmed: true,
        meaningSource: {
          name: '冒烟参考词库',
          version: '1',
          english: 'responsibility',
          originalMeaning: '参考释文'.repeat(100),
          reviewStatus: 'reference',
          candidateSource: 'common',
          teacherRevised: true,
          acceptedFields: ['meaning'],
        },
      };
      const historical = structuredClone(entry);
      historical.id = crypto.randomUUID();
      delete historical.meaningSource.reviewStatus;
      delete historical.meaningSource.candidateSource;
      const shared = [entry, historical];
      await call('set_app_data', { key: 'commonWords', value: shared });
      const actualShared = await call('get_app_data', { key: 'commonWords' });
      if (canonical(actualShared) !== canonical(shared))
        throw new Error('Source metadata was rewritten or historical review was fabricated.');
      const material = {
        id: crypto.randomUUID(),
        name: '原生材料门禁',
        original: 'High school reading source',
        entries: shared,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await call('set_app_data', { key: 'materials', value: [material] });
      for (const [field, value] of [
        ['partOfSpeech', '😀'.repeat(41)],
        ['unit', '单'.repeat(81)],
        ['tags', Array.from({ length: 11 }, (_, index) => String(index))],
        ['tags', ['😀'.repeat(25)]],
      ]) {
        const invalid = structuredClone(material);
        invalid.entries[0][field] = value;
        let rejected;
        try {
          await call('set_app_data', { key: 'materials', value: [invalid] });
        } catch (error) {
          rejected = error.code;
        }
        if (rejected !== 'VALIDATION_ERROR') throw new Error(`Native ${field} limit was bypassed.`);
        const preserved = await call('get_app_data', { key: 'materials' });
        if (canonical(preserved) !== canonical([material]))
          throw new Error('A rejected material write replaced the prior data.');
      }
      checks.push('Native Unicode metadata limits and rejected-write preservation');
      checks.push('Reference/unknown review snapshots and full provenance roundtrip');
      let rejectedRestore;
      try {
        // No native file-dialog grant exists for this token. This executes the
        // actual safety-backup/maintenance path and must leave the live library
        // and renderer epoch intact when the selected backup cannot be opened.
        await call('restore_backup', { token: `unselected-${crypto.randomUUID()}` });
      } catch (error) {
        rejectedRestore = error.code;
      }
      if (rejectedRestore !== 'VALIDATION_ERROR')
        throw new Error('An unselected restore token passed.');
      if ((await invoke('get_data_epoch')) !== dataEpoch)
        throw new Error('A failed restore replaced the live data epoch.');
      const afterRestore = await call('get_app_data', { key: 'materials' });
      if (canonical(afterRestore) !== canonical([material]))
        throw new Error('A rejected restore changed the live teaching material.');
      checks.push('Actual safety-backup/failed-restore IPC preserves metadata and data epoch');
      const document = {
        id,
        name: '原生持久化验证',
        gameId: 'word-beat',
        dataVersion: 1,
        gameData: {},
        draftInputs: { rounds: { raw: '-', message: '请补全数字。' } },
      };
      const saved = await call('save_lesson', { document, expectedRevision: 0 });
      if (saved.revision !== 1 || saved.draftInputs.rounds.raw !== '-')
        throw new Error('Native draft persistence failed.');
      let conflict;
      try {
        await call('save_lesson', { document, expectedRevision: 0 });
      } catch (error) {
        conflict = error.code;
      }
      if (conflict !== 'REVISION_CONFLICT') throw new Error('Stale native save was not rejected.');
      let validation;
      try {
        await call('mark_prepared', {
          lessonId: id,
          revision: 1,
          requiredAssetIds: [],
          allowHistorical: false,
        });
      } catch (error) {
        validation = error.code;
      }
      if (validation !== 'VALIDATION_ERROR') throw new Error('Unfinished draft was prepared.');
      checks.push('SQLite revision CAS and unfinished input protection');
      const ownerId = crypto.randomUUID();
      await call('retain_assets', { ownerId, assetIds: [], lessonId: id, revision: 1 });
      await call('release_assets', { ownerId });
      checks.push('Native revision retention IPC');
      const voices = await call('list_voices');
      const started = await call('synthesize_speech', {
        lessonId: id,
        inputRevision: 1,
        retryOf: null,
        items: [
          {
            requestId: 'missing',
            objectId: id,
            text: 'responsibility',
            language: 'en-US',
            voiceId: 'unavailable-smoke-voice',
            rate: 1,
          },
        ],
      });
      taskIds.push(started.taskId);
      let task = started;
      for (
        let attempt = 0;
        attempt < 100 && ['queued', 'running', 'cancelling'].includes(task.state);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        task = await call('get_task', { taskId: started.taskId });
      }
      if (task.state !== 'failed' || task.failures[0]?.error.code !== 'VOICE_UNAVAILABLE')
        throw new Error(
          'Unavailable real WinRT voice did not produce a terminal repairable failure.',
        );
      await call('clear_task', { taskId: started.taskId });
      checks.push('Real WinRT prerequisite detection and background task failure');
      let synthesis;
      if (voices.length > 0) {
        // A real installed Chinese voice exercises the complete WinRT -> WAV ->
        // native asset -> actual browser decoder path on this machine. Its success
        // must not be reported as English-voice availability.
        const voice = voices.find((candidate) => candidate.language === 'zh-CN') ?? voices[0];
        const items = [
          {
            requestId: 'real',
            objectId: id,
            text: voice.language.startsWith('zh') ? '准备好，跟着节奏开口。' : 'Get ready to read.',
            language: voice.language,
            voiceId: voice.id,
            rate: 1,
          },
        ];
        const first = await call('synthesize_speech', { lessonId: id, inputRevision: 1, items });
        taskIds.push(first.taskId);
        let completed = first;
        for (
          let attempt = 0;
          attempt < 650 && ['queued', 'running', 'cancelling'].includes(completed.state);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          completed = await call('get_task', { taskId: first.taskId });
        }
        if (completed.state !== 'completed' || completed.results.length !== 1)
          throw new Error(
            `Actual installed-voice synthesis failed: ${JSON.stringify(completed.failures)}`,
          );
        const asset = await call('read_asset', { assetId: completed.results[0].asset.assetId });
        const buffer = await (await fetch(asset.dataUrl)).arrayBuffer();
        const audio = new AudioContext();
        let duration;
        try {
          duration = (await audio.decodeAudioData(buffer)).duration * 1000;
        } finally {
          await audio.close();
        }
        if (duration <= 0 || Math.abs(duration - asset.durationMs) > 100)
          throw new Error('Actual native speech metadata did not match browser decoding.');
        synthesis = {
          voice: voice.name,
          language: voice.language,
          byteLength: asset.byteLength,
          nativeDurationMs: asset.durationMs,
          browserDurationMs: duration,
        };
        checks.push('Actual installed-voice WinRT synthesis and Web Audio PCM decoding');
      }
      const copies = await call('list_export_copies');
      if (!Array.isArray(copies.files)) throw new Error('Export-copy listing failed.');
      checks.push('Export-copy management IPC');
      return {
        checkedAt: new Date().toISOString(),
        location,
        dataEpoch,
        checks,
        voices,
        synthesis,
        englishVoiceAvailable: voices.some((voice) => voice.language.startsWith('en-')),
      };
    } finally {
      for (const taskId of taskIds) {
        await call('clear_task', { taskId }).catch(() => {});
      }
      await call('delete_lesson', { lessonId: id });
      await call('clean_cache');
      for (const [key, value] of Object.entries(originalShared)) {
        // Missing app-data reads use null; an empty list is its public default.
        // Only this isolated test library is touched, never the formal library.
        await call('set_app_data', { key, value: value ?? [] });
      }
    }
  });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await writeFile(`${output}/ipc-results.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
