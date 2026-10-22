/**
 * Prepare the exact installed runtime, keeping development sources in the separate
 * GPL corresponding-source asset. Original development resources remain intact.
 * The portable source ZIP is already embedded by Vite for offline HTML export;
 * copying it here again would install a second identical archive.
 * @author ahui
 * SPDX-License-Identifier: GPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stream large models/archives; verification must not allocate their entire size. */
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Validate build metadata before it becomes a version-specific download promise. */
export function sourceDistribution(info, version) {
  assert.equal(info.version, version, 'Source version differs from the application');
  assert.equal(info.fileName, 'desktop-source.zip');
  assert.equal(info.license, 'GPL-3.0-only');
  assert(/^[a-f0-9]{64}$/u.test(info.sha256), 'Invalid source SHA256');
  assert(Number.isSafeInteger(info.bytes) && info.bytes > 0, 'Invalid source size');
  const fileName = `English-Class-Games-v${version}-Source.zip`;
  return {
    version,
    license: info.license,
    fileName,
    bytes: info.bytes,
    sha256: info.sha256,
    downloadUrl: `https://github.com/ahuiyuchuan/english-class-games/releases/download/v${version}/${fileName}`,
  };
}

/** Only reviewed runtime/notice paths may be installed; build sources stay in Source.zip. */
export function isRuntimeFile(name) {
  assert(
    !/[\\:\x00-\x1f]/u.test(name) &&
      name.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe speech resource path',
  );
  return (
    name === 'NOTICE.txt' ||
    name.startsWith('bin/') ||
    name.startsWith('model/') ||
    (name.startsWith('licenses/') &&
      !name.startsWith('licenses/sources/') &&
      !name.startsWith('licenses/worker/'))
  );
}

/**
 * Check every selected original before replacing the generated staging directory.
 * A mismatch leaves the previous stage intact and fails the build. No teacher data,
 * original source archives or remote service is modified or accessed.
 * @param {string} root Absolute source-checkout root; tests use an isolated fixture.
 * @returns {Promise<object>} Source identity and exact installed speech inventory.
 */
export async function prepareDesktopDistribution(root) {
  const resources = path.resolve(root, 'resources');
  const destination = path.join(resources, 'desktop-distribution');
  const staging = path.join(resources, `desktop-distribution-staging-${randomUUID()}`);
  const previous = path.join(resources, `desktop-distribution-previous-${randomUUID()}`);
  // Recursive cleanup is limited to these generated children of the verified root.
  for (const target of [destination, staging, previous]) {
    assert(path.dirname(target) === resources);
    const existing = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert(!existing?.isSymbolicLink(), 'Generated distribution cannot be a symlink');
  }
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert(/^\d+\.\d+\.\d+$/u.test(version), 'Invalid product version');
  const sourceRoot = path.join(resources, 'source');
  const info = JSON.parse(await readFile(path.join(sourceRoot, 'desktop-source.json'), 'utf8'));
  const source = sourceDistribution(info, version);
  const sourceArchive = path.join(sourceRoot, 'desktop-source.zip');
  assert.equal((await stat(sourceArchive)).size, source.bytes);
  assert.equal(await digest(sourceArchive), source.sha256, 'Source archive changed');
  const speechRoot = path.join(resources, 'tts');
  const manifest = JSON.parse(await readFile(path.join(speechRoot, 'manifest.json'), 'utf8'));
  const selected = manifest.files.filter((file) => isRuntimeFile(file.path));
  assert(selected.length > 0, 'Empty speech runtime');
  assert.equal(new Set(selected.map((file) => file.path)).size, selected.length);
  for (const file of selected) {
    const input = path.join(speechRoot, file.path);
    for (let current = input; current !== speechRoot; current = path.dirname(current))
      assert(!(await lstat(current)).isSymbolicLink(), 'Speech resource cannot be a symlink');
    assert.equal((await stat(input)).size, file.bytes, file.path);
    assert.equal(await digest(input), file.sha256, file.path);
  }
  let movedPrevious = false;
  try {
    await mkdir(path.join(staging, 'source'), { recursive: true });
    for (const file of selected) {
      const output = path.join(staging, 'tts', file.path);
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(path.join(speechRoot, file.path), output);
      assert.equal(await digest(output), file.sha256, `Copied resource changed: ${file.path}`);
    }
    const runtimeManifest = { ...manifest };
    delete runtimeManifest.workerSource;
    await writeFile(
      path.join(staging, 'tts/manifest.json'),
      JSON.stringify({ ...runtimeManifest, sourceDistribution: source, files: selected }, null, 2) +
        '\n',
    );
    await writeFile(
      path.join(staging, 'source/desktop-source.json'),
      JSON.stringify(source, null, 2) + '\n',
    );
    await writeFile(
      path.join(staging, 'source/SOURCE-ACCESS.txt'),
      `English Class Games ${version} — GPL-3.0-only\n\n完整对应源码 / Complete Corresponding Source\n${source.downloadUrl}\n文件 / File: ${source.fileName}\n字节 / Bytes: ${source.bytes}\nSHA256: ${source.sha256}\n\n无需账号、无额外费用；源码含自有代码、依赖源码、配音构建源码、锁文件及必要构建控制。\n安装器仅收录运行资源和许可，未重复内嵌完整桌面源码。\n网络分发按GPLv3 6(d)在同版本发行页同等提供源码。\n通过U盘等物理介质转交安装器时，按GPLv3 6(a)同时携带本源码ZIP。\n离线安装、配音、导出及课堂无需联网；HTML仍内嵌播放器源码。\n\nNo login or additional charge. Source includes owned code, dependency and speech\nbuild sources, lockfiles and required build controls. Under GPLv3 6(d), the source\nis available alongside this installer. When conveying on physical media, include\nthe matching source ZIP under 6(a). Installation and classroom use remain offline.\n`,
    );
    for (const name of ['LICENSE', 'COPYRIGHT'])
      await copyFile(path.join(root, name), path.join(staging, 'source', name));
    if (await stat(destination).catch(() => undefined)) {
      await rename(destination, previous);
      movedPrevious = true;
    }
    await rename(staging, destination);
    if (movedPrevious) await rm(previous, { recursive: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (movedPrevious && !(await stat(destination).catch(() => undefined)))
      await rename(previous, destination);
    throw error;
  }
  return {
    source,
    installedSpeechFiles: selected.length,
    installedSpeechBytes: selected.reduce((sum, file) => sum + file.bytes, 0),
    omittedSpeechBytes: manifest.files
      .filter((file) => !isRuntimeFile(file.path))
      .reduce((sum, file) => sum + file.bytes, 0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify(
      await prepareDesktopDistribution(fileURLToPath(new URL('../', import.meta.url))),
    ),
  );
