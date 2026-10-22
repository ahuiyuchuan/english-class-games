/**
 * 真实便携课堂的舞台行为验收。直接打开正式导出的 file:// HTML，
 * 读取浏览器实际动画时间、变换和当前词；不替换控制器或课堂时钟。
 * @author ahui
 */
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WordBeatLesson } from '../../src/games/word-beat/model';

const classroomFile = fileURLToPath(
  new URL('../../examples/高中单词节拍-文字领读.html', import.meta.url),
);

/**
 * 断网打开实际交付样本，保留源文件指纹、网络请求和运行异常作为证据。
 * 样本由正式导出流程维护，测试不改写课件数据或导出文件。
 */
async function openClassroom(context: BrowserContext, page: Page) {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url())) requests.push(request.url());
  });
  await context.setOffline(true);
  await context.route(/^https?:/u, (route) => route.abort());
  await page.goto(pathToFileURL(classroomFile).href);
  expect(new URL(page.url()).protocol).toBe('file:');
  const payload = JSON.parse((await page.locator('#ecg-data').textContent())!) as {
    lesson: WordBeatLesson;
  };
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(payload.lesson.name);
  const words = payload.lesson.gameData.segments.flatMap((segment) =>
    segment.entries.map((entry) => entry.english),
  );
  expect(words.length).toBeGreaterThanOrEqual(2);
  const bytes = await readFile(classroomFile);
  return {
    words,
    errors,
    requests,
    source: { file: classroomFile, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}

/**
 * 用实际按钮选择推进方式并进入首词，排除开始页静态装饰。
 * 自动播放例显式选择auto，等待例显式选择step，不依赖样本默认设置。
 */
async function startFirstWord(page: Page, word: string, progression: 'auto' | 'step' = 'auto') {
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('combobox', { name: '推进方式', exact: true }).selectOption(progression);
  await expect(page.getByRole('combobox', { name: '推进方式', exact: true })).toHaveValue(
    progression,
  );
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(word);
}

/**
 * 对同一可见音符取两个实际绘制帧，墙上时间至少间隔180ms。
 * animation.ready确认启停已提交，RAF让前后读数属于实际绘制帧；
 * 不能仅在setTimeout结束时读取可能尚未更新的document.timeline。
 * 等待只观察浏览器，不推进、替换或修改课堂播放时间，不循环等待运动通过。
 */
async function sampleParticle(page: Page) {
  return page.evaluate(async () => {
    const particle = document.querySelector<HTMLElement>('.ecg-atmosphere-particle--note')!;
    // DOM提交与合成线程的CSS暂停可能相差一帧；等待浏览器确认操作，
    // 然后严格比较至少间隔180ms的两个实际绘制帧，不用像素容差掩盖持续运动。
    await Promise.all(particle.getAnimations().map((animation) => animation.ready));
    const read = (frameTimestamp: number) => {
      const style = getComputedStyle(particle);
      const animation = particle.getAnimations()[0];
      const rect = particle.getBoundingClientRect();
      return {
        transform: style.transform,
        animationName: style.animationName,
        animationTime: animation ? Number(animation.currentTime) : null,
        playState: animation?.playState ?? null,
        opacity: Number(style.opacity),
        width: rect.width,
        height: rect.height,
        // 保留真实帧、墙上时间与文档动画时间，区分动画冻结和未提交新绘制帧。
        frameTimestamp,
        performanceTime: performance.now(),
        documentTime: document.timeline.currentTime,
        phase: document.querySelector('.ecg-classroom-stage')?.getAttribute('data-phase'),
        canvasFrame: Number(
          document.querySelector('.ecg-particle-canvas')?.getAttribute('data-frame'),
        ),
      };
    };
    const readFrame = () =>
      new Promise<ReturnType<typeof read>>((resolve) => {
        requestAnimationFrame((timestamp) => resolve(read(timestamp)));
      });
    const before = await readFrame();
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { before, after: await readFrame() };
  });
}

/** 实际绘制和动画时间均需前进，不能仅检查 data-active 或 CSS 类。 */
function expectParticleMoving(samples: Awaited<ReturnType<typeof sampleParticle>>) {
  expect(samples.before.width).toBeGreaterThan(15);
  expect(samples.before.height).toBeGreaterThan(15);
  expect(samples.before.opacity).toBeGreaterThanOrEqual(0.3);
  expect(samples.before.playState).toBe('running');
  expect(samples.after.playState).toBe('running');
  expect(samples.after.animationTime! - samples.before.animationTime!).toBeGreaterThan(80);
  expect(samples.after.transform).not.toBe(samples.before.transform);
}

/** 停止时同一音符的实际绘制位置与动画时间必须保持不变。 */
function expectParticleStill(samples: Awaited<ReturnType<typeof sampleParticle>>) {
  expect(samples.after.transform).toBe(samples.before.transform);
  expect(samples.after.animationTime).toBe(samples.before.animationTime);
  expect(samples.after.playState).not.toBe('running');
}

/** 记录实际浏览器样本，方便复核动画启停与交付文件之间的对应关系。 */
async function attachEvidence(testInfo: TestInfo, evidence: unknown) {
  const file = testInfo.outputPath('visual-motion-samples.json');
  // 同时落盘，保证默认命令行报告器也保留成功用例的实际动画采样。
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await testInfo.attach('visual-motion-samples.json', {
    path: file,
    contentType: 'application/json',
  });
}

/**
 * 对真实 Canvas 像素取有序指纹。采样同时记录非透明像素，避免把空画布、
 * 仅递增的 data-frame 或动画类名当作粒子已经绘制；此值用于运动比较，不作文件安全校验。
 */
async function sampleCanvas(page: Page) {
  return page.locator('.ecg-particle-canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let fingerprint = 2166136261;
    let painted = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      fingerprint = Math.imul(fingerprint ^ pixels[index], 16777619);
      fingerprint = Math.imul(fingerprint ^ pixels[index + 1], 16777619);
      fingerprint = Math.imul(fingerprint ^ pixels[index + 2], 16777619);
      fingerprint = Math.imul(fingerprint ^ pixels[index + 3], 16777619);
      if (pixels[index + 3] > 0) painted += 1;
    }
    return {
      fingerprint: fingerprint >>> 0,
      painted,
      width: canvas.width,
      height: canvas.height,
      frame: Number(canvas.dataset.frame),
      running: canvas.dataset.running,
    };
  });
}

test('粒子场实际绘制并持续改变像素，暂停后像素与绘制计数同时冻结', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  const before = await sampleCanvas(page);
  await page.waitForTimeout(350);
  const after = await sampleCanvas(page);
  expect(before.painted).toBeGreaterThan(100);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  expect(after.frame).toBeGreaterThan(before.frame);
  expect(after.width * after.height).toBeLessThanOrEqual(2_205_000);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('.ecg-particle-canvas')).toHaveAttribute('data-running', 'false');
  const pausedBefore = await sampleCanvas(page);
  await page.waitForTimeout(350);
  const pausedAfter = await sampleCanvas(page);
  expect(pausedAfter).toEqual(pausedBefore);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('.ecg-particle-canvas')).toHaveAttribute('data-running', 'true');
  await expect
    .poll(async () => (await sampleCanvas(page)).fingerprint)
    .not.toBe(pausedAfter.fingerprint);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, before, after, pausedBefore, pausedAfter });
});

test('环轨使用实际扁椭圆，小光点沿轨迹运行并随课堂暂停冻结', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  const sampleOrbit = () =>
    page.locator('.ecg-reactor-ring--outer').evaluate(async (ring) => {
      await Promise.all(ring.getAnimations().map((animation) => animation.ready));
      const read = () => {
        const bounds = ring.getBoundingClientRect();
        const style = getComputedStyle(ring, '::after');
        return {
          width: bounds.width,
          height: bounds.height,
          offsetPath: style.offsetPath,
          offsetDistance: style.offsetDistance,
          playState: style.animationPlayState,
        };
      };
      const before = await new Promise<ReturnType<typeof read>>((resolve) =>
        requestAnimationFrame(() => resolve(read())),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await new Promise<ReturnType<typeof read>>((resolve) =>
        requestAnimationFrame(() => resolve(read())),
      );
      return { before, after };
    });
  const running = await sampleOrbit();
  // 检查真实合成区域，而非仅读到一个类名：不能再用正方形旋转面制造扁环。
  expect(running.before.height / running.before.width).toBeLessThan(0.5);
  expect(running.before.offsetPath).toContain('ellipse');
  expect(running.before.playState).toBe('running');
  expect(running.after.offsetDistance).not.toBe(running.before.offsetDistance);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');
  const paused = await sampleOrbit();
  expect(paused.before.playState).toBe('paused');
  expect(paused.after.offsetDistance).toBe(paused.before.offsetDistance);
  await page.screenshot({ path: testInfo.outputPath('elliptical-orbit-paused.png') });
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, running, paused });
});

test('系统减少动态效果立即停止实际Canvas绘制，关闭后恢复且不阻断真实切词', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  await expect(page.locator('.ecg-particle-canvas')).toHaveAttribute('data-running', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.ecg-particle-canvas')).toHaveAttribute('data-running', 'false');
  const reducedBefore = await sampleCanvas(page);
  await page.waitForTimeout(350);
  const reducedAfter = await sampleCanvas(page);
  expect(reducedAfter).toEqual(reducedBefore);
  expect(reducedAfter.painted).toBeGreaterThan(100);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[1], {
    timeout: 30_000,
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.ecg-particle-canvas')).toHaveAttribute('data-running', 'true');
  await expect
    .poll(async () => (await sampleCanvas(page)).frame)
    .toBeGreaterThan(reducedAfter.frame);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, reducedBefore, reducedAfter });
});

test('8K视口的真实Canvas仍遵守220万像素预算并保留静态舞台', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 7680, height: 4320 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const observed = await openClassroom(context, page);
  const sample = await sampleCanvas(page);
  const cssSize = await page.locator('.ecg-particle-canvas').boundingBox();
  expect(cssSize?.width).toBe(7680);
  expect(cssSize?.height).toBe(4320);
  expect(sample.width * sample.height).toBeLessThanOrEqual(2_200_000);
  expect(sample.painted).toBeGreaterThan(100);
  expect(sample.running).toBe('false');
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, sample, cssSize });
});

test('模拟无Canvas2D能力仍能显示舞台并自动进入下一词', async ({ page, context }, testInfo) => {
  // 只模拟图形能力缺失；不替换教学控制器、声音时间或课件内容。
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => null,
    });
  });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  await expect(page.locator('.ecg-atmosphere-grid')).toBeVisible();
  await expect(page.locator('.ecg-beat-block')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[1], {
    timeout: 30_000,
  });
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, simulatedMissingCanvas2D: true });
});

test('实际四拍倒数依次出现3、2、1、GO，暂停冻结后继续进入首词', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await expect(page.getByText('推进方式：自动推进', { exact: true })).toBeVisible();
  await expect(page.locator('.ecg-classroom--blocks')).toBeVisible();
  // 观察真实DOM变化，避免Playwright轮询在短拍之间漏读；不改教学内容或播放状态。
  const collector = await page.evaluateHandle(() => {
    const samples: { text: string; observedAt: number }[] = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector('.teaching-content__word')?.textContent ?? '';
      if (['3', '2', '1', 'GO'].includes(text) && samples.at(-1)?.text !== text)
        samples.push({ text, observedAt: performance.now() });
    });
    observer.observe(document.querySelector('#root')!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return { samples, observer };
  });
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  const frozenCountdown = await page.evaluate(async () => {
    const before = document.querySelector('.teaching-content__word')!.textContent;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { before, after: document.querySelector('.teaching-content__word')!.textContent };
  });
  // 从观察到“2”到真实鼠标点击之间，浏览器仍会自然走拍；记录点击后的
  // 真实倒数并要求其严格冻结，不能把测试驱动耗时当作课堂暂停失败。
  expect(['2', '1', 'GO']).toContain(frozenCountdown.before);
  expect(frozenCountdown.after).toBe(frozenCountdown.before);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[0]);
  const countdown = await collector.evaluate(({ samples, observer }) => {
    observer.disconnect();
    return samples;
  });
  await collector.dispose();
  expect(countdown.map((sample) => sample.text)).toEqual(['3', '2', '1', 'GO']);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, countdown, frozenCountdown });
});

test('运行中音符实际漂移、拍击涟漪绘制变化，暂停后冻结', async ({ page, context }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'true');
  const moving = await sampleParticle(page);
  expectParticleMoving(moving);

  // 抓取一枚刚开始的实际涟漪，比较其100ms内的缩放与透明度；
  // 旧拍位已结束或正好切拍时继续观察下一拍，不将CSS名称当作效果已发生。
  let impact: unknown;
  await expect
    .poll(
      async () => {
        const samples = await page.evaluate(async () => {
          const ripple = document.querySelector<HTMLElement>('.ecg-beat-impact');
          const animation = ripple?.getAnimations()[0];
          if (!ripple || !animation || Number(animation.currentTime) > 250) return null;
          const before = {
            transform: getComputedStyle(ripple).transform,
            opacity: Number(getComputedStyle(ripple).opacity),
            time: Number(animation.currentTime),
          };
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!ripple.isConnected) return null;
          return {
            before,
            after: {
              transform: getComputedStyle(ripple).transform,
              opacity: Number(getComputedStyle(ripple).opacity),
              time: Number(animation.currentTime),
            },
          };
        });
        impact = samples;
        return Boolean(
          samples &&
          samples.before.opacity > 0.1 &&
          samples.after.opacity < samples.before.opacity &&
          samples.after.transform !== samples.before.transform &&
          samples.after.time > samples.before.time,
        );
      },
      { timeout: 5_000, intervals: [100, 150, 200] },
    )
    .toBe(true);
  const firstBeat = await page.locator('.ecg-pulse-active .ecg-beat-number').textContent();
  await expect
    .poll(() => page.locator('.ecg-pulse-active .ecg-beat-number').textContent())
    .not.toBe(firstBeat);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.ecg-beat-impact')).toHaveCount(0);
  const paused = await sampleParticle(page);
  expectParticleStill(paused);
  await page.screenshot({ path: testInfo.outputPath('paused-classroom.png') });
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, moving, impact, paused });
});

test('会话特效开关停止装饰，真实拍位和自动切词继续，重新开启恢复运动', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: '舞台特效', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  // 设置遮住课堂时会暂停，教师明确继续后再检验实际运动与切词。
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.ecg-beat-trail')).toHaveAttribute('data-animated', 'false');
  await expect(page.locator('.ecg-beat-impact')).toHaveCount(0);
  const disabled = await sampleParticle(page);
  expectParticleStill(disabled);
  const firstBeat = await page.locator('.ecg-pulse-active .ecg-beat-number').textContent();
  await expect
    .poll(() => page.locator('.ecg-pulse-active .ecg-beat-number').textContent())
    .not.toBe(firstBeat);
  // 不点下一词，等待真实时间线自动走到第二词。
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[1], {
    timeout: 30_000,
  });
  await expect(page.getByText('等待教师', { exact: true })).toHaveCount(0);
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');

  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await toggle.check();
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  // 设置遮住课堂时会暂停，教师明确继续后再检验实际运动与切词。
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'true');
  const restored = await sampleParticle(page);
  expectParticleMoving(restored);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, disabled, restored });
});

test('减少动态效果强制静态，四拍方块和词序轨道仍跟随真实自动切词', async ({
  page,
  context,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0]);
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '舞台特效', exact: true })).toBeChecked();
  await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption('blocks');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  // 设置遮住课堂时会暂停，教师明确继续后再检验实际运动与切词。
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('.ecg-classroom--blocks')).toBeVisible();
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.ecg-beat-impact')).toHaveCount(0);
  const reduced = await sampleParticle(page);
  expectParticleStill(reduced);
  expect(reduced.after.animationName).toBe('none');
  await expect(page.locator('.ecg-pulse-active .ecg-beat-word')).toHaveAttribute(
    'data-word',
    observed.words[0],
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[1], {
    timeout: 30_000,
  });
  await expect(page.locator('.ecg-pulse-active .ecg-beat-word')).toHaveAttribute(
    'data-word',
    observed.words[1],
  );
  await expect(
    page.locator('.ecg-word-track-item[data-current="true"] .ecg-word-track-word'),
  ).toHaveAttribute('data-word', observed.words[1]);
  const trailWords = await page.locator('.ecg-beat-word').evaluateAll((elements) =>
    elements.map((element) => ({
      word: element.getAttribute('data-word'),
      decorative: element.getAttribute('aria-hidden'),
      // 实际可见的方块文字来自伪元素，而非隐藏原文的无内容占位。
      painted: getComputedStyle(element, '::before').content,
    })),
  );
  expect(trailWords.filter((item) => item.word)).not.toHaveLength(0);
  for (const item of trailWords.filter((candidate) => candidate.word)) {
    expect(item.word).toBe(observed.words[1]);
    expect(item.decorative).toBe('true');
    expect(item.painted).toBe(JSON.stringify(observed.words[1]));
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('.ecg-beat-block')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('reduced-motion-blocks.png') });
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, reduced, trailWords });
});

test('自然运行至等待教师时停止装饰，继续下一词恢复运动', async ({ page, context }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await openClassroom(context, page);
  await startFirstWord(page, observed.words[0], 'step');
  // 等待真实示范、跟读和轮次自然走完，不加速时间，也不调用内部控制器。
  await expect(page.getByText('等待教师', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.ecg-beat-impact')).toHaveCount(0);
  const waiting = await sampleParticle(page);
  expectParticleStill(waiting);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[0]);
  await page.screenshot({ path: testInfo.outputPath('waiting-for-teacher.png') });
  await page.getByRole('button', { name: '继续下一词', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(observed.words[1]);
  await expect(page.locator('.ecg-atmosphere')).toHaveAttribute('data-active', 'true');
  const continued = await sampleParticle(page);
  expectParticleMoving(continued);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
  await attachEvidence(testInfo, { ...observed, waiting, continued });
});
