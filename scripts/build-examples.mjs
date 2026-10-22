/**
 * 使用正式规则、包协议和课堂导出器生成可复核的发行示例。
 * 输入为 prepare-example-audio.ps1 的真实 WAV，绑定类型始终为 recording；
 * 不替换应用配音引擎、不调用网络、不向教师资料库写入。
 * 先运行 pnpm build:portable，再使用 mise 管理的 Node 执行本脚本。
 * @author ahui
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../examples/', import.meta.url);
const source = JSON.parse(await readFile(new URL('source-audio/source.json', output), 'utf8'));
const utf8 = new TextEncoder();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * 读取 PCM16 WAV 的实际数据块，不能把头部长度或静音占位文件冒充正常语音。
 * @param {Buffer} bytes 待解析的完整 WAV。
 * @param {number} maximumMs 最长毫秒数；录音默认30秒，背景音乐显式传入10分钟。
 * @returns {{sampleRate:number, channels:number, frameCount:number, durationMs:number}} 实际采样信息。
 * @throws {Error} RIFF / PCM 格式非法、缺少完整采样、数据全零或时长超限。
 */
function inspectWave(bytes, maximumMs = 30_000) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format;
  let data;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    assert.ok(start + size <= bytes.length, 'WAV 数据块不完整。');
    const kind = bytes.toString('ascii', cursor, cursor + 4);
    if (kind === 'fmt ') {
      assert.ok(size >= 16);
      assert.equal(bytes.readUInt16LE(start), 1, '示例仅接受 PCM WAV。');
      assert.equal(bytes.readUInt16LE(start + 14), 16);
      format = {
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
      };
    }
    if (kind === 'data') data = bytes.subarray(start, start + size);
    cursor = start + size + (size % 2);
  }
  assert.ok(format?.channels > 0 && format.sampleRate > 0 && data?.length > 0);
  assert.equal(data.length % (format.channels * 2), 0);
  assert.ok(
    data.some((byte) => byte !== 0),
    '不接受全静音示例。',
  );
  const frameCount = data.length / (format.channels * 2);
  const durationMs = (frameCount / format.sampleRate) * 1_000;
  assert.ok(durationMs > 0 && durationMs <= maximumMs);
  return { ...format, frameCount, durationMs };
}

/** 同一输入生成稳定身份，重建示例不会制造无法核对的随机副本。 */
function exampleIds(scope) {
  let count = 0;
  return () => {
    const hash = digest(`${scope}:${count++}`);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
}

await mkdir(new URL('validation/', output), { recursive: true });
// middlewareMode 不监听 HTTP；仅让 Node 正确加载产品 TS、TSX、JSON 与样式。
const server = await createServer({
  root: projectRoot,
  configFile: false,
  appType: 'custom',
  server: { middlewareMode: true, watch: null, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  esbuild: { jsx: 'automatic' },
});

try {
  const rules = await server.ssrLoadModule('/src/games/word-beat/rules.ts');
  const games = await server.ssrLoadModule('/src/platform/games.ts');
  const schema = await server.ssrLoadModule('/src/shared/schemas/lesson-package.ts');
  const exporter = await server.ssrLoadModule('/src/portable/export.ts');
  const attributions = await server.ssrLoadModule('/src/shared/attribution.ts');
  const game = games.getGame('word-beat');
  assert.ok(game);
  const bgmBytes = await readFile(new URL('../resources/music/word-beat-bgm.wav', import.meta.url));
  const bgm = {
    assetId: exampleIds('builtin-bgm')(),
    kind: 'music',
    name: '课堂律动 · 首发背景音乐',
    mimeType: 'audio/wav',
    byteLength: bgmBytes.length,
    sha256: digest(bgmBytes),
    ...inspectWave(bgmBytes, 600_000),
    dataUrl: `data:audio/wav;base64,${bgmBytes.toString('base64')}`,
  };
  const assets = { bgm };
  for (const item of source.items) {
    const bytes = await readFile(new URL(`source-audio/${item.file}`, output));
    assert.equal(digest(bytes), item.sha256, `示例录音发生变化：${item.file}`);
    const info = inspectWave(bytes);
    assets[item.file] = {
      assetId: exampleIds(`audio:${item.sha256}`)(),
      kind: 'recording',
      name: item.file,
      mimeType: 'audio/wav',
      byteLength: bytes.length,
      sha256: item.sha256,
      ...info,
      dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`,
    };
  }
  const words = [
    ['knowledge', '知识', 'knowledge.wav'],
    ['challenge', '挑战', 'challenge.wav'],
    ['responsibility', '责任', 'responsibility.wav'],
    ['cooperation', '合作', 'cooperation.wav'],
    ['perseverance', '坚持不懈', 'perseverance.wav'],
    ['take part in', '参加', 'take-part-in.wav'],
  ];
  const evidence = [];
  for (const mode of ['voiced', 'teacher', 'chorus']) {
    const ids = exampleIds(mode);
    const entries = words.map(([english, meaning]) => ({
      id: ids(),
      english,
      meaning,
      priority: ['responsibility', 'perseverance'].includes(english),
      confirmed: true,
      source: { name: '高中课堂示例词表', original: `${english}\t${meaning}` },
    }));
    const stem =
      mode === 'chorus'
        ? '高中单词节拍-学生自主齐读'
        : mode === 'voiced'
          ? '高中单词节拍-配音跟读'
          : '高中单词节拍-文字领读';
    let lesson = rules.createWordBeatLesson(entries, {
      name: stem,
      soundMode: mode,
      progression: 'auto',
      seed: 20261020,
      now: source.generatedAt,
      idFactory: ids,
    });
    const assetMap = { [bgm.assetId]: bgm };
    lesson.gameData.music = { enabled: true, loop: true, assetId: bgm.assetId };
    if (mode === 'voiced') {
      const lessonEntries = rules.getEntries(lesson);
      for (const [index, word] of words.entries()) {
        const asset = assets[word[2]];
        lesson = rules.bindRecording(lesson, lessonEntries[index].id, asset);
        assetMap[asset.assetId] = asset;
      }
      for (const purpose of ['opening', 'closing']) {
        const item = source.items.find((item) => item.file === `${purpose}.wav`);
        assert.equal(lesson.gameData.slogans[purpose].text, item.text);
        const asset = assets[item.file];
        lesson = rules.bindRecording(lesson, lesson.gameData.slogans[purpose].id, asset);
        assetMap[asset.assetId] = asset;
      }
    } else {
      for (const slogan of Object.values(lesson.gameData.slogans)) {
        slogan.enabled = false;
        slogan.enabledSource = 'manual';
      }
    }
    if (mode === 'chorus') {
      for (const entry of rules.getEntries(lesson))
        entry.chorus = {
          beats: { value: 4, source: 'preset', locked: false },
          beatsPerRead: {
            value: entry.entryType === 'phrase' ? 2 : 1,
            source: 'manual',
            locked: false,
          },
        };
    }
    // 示例已通过当前模式检查；不从“准备标记”反推合法，正式导出器仍会重新验证。
    lesson.revision = 1;
    lesson.preparedRevision = lesson.revision;
    assert.equal(game.validateStructure(lesson).length, 0);
    assert.equal(
      game.validate(lesson, assetMap).filter((issue) => issue.severity === 'error').length,
      0,
    );
    const plan = game.compile(lesson, assetMap);
    const html = await exporter.createClassroomHtml(lesson, assetMap, {
      exportedAt: source.generatedAt,
    });
    const packageData = schema.createPackageData(lesson, lesson);
    const lessonBytes = utf8.encode(JSON.stringify(packageData));
    const packageAssets = Object.values(assetMap).map(schema.packageAsset);
    const manifest = schema.validatePackageManifest({
      formatVersion: 1,
      gameId: lesson.gameId,
      minimumPlatformVersion: '1.0.0',
      runtimeVersion: mode === 'chorus' ? 2 : 1,
      sourceLessonId: lesson.id,
      generatedAt: source.generatedAt,
      lessonSha256: digest(lessonBytes),
      assets: packageAssets,
    });
    const files = {
      'lesson.json': lessonBytes,
      'manifest.json': utf8.encode(JSON.stringify(manifest)),
      'attribution.txt': utf8.encode(attributions.CLASSROOM_ATTRIBUTION),
      'license.txt': utf8.encode(
        'This package contains teaching data and media, not player code. Teaching content retains its own rights. Software: GPL-3.0-only; newly exported HTML includes player source.\n\n' +
          attributions.CLASSROOM_ATTRIBUTION,
      ),
    };
    for (const asset of manifest.assets) {
      const original = Object.values(assets).find(
        (candidate) => candidate.assetId === asset.assetId,
      );
      files[asset.path] = Buffer.from(original.dataUrl.split(',')[1], 'base64');
    }
    // ZIP 时间也固定到实际录音生成时间，同一输入重建不因打包时刻改变校验值。
    const packageBytes = zipSync(files, { mtime: new Date(source.generatedAt) });
    await writeFile(new URL(`${stem}.html`, output), html, 'utf8');
    await writeFile(new URL(`${stem}.ecglesson`, output), packageBytes);
    await writeFile(
      new URL(`validation/${mode}.identity.json`, output),
      JSON.stringify(
        {
          lessonSha256: manifest.lessonSha256,
          revisions: [{ revision: lesson.revision, layout: game.describeIdentities(lesson) }],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    evidence.push({
      name: stem,
      mode,
      lessonId: lesson.id,
      revision: lesson.revision,
      audioSource:
        mode === 'voiced'
          ? 'Imported pre-generated SAPI recordings'
          : mode === 'chorus'
            ? 'Student chorus; no demonstration audio'
            : 'Teacher demonstration; no speech audio',
      wordCount: entries.length,
      audioCount: Object.keys(assetMap).length,
      durationMs: plan.durationMs,
      htmlBytes: Buffer.byteLength(html),
      htmlSha256: digest(html),
      packageBytes: packageBytes.length,
      packageSha256: digest(packageBytes),
    });
  }
  await writeFile(
    new URL('validation/artifacts.json', output),
    JSON.stringify({ author: 'ahui', generatedAt: source.generatedAt, files: evidence }, null, 2) +
      '\n',
    'utf8',
  );
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} finally {
  await server.close();
}
