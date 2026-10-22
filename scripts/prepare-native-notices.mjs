/**
 * Preserve license texts from the exact Cargo packages used by the Windows build.
 * Normal and build dependencies are included conservatively; dev dependencies
 * and packages selected only for other targets are excluded. No network fetch,
 * registry mutation, or hand-written replacement license is performed here.
 * @author ahui
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const retainedSources = JSON.parse(
  await readFile(path.join(root, 'resources/licenses/native-sources.json'), 'utf8'),
).packages;
const metadata = JSON.parse(
  execFileSync(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
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
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const selected = new Set();
const pending = [metadata.resolve.root];
while (pending.length) {
  const id = pending.pop();
  if (selected.has(id)) continue;
  selected.add(id);
  for (const dependency of nodes.get(id)?.deps ?? []) {
    if (dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dependency.pkg);
  }
}

/**
 * Read original root license/notice files and any explicitly declared license
 * file. Nested license directories are retained because some crates preserve
 * multiple upstream copyright grants there. Paths may not escape the crate.
 * @param {object} dependency Resolved Cargo package metadata.
 * @returns {Promise<Array<{name: string, text: string}>>} Actual license files.
 */
async function licenseFiles(dependency) {
  const directory = path.dirname(dependency.manifest_path);
  const candidates = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^(?:licen[cs]es?|copying|notice|unlicense)(?:$|[._-])/i.test(entry.name)) continue;
    if (entry.isFile()) candidates.add(entry.name);
    else if (entry.isDirectory()) {
      for (const item of await readdir(path.join(directory, entry.name), { recursive: true })) {
        candidates.add(path.join(entry.name, item));
      }
    }
  }
  if (dependency.license_file) {
    const relative = path.relative(directory, path.resolve(directory, dependency.license_file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`License file escapes the package: ${dependency.name}`);
    }
    candidates.add(relative);
  }
  const files = [];
  for (const name of [...candidates].sort()) {
    const filename = path.join(directory, name);
    if (!(await stat(filename)).isFile()) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filename));
    files.push({ name: name.replaceAll('\\', '/'), text: text.replaceAll('\r\n', '\n').trim() });
  }
  // Some published workspace subcrates omit their repository-level license.
  // Only exact package/version entries with a checked-in source URL and digest
  // may supply that missing text; SPDX names alone never fabricate a grant.
  const retained = retainedSources[`${dependency.name}@${dependency.version}`];
  if (!files.length && retained) {
    if (retained.declaredLicense !== dependency.license) {
      throw new Error(`Retained license declaration changed: ${dependency.name}`);
    }
    for (const entry of retained.files) {
      if (path.basename(entry.file) !== entry.file) {
        throw new Error(`Retained license filename is unsafe: ${entry.file}`);
      }
      const bytes = await readFile(path.join(root, 'resources/licenses/native', entry.file));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        throw new Error(`Retained license digest changed: ${entry.file}`);
      }
      files.push({
        name: `${entry.file}\nRetained source: ${entry.source}\n${retained.note}`,
        text: new TextDecoder('utf-8', { fatal: true })
          .decode(bytes)
          .replaceAll('\r\n', '\n')
          .trim(),
      });
    }
  }
  return files;
}

const dependencies = metadata.packages
  .filter((dependency) => selected.has(dependency.id) && dependency.id !== metadata.resolve.root)
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
const sections = [];
const missing = [];
for (const dependency of dependencies) {
  const files = await licenseFiles(dependency);
  if (!files.length) {
    missing.push(`${dependency.name}@${dependency.version}: ${dependency.license ?? 'undeclared'}`);
    continue;
  }
  sections.push(
    [
      `${dependency.name}@${dependency.version}`,
      `Declared license: ${dependency.license ?? 'See original license text'}`,
      `Authors: ${dependency.authors.join('; ') || 'See original copyright notices'}`,
      `Repository: ${dependency.repository ?? 'See package source'}`,
      `Exact source: https://crates.io/api/v1/crates/${dependency.name}/${dependency.version}/download`,
      ...files.map((file) => `\n${file.name}\n${file.text}`),
    ].join('\n'),
  );
}
if (missing.length) {
  throw new Error(
    `Cannot generate incomplete native notices; missing original text:\n${missing.join('\n')}`,
  );
}
const header = [
  'English Class Games — native third-party dependency notices',
  'Generated by scripts/prepare-native-notices.mjs. Maintainer: ahui.',
  'Exact locked Windows x64 normal/build dependency graph; no dev dependencies.',
  'This conservative inventory also includes build-time packages.',
  'Original license and copyright notices follow. Source links identify exact crate versions.',
  'MPL-covered source files are available in the corresponding unmodified crate archives.',
];
await writeFile(
  path.join(root, 'resources/NATIVE-THIRD-PARTY-NOTICES.txt'),
  `${header.join('\n')}\n\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}\n`,
  'utf8',
);
console.log(
  `Preserved original license texts for ${dependencies.length} native production/build packages.`,
);
