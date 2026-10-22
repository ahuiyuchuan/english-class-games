/**
 * Fetch hash-pinned upstream preferred source for a Git checkout, never at runtime.
 * Existing mismatches fail instead of replacing local edits. Distributed complete
 * source already has third-party/upstream and does not need this network step.
 * @author ahui
 * SPDX-License-Identifier: GPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

const directory = new URL('../resources/source-upstream/', import.meta.url);
const entries = JSON.parse(await readFile(new URL('sources.json', directory), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(directory, { recursive: true });
for (const item of entries) {
  assert(/^[A-Za-z0-9._-]+\.zip$/u.test(item.name));
  assert(/^[a-f0-9]{64}$/u.test(item.sha256));
  const target = new URL(item.name, directory);
  if (
    await stat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    })
  ) {
    assert.equal(
      digest(await readFile(target)),
      item.sha256,
      `Preserve and review modified archive: ${item.name}`,
    );
  } else {
    assert(!item.bundled, `Restore the bundled, hash-pinned source from Git: ${item.name}`);
    const url = new URL(item.archiveUrl ?? item.source);
    assert(
      url.protocol === 'https:' &&
        ['codeload.github.com', 'git.sheetjs.com'].includes(url.hostname),
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
    assert(response.ok, `Source download failed: ${item.name} (${response.status})`);
    const chunks = [];
    let size = 0;
    // Stream a reviewed upper bound rather than allocating an unbounded body.
    for await (const chunk of response.body) {
      size += chunk.length;
      assert(size <= 128 * 1024 * 1024, `Source archive exceeds bound: ${item.name}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(digest(bytes), item.sha256, `Source SHA-256 mismatch: ${item.name}`);
    await writeFile(target, bytes, { flag: 'wx' });
  }
  console.log(`Verified source: ${item.name}`);
}
