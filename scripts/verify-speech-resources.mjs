/**
 * Verify the exact offline speech distribution before bundling. --write is an
 * explicit maintainer operation after reviewing upstream provenance/licenses;
 * normal builds never silently accept changed binaries or a Git LFS pointer.
 * @author ahui
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../resources/tts/', import.meta.url));
/** Recursively enumerate only distribution files; the manifest cannot hash itself. */
async function inventory(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await inventory(path)));
    else if (relative(root, path) !== 'manifest.json') {
      const bytes = await readFile(path);
      result.push({
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
assert((await stat(join(root, 'model/model.onnx'))).size > 100_000_000, 'Missing real FP32 model');
const files = await inventory(root);
const manifestPath = join(root, 'manifest.json');
if (process.argv.includes('--write')) {
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        author: 'ahui',
        engine: 'sherpa-onnx 1.13.8 Windows x64 shared MT Release',
        engineSource: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8',
        model: 'MeloTTS Chinese+English FP32',
        modelSource:
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2',
        workerSource: 'licenses/worker/tts-worker.cpp',
        linkedWorkerLicense: 'GPL-3.0-only',
        modelLicense: 'MIT',
        files,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(files, manifest.files, 'Speech distribution differs from reviewed manifest');
}
console.log(
  `Offline speech: ${files.length} verified files; ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes`,
);
