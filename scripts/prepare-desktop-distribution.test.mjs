/** Filesystem regression for runtime completeness, source identity and safe failure. @author ahui */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isRuntimeFile,
  prepareDesktopDistribution,
  sourceDistribution,
} from './prepare-desktop-distribution.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const info = {
  version: '1.0.0',
  license: 'GPL-3.0-only',
  fileName: 'desktop-source.zip',
  sha256: hash('complete-source-fixture'),
  bytes: Buffer.byteLength('complete-source-fixture'),
};

test('full source receipt requires the exact build version and a valid digest', () => {
  const result = sourceDistribution(info, '1.0.0');
  assert.equal(result.fileName, 'English-Class-Games-v1.0.0-Source.zip');
  assert.equal(result.sha256, info.sha256);
  for (const change of [{ version: '0.9.0' }, { sha256: 'bad' }, { bytes: -1 }, { license: 'MIT' }])
    assert.throws(() => sourceDistribution({ ...info, ...change }, '1.0.0'));
});

test('runtime keeps the real model, worker, DLLs and original notices, excluding build archives', () => {
  for (const name of [
    'bin/tts-worker.exe',
    'bin/onnxruntime.dll',
    'model/model.onnx',
    'licenses/MeloTTS-MIT.txt',
    'NOTICE.txt',
  ])
    assert(isRuntimeFile(name), name);
  for (const name of ['licenses/sources/ort.zip', 'licenses/worker/tts-worker.cpp'])
    assert(!isRuntimeFile(name), name);
  for (const name of [
    '../model.onnx',
    'bin/../../outside',
    'C:/outside',
    '/bin/model',
    'bin\\model',
  ])
    assert.throws(() => isRuntimeFile(name), name);
});

/** Minimal binary fixtures test packaging integrity, not real speech quality. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ecg-runtime-distribution-'));
  const write = async (name, bytes) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  await write('package.json', JSON.stringify({ version: '1.0.0' }));
  await write('LICENSE', 'GPL license fixture');
  await write('COPYRIGHT', 'Copyright fixture');
  await write('resources/source/desktop-source.zip', 'complete-source-fixture');
  await write('resources/source/desktop-source.json', JSON.stringify(info));
  const files = [];
  for (const name of [
    'bin/tts-worker.exe',
    'model/model.onnx',
    'licenses/MeloTTS-MIT.txt',
    'licenses/sources/ort.zip',
    'licenses/worker/tts-worker.cpp',
    'NOTICE.txt',
  ]) {
    const bytes = Buffer.from(`fixture:${name}`);
    await write(`resources/tts/${name}`, bytes);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  await write(
    'resources/tts/manifest.json',
    JSON.stringify({ workerSource: 'licenses/worker/tts-worker.cpp', files }),
  );
  return root;
}

test('generated install payload has no full/source duplicate ZIPs and matches the runtime manifest', async () => {
  const root = await fixture();
  try {
    const result = await prepareDesktopDistribution(root);
    const stage = path.join(root, 'resources/desktop-distribution');
    const manifest = JSON.parse(await readFile(path.join(stage, 'tts/manifest.json'), 'utf8'));
    assert.equal(result.installedSpeechFiles, 4);
    assert.equal(manifest.files.length, 4);
    assert(!('workerSource' in manifest));
    for (const file of manifest.files)
      assert.equal(hash(await readFile(path.join(stage, 'tts', file.path))), file.sha256);
    const sourceFiles = await readdir(path.join(stage, 'source'));
    assert(!sourceFiles.some((name) => name.endsWith('.zip')));
    const receipt = JSON.parse(
      await readFile(path.join(stage, 'source/desktop-source.json'), 'utf8'),
    );
    assert.equal(receipt.sha256, info.sha256);
    assert.equal(manifest.sourceDistribution.downloadUrl, receipt.downloadUrl);
    await assert.rejects(readFile(path.join(stage, 'tts/licenses/sources/ort.zip')));
    assert.equal(
      (await readFile(path.join(root, 'resources/tts/licenses/sources/ort.zip'))).length > 0,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed runtime/source inputs fail before replacing a valid previous distribution', async () => {
  const root = await fixture();
  try {
    await prepareDesktopDistribution(root);
    const receiptPath = path.join(
      root,
      'resources/desktop-distribution/source/desktop-source.json',
    );
    const previous = await readFile(receiptPath);
    await writeFile(path.join(root, 'resources/tts/model/model.onnx'), 'changed-model');
    await assert.rejects(prepareDesktopDistribution(root));
    assert.deepEqual(await readFile(receiptPath), previous);
    await writeFile(path.join(root, 'resources/source/desktop-source.zip'), 'changed-source');
    await assert.rejects(prepareDesktopDistribution(root));
    assert.deepEqual(await readFile(receiptPath), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
