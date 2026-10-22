/**
 * 材料校对、材料维护和课件编辑共用的来源及标签交互。
 * 来源、词库校对和本课确认分别呈现，避免教师接受动作被误认为词库已校对。
 * @author ahui
 */
import { useEffect, useState } from 'react';
import type { TeachingEntry } from '../platform/types';
import { normalizeTeachingTags } from '../platform/materials/parser';
import { Badge, InputField } from '../shared/ui';

/**
 * 展示已记录的三个独立来源维度；缺省校对值保持未知，不能通过名称或教师确认推断。
 * @param props.source 接受候选时保留的词库快照；省略表示教师提供内容。
 * @param props.confirmed 仅实际确认记录为 true 时展示本课确认标签。
 */
export function MeaningSourceBadges({
  source,
  confirmed,
}: {
  source?: TeachingEntry['meaningSource'];
  confirmed?: boolean;
}) {
  return (
    <div className="row" aria-label="教学内容来源与确认">
      <Badge tone={source ? 'ai' : ''}>
        {!source
          ? '教师提供'
          : source.candidateSource === 'common'
            ? '常用词'
            : source.candidateSource === 'dictionary'
              ? '词库参考'
              : '词义来源'}
      </Badge>
      {source?.teacherRevised && <Badge>教师修订</Badge>}
      {source && (
        <Badge>
          {source.reviewStatus === 'reviewed-sense'
            ? '已校对教学义项'
            : source.reviewStatus === 'reference'
              ? '未校对参考释文'
              : '未记录校对状态'}
        </Badge>
      )}
      {confirmed === true && <Badge tone="success">教师已确认</Badge>}
    </div>
  );
}

/** 教学来源的可展开详情：原材料位置与词库候选分别列出，完整原文不截断。 */
export function TeachingEntrySource({ entry }: { entry: TeachingEntry }) {
  return (
    <div className="stack-sm">
      <MeaningSourceBadges source={entry.meaningSource} confirmed={entry.confirmed} />
      <details>
        <summary>查看来源与原文</summary>
        <p>
          材料来源：{entry.source?.name ?? '教师手工录入'}
          {entry.source?.line ? ` · 第 ${entry.source.line} 行` : ''}
          {entry.source?.position !== undefined ? ` · 原文位置 ${entry.source.position + 1}` : ''}
        </p>
        {entry.source?.original && <p className="teaching-source-text">{entry.source.original}</p>}
        {entry.meaningSource && (
          <>
            <p>
              词义来源：{entry.meaningSource.name} · {entry.meaningSource.version}
            </p>
            <p className="teaching-source-text">
              原候选：{entry.meaningSource.english} ·{' '}
              {entry.meaningSource.originalMeaning ?? '旧资料未记录原候选快照'}{' '}
              {entry.meaningSource.originalPartOfSpeech ?? ''}
            </p>
          </>
        )}
      </details>
    </div>
  );
}

/**
 * 编辑期间保留逗号、空项等原始键入，避免输入“高中,”后立即失去分隔符而无法继续。
 * 数据层始终收到规范标签，超限值仍完整保留；外部撤销/切换对象时按新数据同步。
 */
export function TeachingTagsField({
  id,
  label = '标签（逗号分隔）',
  value = [],
  onChange,
  error,
  disabled,
}: {
  id?: string;
  label?: string;
  value?: readonly string[];
  onChange: (tags: string[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  const formatted = value.join(', ');
  const [raw, setRaw] = useState(formatted);
  useEffect(() => {
    setRaw((previous) =>
      normalizeTeachingTags(previous).join(', ') === formatted ? previous : formatted,
    );
  }, [formatted]);
  return (
    <InputField
      {...(id ? { id } : {})}
      label={label}
      value={raw}
      error={error}
      disabled={disabled}
      hint="最多10个，每个最多24字符；中英文逗号分隔。"
      onChange={(event) => {
        setRaw(event.target.value);
        onChange(normalizeTeachingTags(event.target.value));
      }}
      onBlur={() => setRaw(normalizeTeachingTags(raw).join(', '))}
    />
  );
}
