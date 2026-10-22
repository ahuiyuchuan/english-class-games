/**
 * Package preferred source with each distribution, without Git history or teacher data.
 * ZIP entries are explicit regular files, sorted and timestamped deterministically.
 * Generated archives/runtime are excluded to avoid recursive self-inclusion.
 * @author ahui
 * SPDX-License-Identifier: GPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = process.argv.includes('--desktop');
const output = path.join(root, 'resources/source');
// Source inventories and extraction are one transaction. Concurrent dev/build
// commands must fail visibly rather than emit a mixed or incomplete source ZIP.
const lockFile = path.join(root, 'node_modules/.cache/ecg-source-build.lock');
mkdirSync(path.dirname(lockFile), { recursive: true });
let sourceLock;
try {
  sourceLock = openSync(lockFile, 'wx');
} catch (cause) {
  throw new Error(
    '对应源码正在构建，请等待该构建结束后重试。强制终止后可删除node_modules/.cache/ecg-source-build.lock。',
    { cause },
  );
}
writeSync(sourceLock, String(process.pid));
process.once('exit', () => {
  closeSync(sourceLock);
  unlinkSync(lockFile);
});
const staging = path.join(root, 'node_modules/.cache/ecg-source', desktop ? 'desktop' : 'portable');
const entries = new Map();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** No arbitrary archive paths or symbolic links; third-party bytes stay unchanged. */
async function add(file, name) {
  assert(!name.startsWith('/') && name.split('/').every((p) => p && p !== '..'));
  const bytes = await readFile(file);
  const prior = entries.get(name);
  assert(!prior || prior.sha256 === digest(bytes), `Conflicting source entry: ${name}`);
  entries.set(name, { file, sha256: digest(bytes), bytes: bytes.length });
}

/** Skip package-manager links, generated code and runtime data explicitly. */
async function tree(directory, prefix, excluded = () => false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (excluded(name) || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await tree(file, name, excluded);
    else if (entry.isFile()) await add(file, name);
  }
}

await mkdir(output, { recursive: true });
// Staging is not application source: keep third-party globals/tests out of TS,
// lint and test discovery. Remove only these known generated predecessor paths.
for (const name of ['upstream', 'source-staging'])
  await rm(path.join(root, 'src/portable/generated', name), { recursive: true, force: true });
// All original project modules are retained, even when tree-shaken from this player.
for (const directory of ['src', 'scripts', 'docs', 'public', 'tests'])
  await tree(
    path.join(root, directory),
    directory,
    (n) =>
      n.startsWith('src/portable/generated/') ||
      n.startsWith('docs/assets/') ||
      n.startsWith('docs/references/') ||
      n.startsWith('docs/release-notes/validation-'),
  );
for (const item of await readdir(root, { withFileTypes: true })) {
  if (
    item.isFile() &&
    !item.name.startsWith('.') &&
    // An extracted source checkout has this generated inventory at its root.
    // Repackaging it would duplicate the newly written ZIP manifest entry.
    !['release-resources.json', 'SOURCE-MANIFEST.json'].includes(item.name)
  )
    await add(path.join(root, item.name), item.name);
}
for (const name of [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierrc.json',
  '.prettierignore',
])
  await add(path.join(root, name), name);
for (const directory of ['dictionary', 'licenses', 'icons', 'music'])
  // Music's generator and calibration/license metadata are source inputs;
  // omit generated PCM, which builds recreate without private media.
  await tree(path.join(root, 'resources', directory), `resources/${directory}`, (n) =>
    n.endsWith('.wav'),
  );
await add(
  path.join(root, 'resources/source-upstream/sources.json'),
  'resources/source-upstream/sources.json',
);
// Include unmodified preferred code, not duplicate compressed website/demo archives.
let upstream = path.join(root, 'third-party/upstream');
// A distributed source checkout already contains the retained editable tree.
// Maintainer checkouts extract it from pinned archives, without runtime downloads.
if (!(await stat(upstream).catch(() => undefined))) {
  upstream = path.join(staging, 'upstream');
  execFileSync('python', ['scripts/extract-upstream-source.py', upstream], {
    cwd: root,
    timeout: 120000,
  });
}
await tree(upstream, 'third-party/upstream');
for (const item of await readdir(path.join(root, 'resources'), { withFileTypes: true }))
  if (item.isFile()) await add(path.join(root, 'resources', item.name), `resources/${item.name}`);

const visited = new Set();
let extractedSources = 0;
/**
 * Retain exact npm source distributions and standalone preferred sources embedded
 * by upstream in maps. The independent TS/TSX files, not maps, are provided for edits.
 * React's original monorepo and SoundTouch's original TS are additionally retained.
 */
async function dependency(packageFile) {
  packageFile = await realpath(packageFile);
  if (visited.has(packageFile)) return;
  visited.add(packageFile);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  const directory = path.dirname(packageFile);
  const prefix = `third-party/npm/${metadata.name.replaceAll('/', '__')}@${metadata.version}`;
  // Phosphor's full TSX tree is supplied upstream; thousands of generated icon
  // bundles add no editable source and would unnecessarily enlarge each HTML.
  await tree(
    directory,
    `${prefix}/distribution`,
    (n) => metadata.name === '@phosphor-icons/react' && n.includes('/dist/'),
  );
  for (const [name, item] of [...entries]) {
    if (!name.startsWith(`${prefix}/distribution/`) || !name.endsWith('.map')) continue;
    const map = JSON.parse(await readFile(item.file, 'utf8'));
    for (const [index, content] of (map.sourcesContent ?? []).entries()) {
      if (content === null) continue;
      const source = map.sources[index];
      if (!source || !/\.(?:[cm]?[jt]sx?|css)$/u.test(source)) continue;
      const safe = source.replace(/^(?:\.\.\/|\.\/)+/u, '').replace(/[^A-Za-z0-9._/-]/gu, '_');
      if (safe.split('/').includes('..')) continue;
      const target = `${prefix}/preferred/${safe}`;
      const file = path.join(staging, 'preferred', target);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      await add(file, target);
      extractedSources++;
    }
  }
  for (const name of Object.keys(metadata.dependencies ?? {}).sort()) {
    const searches = createRequire(packageFile).resolve.paths(name) ?? [];
    let child;
    for (const search of searches) {
      const candidate = path.join(search, name, 'package.json');
      if (await stat(candidate).catch(() => undefined)) {
        child = candidate;
        break;
      }
    }
    assert(child, `Missing source dependency: ${name}`);
    await dependency(child);
  }
}
const main = path.join(root, 'package.json');
const metadata = JSON.parse(await readFile(main, 'utf8'));
for (const name of Object.keys(metadata.dependencies).sort())
  await dependency(path.join(root, 'node_modules', name, 'package.json'));

// Frontend icon generation reads Tauri product metadata and its output folder.
// Retain all owned native source/config too; only desktop adds external Cargo/TTS sources.
await tree(path.join(root, 'src-tauri'), 'src-tauri', (n) =>
  /^src-tauri\/(?:target|gen)\//u.test(n),
);
if (desktop) {
  await tree(path.join(root, 'resources/tts/licenses'), 'resources/tts/licenses');
  await add(path.join(root, 'resources/tts/NOTICE.txt'), 'resources/tts/NOTICE.txt');
  await add(path.join(root, 'release-resources.json'), 'release-resources.json');
  const cargo = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--locked',
        '--offline',
        '--format-version',
        '1',
        '--filter-platform',
        'x86_64-pc-windows-msvc',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  for (const pkg of cargo.packages.filter((p) => p.source?.startsWith('registry+')))
    await tree(path.dirname(pkg.manifest_path), `third-party/cargo/${pkg.name}-${pkg.version}`);
}

const files = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const manifest = {
  author: 'ahui',
  productVersion: metadata.version,
  license: 'GPL-3.0-only',
  scope: desktop ? 'desktop' : 'portable',
  omittedNonSource:
    'Git history, teacher media, reference screenshots, local validation reports, generated binaries/caches and optional upstream test snapshots are excluded. Current validation accompanies the distribution separately.',
  npmPackages: visited.size,
  extractedPreferredSources: extractedSources,
  files: files.map(([name, item]) => ({ path: name, sha256: item.sha256, bytes: item.bytes })),
};
const name = desktop ? 'desktop-source' : 'portable-source';
const manifestFile = path.join(output, `${name}-manifest.json`);
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
const input = path.join(staging, 'source-zip-input.json');
await mkdir(path.dirname(input), { recursive: true });
await writeFile(
  input,
  JSON.stringify([
    ...files.map(([name, item]) => [item.file, name, item.sha256]),
    [manifestFile, 'SOURCE-MANIFEST.json', digest(await readFile(manifestFile))],
  ]),
);
const archive = path.join(output, `${name}.zip`);
// zipfile streams each entry; large native source trees do not live in one JS buffer.
execFileSync('python', ['scripts/write-source-zip.py', input, archive], {
  cwd: root,
  timeout: 600000,
});
const bytes = await readFile(archive);
const info = {
  fileName: `${name}.zip`,
  sha256: digest(bytes),
  bytes: bytes.length,
  manifestSha256: digest(await readFile(manifestFile)),
  license: 'GPL-3.0-only',
  version: metadata.version,
};
await writeFile(path.join(output, `${name}.json`), JSON.stringify(info, null, 2) + '\n');
if (!desktop) {
  // Fresh source ZIPs deliberately omit generated output. Create its directory
  // here, before build-portable's imported source transaction writes metadata.
  await mkdir(path.join(root, 'src/portable/generated'), { recursive: true });
  await writeFile(
    path.join(root, 'src/portable/generated/source.json'),
    JSON.stringify(info) + '\n',
  );
  await copyFile(archive, path.join(root, 'src/portable/generated/portable-source.zip'));
}
// Installer recipients can read these texts without extracting a source archive.
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
await copyFile(path.join(root, 'COPYRIGHT'), path.join(output, 'COPYRIGHT'));
console.log(
  JSON.stringify({
    ...info,
    sourceFiles: files.length,
    npmPackages: visited.size,
    extractedPreferredSources: extractedSources,
  }),
);
