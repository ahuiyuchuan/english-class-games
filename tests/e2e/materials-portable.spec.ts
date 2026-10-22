/**
 * 真实 file:// 课堂验收：夹具经公共协议和正式导出器生成，再在断网 Chromium 中运行。
 * 不用手写播放器、远程服务或模拟 TTS 成功来替代便携交付。
 * @author ahui
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { unzipSync } from 'fflate';
import type { AssetMap } from '../../src/platform/types';
import type { WordBeatLesson } from '../../src/games/word-beat/model';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const escapedText = '</script><script>window.lessonTextExecuted=true</script>';
// 与应用贯穿案例的80字中文副本互补，覆盖没有空格断点的最长英文课件名。
const longLessonName = 'AdvancedVocabularyRhythm'.repeat(4).slice(0, 80);
let fixtureDirectory: string;
let teacherFile: string;
let safeTextFile: string;
let voiceFile: string;
let longTextFile: string;
const invalidFiles = new Map<string, string>();
const beatFiles = new Map<string, string>();
// 完成等待使用正式编排总时长；长拍数组合不能套用默认的 10 秒断言预算。
const beatDurations = new Map<string, number>();

// 同时覆盖用户的浏览器内容尺寸、标题栏扣高和三个响应式断点；这里均为 CSS 像素。
const lobbyViewports = [
  { width: 1920, height: 953 },
  { width: 1366, height: 681 },
  { width: 1366, height: 768 },
  { width: 911, height: 480 },
  { width: 700, height: 480 },
  { width: 701, height: 480 },
  { width: 999, height: 640 },
  { width: 1000, height: 640 },
  { width: 1000, height: 639 },
  { width: 1920, height: 480 },
];

/**
 * 开始前检查实际内部滚动区域，避免外层 overflow:hidden 掩盖开场横向溢出。
 * 每个视口分别采集布局落定和真实悬浮后的尺寸，不替换或推进课堂时间。
 * @param page 已断网打开真实 file:// 课件的页面；调用时仍停留在开场。
 * @param lessonName 完整课件名称，包含长英文时也必须保留全部文本。
 * @param normalLesson 是否为普通交付样本；宽至少 911、高至少 480 时开场不得纵向滚动。
 * @returns 各视口两个时刻的真实尺寸与滚动量，供失败定位和交付证据使用。
 */
async function verifyLobbyLayouts(page: Page, lessonName: string, normalLesson: boolean) {
  const measurements = [];
  const start = page.getByRole('button', { name: '开始课堂', exact: true });
  const sound = page.getByRole('button', { name: '测试声音', exact: true });
  await expect(page.locator('.ecg-classroom')).toHaveAttribute('data-motion', 'true');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(lessonName);
  // 静音课件不提供无效试听；新增课前全屏后，它是开始按钮前的实际焦点。
  const beforeStart =
    (await sound.count()) > 0 ? sound : page.getByRole('button', { name: '全屏', exact: true });
  for (const viewport of lobbyViewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const lobby = document.querySelector<HTMLElement>('.ecg-classroom-lobby')!;
      lobby.scrollTop = 0;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    for (const sample of ['initial', 'floating'] as const) {
      if (sample === 'floating') {
        // 只观察真实 CSS 动画经过的时间；需要捕获悬浮轨道产生的内部溢出。
        await page.waitForTimeout(360);
      }
      const measurement = await page.evaluate(() => {
        const lobby = document.querySelector<HTMLElement>('.ecg-classroom-lobby')!;
        const title = lobby.querySelector('h1')!;
        const originalLeft = lobby.scrollLeft;
        lobby.scrollLeft = 1_000_000;
        const horizontalScroll = lobby.scrollLeft;
        lobby.scrollLeft = originalLeft;
        const horizontalContainers = [...document.querySelectorAll<HTMLElement>('*')]
          .filter((element) => {
            const style = getComputedStyle(element);
            return (
              /^(auto|scroll)$/u.test(style.overflowX) &&
              element.scrollWidth > element.clientWidth + 1
            );
          })
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          }));
        return {
          viewport: { width: innerWidth, height: innerHeight },
          lobby: {
            scrollWidth: lobby.scrollWidth,
            clientWidth: lobby.clientWidth,
            scrollHeight: lobby.scrollHeight,
            clientHeight: lobby.clientHeight,
            horizontalScroll,
          },
          title: {
            text: title.textContent,
            scrollWidth: title.scrollWidth,
            clientWidth: title.clientWidth,
          },
          horizontalContainers,
          documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
          documentOverflowY: document.documentElement.scrollHeight > innerHeight + 1,
        };
      });
      const label = `${viewport.width}×${viewport.height} ${sample}`;
      expect(measurement.lobby.scrollWidth, label).toBeLessThanOrEqual(
        measurement.lobby.clientWidth + 1,
      );
      expect(measurement.lobby.horizontalScroll, label).toBe(0);
      expect(measurement.horizontalContainers, label).toEqual([]);
      expect(measurement.documentOverflowX, label).toBe(false);
      expect(measurement.documentOverflowY, label).toBe(false);
      expect(measurement.title.text, label).toBe(lessonName);
      expect(measurement.title.scrollWidth, label).toBeLessThanOrEqual(
        measurement.title.clientWidth + 1,
      );
      if (normalLesson && viewport.width >= 911 && viewport.height >= 480) {
        expect(measurement.lobby.scrollHeight, label).toBeLessThanOrEqual(
          measurement.lobby.clientHeight + 1,
        );
      }
      measurements.push({ sample, ...measurement });
    }
    // 长标题可以纵向滚动，但按钮不能被裁掉；Tab 跟随实际存在的操作顺序。
    await beforeStart.focus();
    await page.keyboard.press('Tab');
    await expect(start).toBeFocused();
    await expect(
      start,
      JSON.stringify({ viewport, button: await start.boundingBox() }),
    ).toBeInViewport({ ratio: 1 });
    await start.click({ trial: true });
    await beforeStart.click({ trial: true });
  }
  return measurements;
}

/**
 * 自然完成和教师主动结束共用真实结算页；低高度下统计与重播/返回按钮须同时可见。
 * 只调整浏览器视口，不改课件、课堂时间、缩放或滚动条样式。
 * @param page 已通过实际课堂进入结算的本地页面。
 * @param ending finished为自然整课完成，ended为教师实际点击结束，不能相互代替。
 * @returns 三个视口的双轴尺寸和结算各区域边界，用于定位裁切或内部滚动。
 */
async function verifyCompletionLayouts(page: Page, ending: 'finished' | 'ended') {
  const originalViewport = page.viewportSize();
  const measurements = [];
  try {
    await expect(
      page.getByText(ending === 'finished' ? '练习完成' : '已提前结束', { exact: true }),
    ).toBeVisible();
    for (const viewport of [
      { width: 911, height: 480 },
      { width: 1920, height: 480 },
      { width: 1920, height: 953 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      const measurement = await page.evaluate(() => {
        const complete = document.querySelector<HTMLElement>('.ecg-classroom-completed')!;
        const dimensions = (element: HTMLElement) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        });
        return {
          viewport: { width: innerWidth, height: innerHeight },
          document: dimensions(document.documentElement),
          classroom: dimensions(document.querySelector<HTMLElement>('.ecg-classroom')!),
          completed: dimensions(complete),
          regions: [
            ...complete.querySelectorAll<HTMLElement>(
              'h1, .ecg-session-stats, .ecg-classroom-caption, button',
            ),
          ].map((element) => {
            const box = element.getBoundingClientRect();
            return {
              text: element.textContent?.trim(),
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
          }),
        };
      });
      const label = `${ending} ${viewport.width}×${viewport.height}`;
      for (const region of [measurement.document, measurement.classroom, measurement.completed]) {
        expect(region.scrollWidth, label).toBeLessThanOrEqual(region.clientWidth + 1);
        expect(region.scrollHeight, label).toBeLessThanOrEqual(region.clientHeight + 1);
      }
      for (const region of measurement.regions) {
        expect(region.width, label).toBeGreaterThan(0);
        expect(region.height, label).toBeGreaterThan(0);
        expect(region.left, `${label} ${region.text}`).toBeGreaterThanOrEqual(0);
        expect(region.top, `${label} ${region.text}`).toBeGreaterThanOrEqual(0);
        expect(region.right, `${label} ${region.text}`).toBeLessThanOrEqual(viewport.width);
        expect(region.bottom, `${label} ${region.text}`).toBeLessThanOrEqual(viewport.height);
      }
      const replay = page.getByRole('button', { name: '重新播放', exact: true });
      const back = page.getByRole('button', { name: '回到开始页', exact: true });
      await expect(replay).toBeInViewport({ ratio: 1 });
      await expect(back).toBeInViewport({ ratio: 1 });
      await replay.click({ trial: true });
      await back.click({ trial: true });
      measurements.push({ ending, ...measurement });
    }
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
  return measurements;
}

/** 合法 PCM WAV 是受控声音夹具；只验证播放机制，不将正弦波称为真人配音。 */
function createWaveFixture(): Uint8Array {
  const sampleRate = 44_100;
  const frames = 18_000;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1)
    view.setInt16(
      44 + frame * 2,
      Math.round(Math.sin((frame * 2 * Math.PI * 440) / sampleRate) * 2_000),
      true,
    );
  return new Uint8Array(buffer);
}

/** 全部测试只读取本地文件；任何 HTTP 请求都记录为失败证据。 */
async function openOffline(context: BrowserContext, page: Page, file: string) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url())) requests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  await context.route(/^https?:/u, (route) => route.abort());
  await page.addInitScript(() => {
    // 携带成品必须用预先准备的声音，接触系统朗读即使断网也不算便携播放通过。
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      get() {
        throw new Error('课堂不应访问系统朗读');
      },
    });
  });
  await page.goto(pathToFileURL(file).href);
  const protocol = await page.evaluate(() => window.location.protocol);
  if (protocol !== 'file:') throw new Error(`便携验收必须直接打开本地文件，实际为 ${protocol}`);
  return { requests, errors, protocol };
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'english-class-games-便携验收-'));
  // Vite SSR 正确加载正式 TS/TSX/JSON 与 CSS 依赖；Node 直接导入会错误地绕过课堂构建链。
  const server = await createServer({
    root: projectRoot,
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
  });
  try {
    const exporter = (await server.ssrLoadModule(
      '/src/portable/export.ts',
    )) as typeof import('../../src/portable/export');
    const rules = (await server.ssrLoadModule(
      '/src/games/word-beat/rules.ts',
    )) as typeof import('../../src/games/word-beat/rules');
    const schema = (await server.ssrLoadModule(
      '/src/shared/schemas/lesson-package.ts',
    )) as typeof import('../../src/shared/schemas/lesson-package');
    const createTeacher = (name: string): WordBeatLesson => {
      const lesson = rules.createWordBeatLesson(
        [
          { id: 'one', english: 'knowledge', meaning: escapedText, priority: true },
          { id: 'two', english: 'concentrate', meaning: '集中注意力', priority: false },
        ],
        { name, soundMode: 'teacher', seed: 123 },
      );
      lesson.revision = 1;
      lesson.gameData.beatEnabled = false;
      lesson.gameData.progression = 'step';
      // 此夹具专门覆盖教师等待与设置重开；发行默认由后面的实际交付示例独立验证。
      lesson.gameData.displayMode = 'centered';
      Object.values(lesson.gameData.slogans).forEach((slogan) => {
        slogan.enabled = false;
      });
      for (const entry of rules.getEntries(lesson)) {
        entry.rounds = { value: 1, source: 'manual', locked: false };
        entry.modelBeats = { value: 1, source: 'manual', locked: false };
        entry.follow = { mode: 'manual', beats: 1, locked: false };
      }
      // 课件经实际协议验证和 JSON 往返，防止只对内存里恰巧合法的对象进行验收。
      return schema.validatePackageData(
        JSON.parse(JSON.stringify(schema.createPackageData(lesson))),
      ).revisions[0] as WordBeatLesson;
    };
    teacherFile = join(fixtureDirectory, '高二课堂_无音色也可用.html');
    await writeFile(
      teacherFile,
      await exporter.createClassroomHtml(createTeacher('高中词汇离线课堂'), {}),
      'utf8',
    );
    safeTextFile = join(fixtureDirectory, '教学文本安全.html');
    await writeFile(
      safeTextFile,
      await exporter.createClassroomHtml(createTeacher(escapedText), {}),
      'utf8',
    );
    const longText = createTeacher(longLessonName);
    longText.gameData.segments[0].entries[0].english = 'W'.repeat(120);
    longText.gameData.segments[0].entries[0].meaning = '高中词汇完整教学释义'.repeat(20);
    longTextFile = join(fixtureDirectory, '连续英文与完整释义.html');
    await writeFile(longTextFile, await exporter.createClassroomHtml(longText, {}), 'utf8');
    for (const mode of ['blocks', 'centered'] as const) {
      for (const [model, follow] of [
        [1, 1],
        [2, 2],
        [3, 2],
        [5, 3],
      ]) {
        const beatLesson = createTeacher('连续拍位离线回归');
        beatLesson.gameData.progression = 'auto';
        beatLesson.gameData.displayMode = mode;
        // 保留第二词，验证新词自动衔接；第一词两轮验证轮次重置。
        const entry = beatLesson.gameData.segments[0].entries[0];
        entry.rounds.value = 2;
        entry.modelBeats.value = model;
        entry.follow.beats = follow;
        const key = `${mode}-${model}-${follow}`;
        const file = join(fixtureDirectory, `${key}.html`);
        beatFiles.set(key, file);
        beatDurations.set(key, rules.compileWordBeat(beatLesson, {}).durationMs);
        await writeFile(file, await exporter.createClassroomHtml(beatLesson, {}), 'utf8');
      }
    }
    const voiced = createTeacher('内嵌声音断网课堂');
    voiced.gameData.segments[0].entries.splice(1);
    voiced.gameData.soundMode = 'voiced';
    const assetId = '__proto__';
    const bytes = createWaveFixture();
    const assets: AssetMap = Object.create(null) as AssetMap;
    assets[assetId] = {
      assetId,
      mimeType: 'audio/wav',
      byteLength: bytes.byteLength,
      durationMs: 409,
      sha256: await exporter.sha256Bytes(bytes),
      dataUrl: `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`,
    };
    voiced.gameData.segments[0].entries[0].audio = {
      source: 'recording',
      assetId,
      text: 'knowledge',
      language: 'en-US',
      rate: 1,
      status: 'ready',
    };
    voiceFile = join(fixtureDirectory, '声音已随课件携带.html');
    const voicedHtml = await exporter.createClassroomHtml(voiced, assets);
    await writeFile(voiceFile, voicedHtml, 'utf8');
    const dataPattern = /(<script id="ecg-data" type="application\/json">)([^]*?)(<\/script>)/u;
    const payloadText = dataPattern.exec(voicedHtml)![2];
    for (const [name, change] of [
      [
        '声音内容损坏',
        (payload: Record<string, unknown>) => {
          const asset = (payload.assets as AssetMap)[assetId];
          // 保持合法base64和原字节数量，只改最后一个音频字节以证明检查了实际SHA-256。
          const damaged = bytes.slice();
          damaged[damaged.length - 1] ^= 1;
          asset.dataUrl = `data:audio/wav;base64,${Buffer.from(damaged).toString('base64')}`;
        },
      ],
      [
        '声音引用缺失',
        (payload: Record<string, unknown>) => {
          payload.assets = {};
        },
      ],
      [
        '运行版本不兼容',
        (payload: Record<string, unknown>) => {
          // 当前支持1～3，使用真正未支持的下一版验证拒绝，而非把已支持的齐读版当损坏。
          payload.runtimeVersion = 4;
        },
      ],
      [
        '课件结构损坏',
        (payload: Record<string, unknown>) => {
          (
            (payload.lesson as WordBeatLesson).gameData as unknown as Record<string, unknown>
          ).segments = null;
        },
      ],
    ] as const) {
      const payload = JSON.parse(payloadText) as Record<string, unknown>;
      change(payload);
      const file = join(fixtureDirectory, `${name}.html`);
      invalidFiles.set(name, file);
      await writeFile(
        file,
        voicedHtml.replace(
          dataPattern,
          (_match, start: string, _data: string, end: string) =>
            `${start}${exporter.serializeEmbeddedJson(payload)}${end}`,
        ),
        'utf8',
      );
    }
  } finally {
    await server.close();
  }
});

test.afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

for (const mode of ['blocks', 'centered']) {
  for (const [model, follow] of [
    [1, 1],
    [2, 2],
    [3, 2],
    [5, 3],
  ]) {
    test(`实际HTML ${mode} ${model}+${follow}拍连续高亮，两轮后自动完成`, async ({
      context,
      page,
    }, testInfo) => {
      const observed = await openOffline(
        context,
        page,
        beatFiles.get(`${mode}-${model}-${follow}`)!,
      );
      // 观察真实 DOM 的逐拍变化，不替换设备时钟、不手动切词或借测试钩子推进。
      await page.evaluate(() => {
        type Sample = {
          phase: string;
          round: number;
          pad: number;
          reached: number;
          visible: boolean;
        };
        const samples: Sample[] = [];
        const root = document.querySelector('.ecg-classroom')!;
        const record = () => {
          const stage = root.querySelector<HTMLElement>('.ecg-classroom-stage');
          const word = root.querySelector('.teaching-content__word')?.textContent;
          if (!stage || word !== 'knowledge' || !['model', 'follow'].includes(stage.dataset.phase!))
            return;
          const pad = root.querySelector<HTMLElement>('.ecg-pulse-active');
          if (!pad) return;
          const sample = {
            phase: stage.dataset.phase!,
            round: Number(
              /第 (\d+) \//u.exec(root.querySelector('.ecg-classroom-detail')!.textContent!)?.[1],
            ),
            pad: Number(pad.querySelector('.ecg-beat-number')!.textContent),
            reached: root.querySelectorAll('.ecg-beat-block[data-reached="true"]').length,
            visible:
              pad.getBoundingClientRect().width > 0 &&
              getComputedStyle(pad).visibility === 'visible',
          };
          const last = samples.at(-1);
          if (
            !last ||
            sample.phase !== last.phase ||
            sample.round !== last.round ||
            sample.pad !== last.pad
          )
            samples.push(sample);
        };
        const observer = new MutationObserver(record);
        observer.observe(root, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
        Object.assign(window, {
          ecgBeatEvidence: samples,
          ecgStopBeatEvidence: () => observer.disconnect(),
        });
      });
      await page.getByRole('button', { name: '开始课堂', exact: true }).click();
      // 真实等待整课自然结束，额外两秒仅供页面绘制；逐拍断言仍严格比对全部拍序。
      await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible({
        timeout: beatDurations.get(`${mode}-${model}-${follow}`)! + 2_000,
      });
      const samples = await page.evaluate(() => {
        const recorded = window as typeof window & {
          ecgBeatEvidence: {
            phase: string;
            round: number;
            pad: number;
            reached: number;
            visible: boolean;
          }[];
          ecgStopBeatEvidence: () => void;
        };
        recorded.ecgStopBeatEvidence();
        return recorded.ecgBeatEvidence;
      });
      const expected = [1, 2].flatMap((round) =>
        Array.from({ length: model + follow }, (_, beat) => ({
          phase: beat < model ? 'model' : 'follow',
          round,
          pad: (beat % 4) + 1,
          reached: Math.min(4, beat + 1),
          visible: true,
        })),
      );
      expect(samples).toEqual(expected);
      await writeFile(
        testInfo.outputPath('actual-beat-sequence.json'),
        JSON.stringify({ mode, model, follow, expected, samples }, null, 2) + '\n',
        'utf8',
      );
      await expect(page.getByLabel(/已完成 2 \/ 2 条/u)).toBeVisible();
      expect(observed.requests).toEqual([]);
      expect(observed.errors).toEqual([]);
    });
  }
}

test('文字领读在真实本地文件中可暂停、切词、重读、调节并逐词推进', async ({ context, page }) => {
  const observed = await openOffline(context, page, teacherFile);
  expect(observed.protocol).toBe('file:');
  await expect(page.getByRole('heading', { name: '高中词汇离线课堂', exact: true })).toBeVisible();
  // 新游戏页眉将声音模式与品牌组合展示；仍精确核验模式，不用课件名中的同名子串代替。
  await expect(
    page.getByRole('banner').getByText('WORD BEAT / 文字领读', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '测试声音', exact: true })).toHaveCount(0);
  await expect(page.getByText('本课按画面节奏练习，未启用声音。')).toBeVisible();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  const controls = page.locator('footer');
  await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
  await controls.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
  await expect(controls.getByRole('button', { name: '上一词', exact: true })).toBeDisabled();
  await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'concentrate', exact: true })).toBeVisible();
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  await controls.getByRole('button', { name: '上一词', exact: true }).click();
  await controls.getByRole('button', { name: '重读', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
  await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption('blocks');
  // 画面变化和节奏由底部统一完成，草稿不提前修改课堂。
  await page.getByLabel('显示释义', { exact: true }).uncheck();
  await page.getByRole('spinbutton', { name: /^节奏 BPM/u }).fill('500');
  // 非法输入即时定位且禁用提交，不再依赖点击“应用”才发现错误。
  await expect(page.getByRole('button', { name: '应用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('50～180');
  await page.getByRole('spinbutton', { name: /^节奏 BPM/u }).fill('120');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('节奏已更新');
  await controls.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByText('等待教师', { exact: true })).toBeVisible();
  // 等待并非暂停：此时新节奏只作用于下一词，重读本词必须保留本词节奏。
  await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('spinbutton', { name: /^节奏 BPM/u }).fill('140');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('节奏将在下一词生效');
  await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(page.getByText(/当前节奏：120 BPM。待生效：140 BPM/u)).toBeVisible();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await controls.getByRole('button', { name: '重读', exact: true }).click();
  await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(page.getByText(/当前节奏：120 BPM。待生效：140 BPM/u)).toBeVisible();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  // 重读正在播放时打开设置会暂停；继续后再等待本词自然完成。
  await controls.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByText('等待教师', { exact: true })).toBeVisible();
  // 快捷键不劫持按钮/输入焦点；显式移开焦点以模拟教师对课堂画面的键盘操作。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'concentrate', exact: true })).toBeVisible();
  // 末词会直接收尾；先暂停留住实际已生效的下一词，避免检查与短阶段自然结束竞争。
  await controls.getByRole('button', { name: '暂停', exact: true }).click();
  await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(page.getByText('当前节奏：140 BPM。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await controls.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible();
  await expect(page.getByLabel('主动重读 2 次', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新播放', exact: true }).click();
  await expect(page.locator('footer')).toBeVisible();
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('教学文本按原文显示且不会执行脚本，关闭重开恢复课件初始设置', async ({ context, page }) => {
  const observed = await openOffline(context, page, safeTextFile);
  expect(observed.protocol).toBe('file:');
  await expect(page).toHaveTitle(escapedText);
  await expect(page.getByRole('heading', { name: escapedText, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.locator('footer').getByRole('button', { name: '下一词', exact: true }).last().click();
  await expect(page.locator('.teaching-content__meaning')).toHaveText(escapedText);
  expect(await page.evaluate(() => Object.hasOwn(window, 'lessonTextExecuted'))).toBe(false);
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption('blocks');
  await page.reload();
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
  await expect(page.locator('.ecg-classroom--centered')).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'lessonTextExecuted'))).toBe(false);
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('实际内嵌WAV在完全断网和无系统朗读时完成课堂，特殊素材身份保持完整', async ({
  context,
  page,
}) => {
  const html = await readFile(voiceFile, 'utf8');
  const data = /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(html);
  expect(data).not.toBeNull();
  const payload = JSON.parse(data![1]) as { assets: AssetMap };
  expect(Object.hasOwn(payload.assets, '__proto__')).toBe(true);
  expect(payload.assets.__proto__.dataUrl).toMatch(/^data:audio\/wav;base64,/u);
  expect(Buffer.from(payload.assets.__proto__.dataUrl!.split(',')[1], 'base64')).toEqual(
    Buffer.from(createWaveFixture()),
  );
  const observed = await openOffline(context, page, voiceFile);
  expect(observed.protocol).toBe('file:');
  await expect(
    page.getByRole('banner').getByText('WORD BEAT / 配音跟读', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible();
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('课堂文件只含内嵌脚本与样式，CSP 禁止网络依赖', async ({ context, page }) => {
  const html = await readFile(teacherFile, 'utf8');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("connect-src 'none'");
  const observed = await openOffline(context, page, teacherFile);
  // Player execution is still a single script. Lesson JSON and the source ZIP
  // are non-executable data blocks and cannot enable an external dependency.
  await expect(page.locator('script:not([type])')).toHaveCount(1);
  await expect(page.locator('#ecg-data')).toHaveAttribute('type', 'application/json');
  await expect(page.locator('#ecg-source')).toHaveAttribute('type', 'application/octet-stream');
  expect(
    await page
      .locator('script[src],link[href],img[src],audio[src],source[src],iframe[src]')
      .count(),
  ).toBe(0);
  expect(observed.protocol).toBe('file:');
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('三模式实际导出保留许可和同版本源码，断网可下载且可编辑内容不改为GPL', async ({
  context,
  page,
}, testInfo) => {
  const source = JSON.parse(
    await readFile(join(projectRoot, 'resources/source/portable-source.json'), 'utf8'),
  ) as { sha256: string; bytes: number };
  const license = await readFile(join(projectRoot, 'LICENSE'), 'utf8');
  for (const mode of ['配音跟读', '文字领读', '学生自主齐读']) {
    const file = join(projectRoot, 'examples', `高中单词节拍-${mode}.html`);
    const observed = await openOffline(context, page, file);
    const embedded = page.locator('#ecg-source');
    await expect(embedded).toHaveAttribute('data-sha256', source.sha256);
    await page.locator('.software-license > summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.software-license')).toContainText(
      '教学内容、录音、BGM和生成音频保留各自权利',
    );
    await page.getByText('GNU GPL v3 完整许可', { exact: true }).click();
    await expect(page.locator('.about-notices').first()).toHaveText(license);
    await page.getByText('GNU GPL v3 完整许可', { exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载播放器对应源码', exact: true }).click();
    const download = await pending;
    const destination = testInfo.outputPath(`source-${mode}.zip`);
    await download.saveAs(destination);
    const bytes = await readFile(destination);
    expect(bytes.length).toBe(source.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    const files = unzipSync(bytes);
    expect(new TextDecoder().decode(files.LICENSE)).toBe(license);
    expect(files['src/games/word-beat/Classroom.tsx']).toBeDefined();
    expect(files['scripts/build-portable.mjs']).toBeDefined();
    const editable = unzipSync(await readFile(file.replace(/\.html$/u, '.ecglesson')));
    expect(new TextDecoder().decode(editable['license.txt'])).toContain(
      'Teaching content retains its own rights',
    );
    await page.screenshot({ path: testInfo.outputPath(`offline-license-${mode}.png`) });
    await page.locator('.software-license > summary').click();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await expect(page.locator('.software-license')).toHaveCount(0);
    expect(observed.requests).toEqual([]);
    expect(observed.errors).toEqual([]);
  }
});

test('长课名开场在十组视口无内部横向滚动且可用键盘开始', async ({ context, page }, testInfo) => {
  const observed = await openOffline(context, page, longTextFile);
  const measurements = await verifyLobbyLayouts(page, longLessonName, false);
  await writeFile(
    testInfo.outputPath('long-lobby-layouts.json'),
    `${JSON.stringify(measurements, null, 2)}\n`,
    'utf8',
  );
  await page.getByRole('button', { name: '开始课堂', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ecg-classroom-stage')).toBeVisible();
  await expect(page.locator('.ecg-classroom-lobby')).toHaveCount(0);
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

for (const mode of ['配音跟读', '文字领读']) {
  test(`实际交付${mode}开场无横条、正常窗口无纵向滚动且开始可点`, async ({
    context,
    page,
  }, testInfo) => {
    const file = join(projectRoot, 'examples', `高中单词节拍-${mode}.html`);
    const observed = await openOffline(context, page, file);
    const measurements = await verifyLobbyLayouts(page, `高中单词节拍-${mode}`, true);
    await writeFile(
      testInfo.outputPath('release-lobby-layouts.json'),
      `${JSON.stringify({ file, mode, measurements }, null, 2)}\n`,
      'utf8',
    );
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await expect(page.locator('.ecg-classroom-stage')).toBeVisible();
    await expect(page.locator('.ecg-classroom-lobby')).toHaveCount(0);
    expect(observed.requests).toEqual([]);
    expect(observed.errors).toEqual([]);
  });
}

test('七组 CSS 视口及两种课堂画面保留全文、固定字号和可达控制', async ({
  context,
  page,
}, testInfo) => {
  const observed = await openOffline(context, page, longTextFile);
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  const controls = page.locator('footer');
  await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
  await controls.getByRole('button', { name: '暂停', exact: true }).click();
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1093, height: 614 },
    { width: 911, height: 512 },
    // 单独覆盖窗口标题栏等额外空间占用后的低高度，不冒充真实 Windows 缩放设置。
    { width: 911, height: 480 },
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
  ];
  const measurements = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const mode of ['centered', 'blocks']) {
      await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
      await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption(mode);
      await page.getByRole('button', { name: '完成设置', exact: true }).click();
      // Radix 关闭后异步归还焦点；等生命周期结束，再把焦点移入正文测试滚动。
      // 只等待弹窗消失会与归还焦点竞争，End 可能误发给设置按钮。
      await expect(controls.getByRole('button', { name: '课堂设置', exact: true })).toBeFocused();
      // ResizeObserver 的拟合在绘帧中完成；放大后旧的“需要滚动”快照可能已失效。
      // 等真实两帧并核对标记与尺寸一致，不要求已经完整显示的内容产生虚假滚动。
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page.locator(`.ecg-classroom--${mode}`)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'W'.repeat(120), exact: true })).toBeVisible();
      await expect(page.locator('.teaching-content__meaning')).toHaveText(
        '高中词汇完整教学释义'.repeat(20),
      );
      // 等待真实 ResizeObserver 排版，比较实际尺寸，不用截图外观替代可达性断言。
      await expect
        .poll(() =>
          page.evaluate(() => {
            const content = document.querySelector<HTMLElement>('.teaching-content')!;
            const text = document.querySelector<HTMLElement>('.teaching-content__text')!;
            return (
              text.scrollWidth <= content.clientWidth + 1 &&
              (content.dataset.overflow === 'true') === text.scrollHeight > content.clientHeight + 1
            );
          }),
        )
        .toBe(true);
      const measurement = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>('.teaching-content')!;
        const word = document.querySelector<HTMLElement>('.teaching-content__word')!;
        const meaning = document.querySelector<HTMLElement>('.teaching-content__meaning')!;
        const header = document.querySelector<HTMLElement>('.ecg-classroom-header')!;
        const headerTitle = header.querySelector('strong')!;
        const headerRect = header.getBoundingClientRect();
        return {
          cssViewport: { width: innerWidth, height: innerHeight },
          wordSize: Number.parseFloat(getComputedStyle(word).fontSize),
          meaningSize: Number.parseFloat(getComputedStyle(meaning).fontSize),
          horizontalPageOverflow: document.documentElement.scrollWidth > innerWidth,
          verticalPageOverflow: document.documentElement.scrollHeight > innerHeight + 1,
          contentScrolls: content.dataset.overflow === 'true',
          contentTabIndex: content.tabIndex,
          header: {
            lessonName: headerTitle.textContent,
            left: headerRect.left,
            right: headerRect.right,
            top: headerRect.top,
            bottom: headerRect.bottom,
            regions: [...header.children].map((region) => {
              const rect = region.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            }),
          },
          controls: [...document.querySelectorAll('footer button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              text: button.textContent,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          }),
        };
      });
      expect([144, 128, 112, 96, 80, 64, 48, 40]).toContain(measurement.wordSize);
      expect([64, 56, 48, 40, 36, 32, 28, 24]).toContain(measurement.meaningSize);
      expect(measurement.horizontalPageOverflow).toBe(false);
      expect(measurement.verticalPageOverflow).toBe(false);
      expect(measurement.header.lessonName).toBe(longLessonName);
      expect(measurement.header.left).toBeGreaterThanOrEqual(0);
      expect(measurement.header.right).toBeLessThanOrEqual(viewport.width);
      expect(measurement.header.top).toBeGreaterThanOrEqual(0);
      expect(measurement.header.bottom).toBeLessThanOrEqual(viewport.height);
      for (const region of measurement.header.regions) {
        expect(region.left).toBeGreaterThanOrEqual(measurement.header.left);
        expect(region.right).toBeLessThanOrEqual(measurement.header.right);
      }
      expect(measurement.header.regions[0].right).toBeLessThanOrEqual(
        measurement.header.regions[1].left,
      );
      if (measurement.contentScrolls) {
        expect(measurement.contentTabIndex).toBe(0);
        const content = page.locator('.teaching-content');
        await content.focus();
        await expect(content).toBeFocused();
        await page.keyboard.press('End');
        // Chromium 的键盘滚动有动画；必须到达末尾再发 Home，不能只等首帧位移。
        // 到达底部比仅出现位移更严格，确保全文末尾可达后再检查返回开头。
        await expect
          .poll(() =>
            content.evaluate((element) => {
              const bottom = element.scrollHeight - element.clientHeight;
              return JSON.stringify({
                atBottom: bottom > 0 && Math.abs(element.scrollTop - bottom) <= 1,
                top: element.scrollTop,
                bottom,
                focused: document.activeElement === element,
                overflow: element.dataset.overflow,
                height: element.clientHeight,
                textHeight: element.querySelector('.teaching-content__text')?.scrollHeight,
                active: document.activeElement?.textContent?.slice(0, 60),
                viewport: `${innerWidth}x${innerHeight}`,
              });
            }),
          )
          .toMatch(/"atBottom":true/u);
        await page.keyboard.press('Home');
        await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
      }
      for (const control of measurement.controls) {
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(viewport.width);
        expect(control.top).toBeGreaterThanOrEqual(0);
        expect(control.bottom).toBeLessThanOrEqual(viewport.height);
      }
      measurements.push({ mode, ...measurement });
      await page.screenshot({
        path: testInfo.outputPath(`classroom-${viewport.width}x${viewport.height}-${mode}.png`),
      });
    }
  }
  const layoutEvidenceFile = testInfo.outputPath('layout-measurements.json');
  await writeFile(layoutEvidenceFile, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
  await testInfo.attach('CSS视口排版测量（不代替Windows实机缩放验收）', {
    path: layoutEvidenceFile,
    contentType: 'application/json',
  });
  expect(observed.requests).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('桌面资源重建前后实际导出的新旧 HTML 均可离线控制且不改原文件', async ({
  context,
  page,
}, testInfo) => {
  const original = await readFile(teacherFile);
  const originalHash = createHash('sha256').update(original).digest('hex');
  const previousRuntime = JSON.parse(
    await readFile(join(projectRoot, 'src/portable/generated/runtime.json'), 'utf8'),
  ) as { script: string; style: string };

  // 故意继承测试环境：正式生成器必须自行固定生产条件，不能让依赖导出混入开发警告。
  // 仍重新生成桌面使用的课堂资源并验证实际新旧HTML，不用单独计算校验值代替运行。
  execFileSync(process.execPath, [join(projectRoot, 'scripts', 'build-portable.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'pipe',
    timeout: 120_000,
  });

  const unchanged = await readFile(teacherFile);
  expect(createHash('sha256').update(unchanged).digest('hex')).toBe(originalHash);
  // 以刚重建的运行核心再次导出同课件，确保升级后产生的新文件也能直接启动。
  const server = await createServer({
    root: projectRoot,
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic', jsxDev: false },
  });
  const oldFile = testInfo.outputPath('重建前导出的课堂.html');
  const refreshedFile = testInfo.outputPath('重建后新导出的课堂.html');
  await writeFile(oldFile, original);
  try {
    const exporter = (await server.ssrLoadModule(
      '/src/portable/export.ts',
    )) as typeof import('../../src/portable/export');
    const data = /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(
      original.toString('utf8'),
    );
    expect(data).not.toBeNull();
    const payload = JSON.parse(data![1]) as { lesson: WordBeatLesson; assets: AssetMap };
    await writeFile(
      refreshedFile,
      await exporter.createClassroomHtml(payload.lesson, payload.assets),
      'utf8',
    );
  } finally {
    await server.close();
  }

  const rebuiltRuntime = JSON.parse(
    await readFile(join(projectRoot, 'src/portable/generated/runtime.json'), 'utf8'),
  ) as { script: string; style: string };
  expect(rebuiltRuntime.script).toBe(previousRuntime.script);
  expect(rebuiltRuntime.style).toBe(previousRuntime.style);
  const refreshedHtml = await readFile(refreshedFile, 'utf8');
  expect(refreshedHtml).toContain(`<script>${rebuiltRuntime.script}</script>`);
  expect(refreshedHtml).toContain(`<style>${rebuiltRuntime.style}</style>`);

  const evidence = [];
  for (const file of [oldFile, refreshedFile]) {
    const bytesBefore = await readFile(file);
    const hashBefore = createHash('sha256').update(bytesBefore).digest('hex');
    const observed = await openOffline(context, page, file);
    await expect(
      page.getByRole('heading', { name: '高中词汇离线课堂', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    const controls = page.locator('footer');
    // 主动切词及暂停消除准备阶段长短的影响，随后验证会话改动确实生效。
    await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
    await controls.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
    await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
    const tempo = page.getByRole('spinbutton', { name: /^节奏 BPM/u });
    // 两份文件共用同课 ID；第二份已恢复本地值，必须改成不同值才有节奏变化。
    await tempo.fill((await tempo.inputValue()) === '120' ? '130' : '120');
    await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption('blocks');
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('节奏已更新');
    await expect(page.locator('.ecg-classroom--blocks')).toBeVisible();
    await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'concentrate', exact: true })).toBeVisible();
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible();

    // file:// 重载恢复浏览器保存设置；HTML 文件本身保持字节不变。
    await page.reload();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
    await expect(page.locator('.ecg-classroom--blocks')).toBeVisible();
    await expect(page.locator('footer')).toHaveCount(0);
    const hashAfter = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    expect(hashAfter).toBe(hashBefore);
    expect(observed.protocol).toBe('file:');
    expect(observed.requests).toEqual([]);
    expect(observed.errors).toEqual([]);
    evidence.push({
      file,
      sha256Before: hashBefore,
      sha256After: hashAfter,
      protocol: observed.protocol,
      externalRequests: observed.requests,
      pageErrors: observed.errors,
      verified: ['开始', '暂停', '调速', '切画面', '暂停切词', '重开恢复本地设置'],
    });
  }
  const upgradeEvidenceFile = testInfo.outputPath('upgrade-evidence.json');
  await writeFile(
    upgradeEvidenceFile,
    `${JSON.stringify(
      {
        runtimeSha256: createHash('sha256').update(rebuiltRuntime.script).digest('hex'),
        rebuild: {
          requestedNodeEnv: 'test',
          scriptUnchanged: rebuiltRuntime.script === previousRuntime.script,
          styleUnchanged: rebuiltRuntime.style === previousRuntime.style,
        },
        browserVersion: context.browser()?.version(),
        evidence,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await testInfo.attach('新旧实际成品离线验收', {
    path: upgradeEvidenceFile,
    contentType: 'application/json',
  });
});

for (const name of ['声音内容损坏', '声音引用缺失', '运行版本不兼容', '课件结构损坏']) {
  test(`${name}的实际课堂文件停在可读修复页，不显示假成功或白屏`, async ({ context, page }) => {
    const observed = await openOffline(context, page, invalidFiles.get(name)!);
    expect(observed.protocol).toBe('file:');
    await expect(
      page.getByRole('heading', { name: '课堂文件无法打开', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toHaveCount(0);
    await expect(page.locator('#root p')).toContainText(/损坏|缺少|不可用|校验|版本/u);
    expect(observed.requests).toEqual([]);
    expect(observed.errors).toEqual([]);
  });
}

for (const mode of ['配音跟读', '文字领读'] as const) {
  test(`实际交付的${mode}示例默认方块自动完整播放，断网保留教师控制`, async ({
    context,
    page,
  }, testInfo) => {
    // 直接检查最终交付目录的实际文件，不能在测试内重造一份相似课件替代它。
    const file = join(projectRoot, 'examples', `高中单词节拍-${mode}.html`);
    const bytesBefore = await readFile(file);
    const html = bytesBefore.toString('utf8');
    const currentRuntime = JSON.parse(
      await readFile(join(projectRoot, 'src/portable/generated/runtime.json'), 'utf8'),
    ) as { script: string; style: string };
    // 实际交付示例也必须使用当前生产运行核心，不能只证明相似旧文件仍能播放。
    expect(html).toContain(`<script>${currentRuntime.script}</script>`);
    expect(html).toContain(`<style>${currentRuntime.style}</style>`);
    // Large embedded WAV payloads exceed the regexp backtracking stack. The
    // exporter escapes '<', so explicit script boundaries are unambiguous.
    const marker = '<script id="ecg-data" type="application/json">';
    const dataStart = html.indexOf(marker) + marker.length;
    const payload = JSON.parse(html.slice(dataStart, html.indexOf('</script>', dataStart))) as {
      lesson: WordBeatLesson;
      assets: AssetMap;
    };
    const entries = payload.lesson.gameData.segments.flatMap((segment) => segment.entries);
    expect(entries.map((entry) => entry.english)).toEqual([
      'knowledge',
      'challenge',
      'responsibility',
      'cooperation',
      'perseverance',
      'take part in',
    ]);
    expect(payload.lesson.gameData.progression).toBe('auto');
    expect(payload.lesson.gameData.displayMode).toBe('blocks');
    expect(payload.lesson.gameData.soundMode).toBe(mode === '配音跟读' ? 'voiced' : 'teacher');
    const sourceRecordings: { file: string; voiceName: string; sha256: string; text: string }[] =
      [];
    if (mode === '配音跟读') {
      const provenance = JSON.parse(
        await readFile(join(projectRoot, 'examples', 'source-audio', 'source.json'), 'utf8'),
      ) as { binding: string; source: string; note: string; items: typeof sourceRecordings };
      expect(provenance.binding).toBe('recording');
      expect(provenance.source).toContain('SAPI');
      expect(provenance.note).toContain('do not prove');
      expect(Object.keys(payload.assets)).toHaveLength(9);
      const references = [
        ...entries.map((entry) => entry.audio!),
        payload.lesson.gameData.slogans.opening.audio!,
        payload.lesson.gameData.slogans.closing.audio!,
      ];
      expect(references.every((reference) => reference.source === 'recording')).toBe(true);
      for (const asset of Object.values(payload.assets).filter(
        (asset) => asset.kind === 'recording',
      )) {
        const recording = provenance.items.find((item) => item.sha256 === asset.sha256)!;
        expect(recording).toBeDefined();
        const actualBytes = await readFile(
          join(projectRoot, 'examples', 'source-audio', recording.file),
        );
        expect(createHash('sha256').update(actualBytes).digest('hex')).toBe(recording.sha256);
        expect(Buffer.from(asset.dataUrl!.split(',')[1], 'base64')).toEqual(actualBytes);
        expect(references.find((reference) => reference.assetId === asset.assetId)?.text).toBe(
          recording.text,
        );
        sourceRecordings.push(recording);
      }
    } else {
      expect(Object.keys(payload.assets)).toHaveLength(1);
      expect(
        Object.values(payload.lesson.gameData.slogans).every((slogan) => !slogan.enabled),
      ).toBe(true);
    }
    const observed = await openOffline(context, page, file);
    await expect(
      page.getByRole('heading', { name: `高中单词节拍-${mode}`, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('banner').getByText(`WORD BEAT / ${mode}`, { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.ecg-classroom--blocks')).toBeVisible();
    await expect(page.getByText('推进方式：自动推进', { exact: true })).toBeVisible();
    // 单独解码每一份实际录音，记录浏览器真实采样信息；不以声明时长或正弦夹具代替。
    const decodedAudio = await page.evaluate(async () => {
      const data = JSON.parse(document.querySelector('#ecg-data')!.textContent!);
      const audio = new AudioContext();
      const decoded = [];
      try {
        for (const asset of Object.values(data.assets) as {
          assetId: string;
          dataUrl: string;
          durationMs: number;
        }[]) {
          const bytes = Uint8Array.from(atob(asset.dataUrl.split(',')[1]), (value) =>
            value.charCodeAt(0),
          );
          const buffer = await audio.decodeAudioData(bytes.buffer);
          decoded.push({
            assetId: asset.assetId,
            durationMs: buffer.duration * 1000,
            declaredDurationMs: asset.durationMs,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            frames: buffer.length,
          });
        }
      } finally {
        await audio.close();
      }
      return decoded;
    });
    expect(decodedAudio).toHaveLength(mode === '配音跟读' ? 9 : 1);
    for (const decoded of decodedAudio) {
      expect(decoded.durationMs).toBeGreaterThan(0);
      expect(Math.abs(decoded.durationMs - decoded.declaredDurationMs)).toBeLessThan(2);
      expect(decoded.channels).toBeGreaterThan(0);
      expect(decoded.frames).toBeGreaterThan(0);
    }
    await page.getByRole('button', { name: '测试声音', exact: true }).click();
    // Alert结构增加真实状态标题；分别精确检查标题与正文，避免忽略音箱确认边界。
    await expect(page.getByRole('status').locator('strong')).toHaveText('课堂提示');
    await expect(page.getByRole('status').locator('.ecg-notice-copy > div')).toHaveText(
      '试听结束，请确认教室音箱实际发声。',
    );
    const automaticStartedAt = Date.now();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    if (mode === '配音跟读') {
      await expect(page.locator('.ecg-stage-label')).toHaveText('口号');
      await expect(
        page.getByRole('heading', {
          name: payload.lesson.gameData.slogans.opening.text,
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
    await expect(page.locator('.ecg-stage-label')).toHaveText(
      mode === '配音跟读' ? '示范' : '教师示范',
    );
    await expect(page.locator('.ecg-stage-label')).toHaveText('跟读');
    const automaticWords = [entries[0].english];
    // 从开始到收尾不点击下一词/继续，不模拟时钟；每一词必须自然出现。
    for (const entry of entries.slice(1)) {
      await expect(page.getByRole('heading', { name: entry.english, exact: true })).toBeVisible({
        timeout: 30_000,
      });
      automaticWords.push(entry.english);
      await expect(page.getByText('等待教师', { exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const automaticDurationMs = Date.now() - automaticStartedAt;
    await expect(page.getByLabel(/已完成 6 \/ 6 条/u)).toBeVisible();
    await expect(page.getByLabel(/主动重读 0 次/u)).toBeVisible();
    const completionLayouts = await verifyCompletionLayouts(page, 'finished');
    await page.screenshot({ path: testInfo.outputPath(`实际交付-${mode}-自动全课完成.png`) });

    // 自动全程验收结束后，另一次会话验证教师仍可暂停、切词、重读与改节奏。
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'knowledge', exact: true })).toBeVisible();
    const controls = page.locator('footer');
    await controls.getByRole('button', { name: '暂停', exact: true }).click();
    await controls.getByRole('button', { name: '下一词', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'challenge', exact: true })).toBeVisible();
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
    await controls.getByRole('button', { name: '重读', exact: true }).click();
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
    await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
    await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption('centered');
    await page.getByRole('spinbutton', { name: /^节奏 BPM/u }).fill('120');
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('节奏已更新');
    await expect(page.locator('.ecg-classroom--centered')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`实际交付-${mode}-断网控制.png`) });
    await controls.getByRole('button', { name: '课堂设置', exact: true }).click();
    await page.getByRole('button', { name: '结束本次课堂', exact: true }).click();
    completionLayouts.push(...(await verifyCompletionLayouts(page, 'ended')));
    await page.reload();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
    await expect(page.locator('.ecg-classroom--centered')).toBeVisible();
    expect(observed.requests).toEqual([]);
    expect(observed.errors).toEqual([]);
    const hashBefore = createHash('sha256').update(bytesBefore).digest('hex');
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(hashBefore);
    await writeFile(
      testInfo.outputPath('release-example-evidence.json'),
      `${JSON.stringify(
        {
          file,
          sha256: hashBefore,
          browserVersion: context.browser()?.version(),
          protocol: observed.protocol,
          mode,
          entries: entries.length,
          automaticWords,
          automaticDurationMs,
          sourceRecordings,
          decodedAudio,
          completionLayouts,
          externalRequests: observed.requests,
          pageErrors: observed.errors,
          verified: [
            '完整试听',
            '默认节奏方块',
            '示范',
            '跟读',
            '无手动切词的整课自动播放',
            '全部6词与自然收尾',
            '自然完成及提前结束在低高度窗口中统计与重播/返回完整可见',
            '暂停切词',
            '重读',
            '调速',
            '切画面',
            '重开',
          ],
          evidenceBoundary:
            '实际交付HTML；配音是本机SAPI预制并以recording绑定的真实录音，不代表WinRT英文合成或人工听觉/声画偏差验收通过。',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  });
}
