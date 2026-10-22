// @vitest-environment jsdom
/** 材料跨页范围与常用词完整编辑的真实组件回归，不替代最终浏览器 / Windows 验收。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaterialsPage, CommonWordsDialog } from '../../app/MaterialsPage';
import { FeedbackProvider } from '../../shared/ui';
import type { MaterialCollection } from '../repository';
import type { TeachingEntry } from '../types';

afterEach(cleanup);

describe('材料范围和常用词校对', () => {
  it('2000 条材料每页仅50条，跨页选择不丢失，超过100须缩减后才制作', () => {
    const material: MaterialCollection = {
      id: 'material',
      name: '高中阅读材料',
      original: '教师原始材料',
      revision: 1,
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
      entries: Array.from({ length: 2000 }, (_, index) => ({
        id: `word-${index}`,
        english: `word${index}`,
        meaning: `义项${index}`,
        priority: false,
      })),
    };
    const make = vi.fn((_entries: TeachingEntry[]) => {});
    render(
      <FeedbackProvider>
        <MaterialsPage
          dictionary={[]}
          commonWords={[]}
          materials={[material]}
          onMaterials={vi.fn(async () => {})}
          onCommonWords={vi.fn(async () => {})}
          onMake={make}
          onSaveCommon={vi.fn()}
        />
      </FeedbackProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
    const dialogElement = screen.getByRole('dialog', { name: '材料详情与校对' });
    const dialog = within(dialogElement);
    expect(dialogElement.querySelectorAll('.property-group')).toHaveLength(50);
    const start = dialog.getByRole('button', { name: '用于智能制作' });
    expect(start).toBeDisabled();
    fireEvent.click(dialog.getByText('选择本页', { exact: true }));
    fireEvent.click(dialog.getByText('下一页词条', { exact: true }));
    fireEvent.click(dialog.getByText('选择本页', { exact: true }));
    expect(start).toBeEnabled();
    expect(dialog.getByText(/已选择 100/u)).toHaveTextContent('本页外 50 条');
    fireEvent.click(dialog.getByText('下一页词条', { exact: true }));
    fireEvent.click(dialog.getByText('选择本页', { exact: true }));
    expect(start).toBeDisabled();
    fireEvent.change(dialog.getByPlaceholderText('搜索英文、释义或词性'), {
      target: { value: 'word1999' },
    });
    expect(dialog.getByText(/已选择 150/u)).toHaveTextContent('本页外 150 条');
    fireEvent.click(dialog.getByText('清空选择', { exact: true }));
    fireEvent.click(dialog.getByText('选择本页', { exact: true }));
    fireEvent.click(start);
    expect(make).toHaveBeenCalledOnce();
    expect(make.mock.calls[0][0]).toEqual([material.entries[1999]]);
  }, 30_000);

  it('常用词可改英文、词性、释义、重点和标签，确认更新保留原身份及来源快照', async () => {
    const source: TeachingEntry = {
      id: 'teacher-word',
      english: 'take',
      meaning: '拿',
      partOfSpeech: 'v.',
      priority: false,
      meaningSource: {
        name: '受控词库',
        version: '1',
        english: 'take',
        originalMeaning: '拿',
        teacherRevised: false,
      },
    };
    const save = vi.fn(async (_entries: TeachingEntry[]) => {});
    render(
      <FeedbackProvider>
        <CommonWordsDialog entries={[source]} existing={[source]} onClose={vi.fn()} onSave={save} />
      </FeedbackProvider>,
    );
    fireEvent.change(screen.getByLabelText('英文 / 短语'), { target: { value: 'take part in' } });
    fireEvent.change(screen.getByLabelText('词性'), { target: { value: 'phrase' } });
    fireEvent.change(screen.getByLabelText('教学释义'), { target: { value: '参加' } });
    fireEvent.click(screen.getByLabelText('重点'));
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '高中, 单元1' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const [saved] = save.mock.calls[0][0];
    expect(saved).toMatchObject({
      id: source.id,
      english: 'take part in',
      partOfSpeech: 'phrase',
      meaning: '参加',
      priority: true,
      tags: ['高中', '单元1'],
      entryType: 'phrase',
    });
    expect(saved.meaningSource).toMatchObject({ originalMeaning: '拿', teacherRevised: true });
    expect(source.english).toBe('take');
  });

  it('常用词确认时复核全部页；非法新词阻止发布，明确跳过才可保存其他内容', async () => {
    const invalid: TeachingEntry = {
      id: 'invalid',
      english: '',
      meaning: '教师输入',
      priority: false,
    };
    const save = vi.fn(async (_entries: TeachingEntry[]) => {});
    render(
      <FeedbackProvider>
        <CommonWordsDialog entries={[invalid]} existing={[]} onClose={vi.fn()} onSave={save} />
      </FeedbackProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').every((element) => element.textContent?.includes('1～120')),
      ).toBe(true),
    );
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'skip' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith([]));
  });

  it('常用词持久化未完成时暂停表单修改与重复提交，完成后才关闭', async () => {
    const entry: TeachingEntry = {
      id: 'new-word',
      english: 'knowledge',
      meaning: '知识',
      priority: false,
    };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = vi.fn(() => pending);
    const close = vi.fn();
    render(
      <FeedbackProvider>
        <CommonWordsDialog entries={[entry]} existing={[]} onClose={close} onSave={save} />
      </FeedbackProvider>,
    );
    const submit = screen.getByRole('button', { name: '确认保存' });
    fireEvent.click(submit);
    expect(screen.getByLabelText('英文 / 短语')).toBeDisabled();
    expect(screen.getByLabelText('教学释义')).toBeDisabled();
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(save).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
