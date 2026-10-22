/**
 * 从固定 ECDICT 提交准备可携带的高中词库。仅构建准备阶段联网，产品运行不请求网络。
 * 原始 CSV 和许可均校验 Git blob SHA-1，JSON 同时记录来源 SHA-256；不补造未知义项。
 * 执行：node scripts/prepare-dictionary.mjs；已存在且校验通过的源缓存可离线复用。
 * @author ahui
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(projectDirectory, 'resources', 'dictionary');
const revision = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b';
const sources = {
  'ecdict.csv': { sha1: 'c4ade63ea08cf39d9c3475e96929036d64d94c94', byteLength: 65_933_428 },
  LICENSE: { sha1: '594da8a1009c6a9b96d0fe8d1689aa192cf187fe', byteLength: 1_063 },
};
const cacheDirectory = join(tmpdir(), `english-class-games-ecdict-${revision}`);
// 补充短语仍从同一源文件取真实条目；缺失时不伪造，不作官方教材匹配承诺。
const supplementaryPhrases = new Set([
  'take part in',
  'look forward to',
  'pay attention to',
  'make use of',
  'be interested in',
  'as a result',
  'in addition',
  'in order to',
  'in fact',
  'in particular',
  'on the other hand',
  'get along with',
  'look after',
  'give up',
  'carry out',
  'turn out',
  'set up',
  'deal with',
  'in advance',
  'in common',
  'out of date',
  'a variety of',
  'in charge of',
  'in spite of',
]);

/** 校验固定提交的实际文件内容，不能只相信下载 URL 或 HTTP 成功。 */
function validSource(bytes, specification) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return (
    bytes.byteLength === specification.byteLength &&
    createHash('sha1').update(header).update(bytes).digest('hex') === specification.sha1
  );
}

/** 只接受固定来源和预期大小；失败不覆盖上次已生成的词库。 */
async function loadSource(name) {
  const specification = sources[name];
  const cachedPath = join(cacheDirectory, name);
  try {
    const cached = await readFile(cachedPath);
    if (validSource(cached, specification)) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(
    `https://raw.githubusercontent.com/skywind3000/ECDICT/${revision}/${name}`,
  );
  if (!response.ok || !response.body) throw new Error(`下载 ${name} 失败：HTTP ${response.status}`);
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    byteLength += chunk.byteLength;
    if (byteLength > specification.byteLength) throw new Error(`${name} 超出固定来源大小。`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!validSource(bytes, specification)) throw new Error(`${name} 的固定提交校验不通过。`);
  await writeFile(cachedPath, bytes);
  return bytes;
}

/** 源 CSV 流式产出行，避免把 70 万词的全部字段同时保存在内存中。 */
function* csvRows(text) {
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"' && value.length === 0) quoted = true;
    else if (character === ',' || character === '\n' || character === '\r') {
      row.push(value);
      value = '';
      if (character !== ',') {
        yield row;
        row = [];
        if (character === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else value += character;
  }
  if (quoted) throw new Error('固定源 CSV 存在未闭合引号。');
  if (value || row.length > 0) {
    row.push(value);
    yield row;
  }
}

await mkdir(cacheDirectory, { recursive: true });
const csvBytes = await loadSource('ecdict.csv');
const licenseBytes = await loadSource('LICENSE');
const rows = csvRows(new TextDecoder('utf-8', { fatal: true }).decode(csvBytes));
const header = rows.next().value;
const column = Object.fromEntries(header.map((name, index) => [name, index]));
const entries = [];
for (const row of rows) {
  const english = row[column.word]?.trim() ?? '';
  const tags = (row[column.tag] ?? '').trim().split(/\s+/u).filter(Boolean);
  if (!tags.includes('gk') && !supplementaryPhrases.has(english.toLowerCase())) continue;
  if (!english || [...english].length > 120) continue;
  const meaning = (row[column.translation] ?? '').replace(/\\n/gu, '\n').trim();
  // ECDICT 的 0: 表示原形，不是“该词的变形”；只把明确的屈折形式加入反查索引。
  const forms = [
    ...new Set(
      (row[column.exchange] ?? '')
        .split('/')
        .flatMap((item) => (/^[pdi3rts]:/u.test(item) ? item.slice(2).split(',') : []))
        .filter(Boolean),
    ),
  ];
  entries.push({
    english,
    meaning,
    partOfSpeech: row[column.pos] ?? '',
    forms,
    tags,
    source: 'ECDICT',
    sourceVersion: revision,
    reviewStatus: 'reference',
  });
}
if (entries.length < 1_000) throw new Error('高中筛选结果异常偏少，停止生成以免发布空词库。');
// 明确登记的教学校对结果覆盖对应原记录，原释文仍作为参考快照保留。
// 不根据逗号数量或记录数量猜测“单义”，未列入校对清单的一律不可批量接受。
const reviewBytes = await readFile(join(outputDirectory, 'reviewed-senses.json'));
const review = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reviewBytes));
// 功能词清单是人工维护的产品规则，清单本身不由词库加工脚本重写。
// 发布时验证来源并记录摘要，避免词库清单和前端实际折叠规则悄悄不一致。
const functionWordBytes = await readFile(join(outputDirectory, 'function-words.json'));
const functionWords = JSON.parse(
  new TextDecoder('utf-8', { fatal: true }).decode(functionWordBytes),
);
if (
  !Number.isInteger(functionWords.version) ||
  functionWords.version < 1 ||
  !Array.isArray(functionWords.words) ||
  !functionWords.words.length ||
  functionWords.words.some((word) => typeof word !== 'string' || !/^[a-z]+$/u.test(word)) ||
  new Set(functionWords.words).size !== functionWords.words.length
)
  throw new Error('功能词清单须提供正整数版本及不重复的小写英文词。');
if (
  review.sourceRevision !== revision ||
  !Array.isArray(review.entries) ||
  !review.processingVersion
)
  throw new Error('教学校对清单与固定词库来源不一致。');
const reviewedWords = new Set(review.entries.map((entry) => entry.english));
const originals = new Map(entries.map((entry) => [entry.english, entry]));
const reviewedEntries = review.entries.map((sense) => {
  const original = originals.get(sense.english);
  if (
    !original ||
    typeof sense.meaning !== 'string' ||
    !sense.meaning.trim() ||
    [...sense.meaning].length > 200 ||
    typeof sense.partOfSpeech !== 'string'
  )
    throw new Error(`教学校对义项无固定原记录或字段无效：${sense.english}`);
  const reference = original.meaning.replace(/\.{3}/gu, '…');
  if (sense.meaning.split(/[,，]/u).some((portion) => !reference.includes(portion.trim())))
    throw new Error(`教学校对义项未能对照固定原释文：${sense.english}`);
  return {
    ...original,
    meaning: sense.meaning,
    partOfSpeech: sense.partOfSpeech,
    referenceMeaning: original.meaning,
    reviewStatus: 'reviewed-sense',
    reviewVersion: review.processingVersion,
  };
});
const publishedEntries = [
  ...entries.filter((entry) => !reviewedWords.has(entry.english)),
  ...reviewedEntries,
];
publishedEntries.sort((left, right) =>
  left.english < right.english ? -1 : left.english > right.english ? 1 : 0,
);
const output = `${JSON.stringify(publishedEntries)}\n`;
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'high-school.json'), output, 'utf8');
await writeFile(join(outputDirectory, 'LICENSE-ECDICT.txt'), licenseBytes);
await writeFile(
  join(outputDirectory, 'source.json'),
  `${JSON.stringify(
    {
      source: 'https://github.com/skywind3000/ECDICT',
      revision,
      license: 'MIT',
      filter: 'gk tag + explicitly listed supplementary phrases from the same source',
      sourceBlobSha1: sources['ecdict.csv'].sha1,
      sourceSha256: createHash('sha256').update(csvBytes).digest('hex'),
      dictionarySha256: createHash('sha256').update(output).digest('hex'),
      processingVersion: review.processingVersion,
      reviewScope: review.reviewScope,
      reviewManifestSha256: createHash('sha256').update(reviewBytes).digest('hex'),
      functionWordsVersion: functionWords.version,
      functionWordCount: functionWords.words.length,
      functionWordsSha256: createHash('sha256').update(functionWordBytes).digest('hex'),
      entryCount: publishedEntries.length,
      wordCount: new Set(
        publishedEntries
          .filter((entry) => !entry.english.includes(' '))
          .map((entry) => entry.english),
      ).size,
      phraseCount: new Set(
        publishedEntries
          .filter((entry) => entry.english.includes(' '))
          .map((entry) => entry.english),
      ).size,
      reviewedWordCount: reviewedWords.size,
      independentSenseCount: reviewedEntries.length,
      referenceRecordCount: publishedEntries.length - reviewedEntries.length,
      formIndexPairCount: publishedEntries.reduce((sum, entry) => sum + entry.forms.length, 0),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
process.stdout.write(
  `已校验固定来源：${publishedEntries.length} 条记录，其中 ${reviewedEntries.length} 个独立校对义项，其余仅供参考。\n`,
);
