/**
 * Prepare the pinned desktop speech distribution for a source checkout.
 * This build-time tool accepts only a local archive; it never contacts a server.
 * Hashes, archive paths and existing files are checked
 * before any missing file is installed. The teacher's library is never accessed.
 * @author ahui
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const lockPath = join(root, 'release-resources.json');
const run = promisify(execFile);
const prefix = 'resources/tts/';
// Reviewed model/runtime plus pinned corresponding sources; never an unbounded
// extraction allowance. Each file and the total must also match the locked list.
const maximumBytes = 512 * 1024 * 1024;

/** Stream hashing bounds memory even for the 170MB FP32 model. */
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Missing is recoverable; permission/I/O errors must not masquerade as absence. */
async function existing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The fixed source distribution contains regular files only, with no link escape. */
async function inventory(directory, relative = 'resources/tts') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = `${relative}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Resource link is not allowed: ${name}`);
    if (entry.isDirectory()) files.push(...(await inventory(path, name)));
    else {
      assert(entry.isFile(), `Resource must be a regular file: ${name}`);
      files.push({ path: name, bytes: (await stat(path)).size, sha256: await digest(path) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** Validate the committed lock before using it as a filesystem write allowlist. */
function validateLock(lock) {
  assert.equal(lock.formatVersion, 1);
  assert.equal(lock.productVersion, '1.0.0');
  assert(/^[A-Za-z0-9.-]+\.tar\.gz$/.test(lock.asset));
  assert(/^[a-f0-9]{64}$/.test(lock.sha256));
  assert(lock.bytes > 0 && lock.bytes <= maximumBytes);
  assert(Array.isArray(lock.files) && lock.files.length > 0 && lock.files.length <= 4096);
  const names = new Set();
  let total = 0;
  for (const file of lock.files) {
    assert(file.path.startsWith(prefix) && !/[\\:\x00-\x1f]/.test(file.path));
    assert(file.path.split('/').every((part) => part && part !== '.' && part !== '..'));
    assert(!names.has(file.path), 'Duplicate locked resource');
    names.add(file.path);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= maximumBytes);
    assert(/^[a-f0-9]{64}$/.test(file.sha256));
    total += file.bytes;
  }
  assert(total <= maximumBytes, 'Uncompressed resources exceed the reviewed budget');
}

/**
 * Compare all existing destinations before copying anything. A source checkout
 * may already contain notices/worker sources; a local edit must never be replaced.
 * @returns {Promise<string[]>} Paths absent from this checkout; modified files throw.
 */
async function missingFiles(lock) {
  const missing = [];
  for (const file of lock.files) {
    const target = join(root, file.path);
    // Reject a pre-existing symlink anywhere in the destination chain as well.
    for (let parent = dirname(target); parent !== root.slice(0, -1); parent = dirname(parent)) {
      const info = await existing(parent);
      assert(!info?.isSymbolicLink(), `Resource directory cannot be a link: ${file.path}`);
      if (parent === dirname(parent)) break;
    }
    const info = await existing(target);
    if (!info) missing.push(file.path);
    else {
      assert(info.isFile() && !info.isSymbolicLink(), `Invalid resource target: ${file.path}`);
      assert(
        info.size === file.bytes && (await digest(target)) === file.sha256,
        `Existing resource differs; preserve your edit and review it first: ${file.path}`,
      );
    }
  }
  return missing;
}

/**
 * tar is an existing Windows 10+/CI build tool, not an application dependency.
 * Only an exact hash-locked archive is extracted into a disposable staging area;
 * its entries must match the allowlist, then all extracted file hashes are checked.
 */
async function restore(lock, archive, staging, missing) {
  assert.equal((await stat(archive)).size, lock.bytes, 'Resource archive size mismatch');
  assert.equal(await digest(archive), lock.sha256, 'Resource archive SHA-256 mismatch');
  const { stdout } = await run('tar', ['-tzf', archive], {
    maxBuffer: 1024 * 1024,
    timeout: 180_000,
  });
  const allowed = new Set(lock.files.map((file) => file.path));
  const seen = new Set();
  for (const entry of stdout.trim().split(/\r?\n/)) {
    assert(!seen.has(entry), 'Duplicate archive entry');
    seen.add(entry);
    assert(
      allowed.has(entry) ||
        (entry.endsWith('/') && [...allowed].some((path) => path.startsWith(entry))),
      `Unexpected archive entry: ${entry}`,
    );
  }
  for (const path of allowed) assert(seen.has(path), `Missing archive entry: ${path}`);
  await run('tar', ['-xzf', archive, '-C', staging], { timeout: 180_000 });
  assert.deepEqual(await inventory(join(staging, 'resources/tts')), lock.files);
  // All checks precede writes. COPYFILE_EXCL also refuses a concurrently created file.
  const installed = [];
  try {
    for (const path of missing) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(staging, path), target, constants.COPYFILE_EXCL);
      installed.push(target);
    }
  } catch (error) {
    for (const target of installed) await rm(target);
    throw error;
  }
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args[0] === 'pack') {
  assert.equal(args.length, 2, 'Usage: node scripts/release-resources.mjs pack <new-archive-path>');
  const output = resolve(args[1]);
  assert(!(await existing(output)), 'Do not overwrite a prepared/published resource archive');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const files = await inventory(join(root, 'resources/tts'));
  await mkdir(dirname(output), { recursive: true });
  // Enumerate actual reviewed files, rather than directories: empty local folders
  // must not become undeclared entries in a clean checkout's immutable archive.
  await run('tar', ['-czf', output, '-C', root, ...files.map((file) => file.path)], {
    timeout: 180_000,
  });
  const lock = {
    formatVersion: 1,
    productVersion: version,
    asset: `English-Class-Games-v${version}-Desktop-Resources.tar.gz`,
    bytes: (await stat(output)).size,
    sha256: await digest(output),
    files,
  };
  validateLock(lock);
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`Prepared ${lock.asset}: ${lock.bytes} bytes; SHA-256 ${lock.sha256}`);
} else {
  assert(
    args.length === 0 || (args.length === 2 && args[0] === '--archive'),
    'Use --archive <path> or no arguments',
  );
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  validateLock(lock);
  const missing = await missingFiles(lock);
  if (missing.length) {
    const staging = await mkdtemp(join(tmpdir(), 'ecg-source-resources-'));
    try {
      assert(
        args[1],
        'Missing speech resources. Use --archive <local Desktop-Resources.tar.gz path>.',
      );
      const archive = resolve(args[1]);
      await restore(lock, archive, staging, missing);
      assert.equal((await missingFiles(lock)).length, 0);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  console.log(
    `Desktop speech resources verified: ${lock.files.length} files; no classroom network dependency.`,
  );
}
