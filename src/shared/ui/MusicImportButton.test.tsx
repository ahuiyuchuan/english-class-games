// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
/** Import UI lifecycle; real codec acceptance is covered by native media tests. @author ahui */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MusicImportButton } from './MusicImportButton';
import { Modal } from './index';
import { cancelActiveMusicImport, setMusicImportsClosing } from '../../platform/music-import';
const api = vi.hoisted(() => ({
  selectFile: vi.fn(),
  inspectMusic: vi.fn(),
  prepareMusic: vi.fn(),
  commitMusic: vi.fn(),
  cancelMusic: vi.fn(),
}));
vi.mock('../../platform/native', () => api);
beforeEach(() => {
  vi.resetAllMocks();
  api.selectFile.mockResolvedValue({ token: 'selected', name: '中文 & 测试.mp4' });
  api.inspectMusic.mockResolvedValue({
    video: true,
    selectedTrack: null,
    tracks: [
      { id: 0, codec: 'AAC-LC', language: 'eng', default: true, supported: true },
      { id: 1, codec: 'AAC-LC', language: 'zho', default: true, supported: true },
    ],
  });
  api.prepareMusic.mockResolvedValue(undefined);
  api.commitMusic.mockResolvedValue({ assetId: 'music' });
  api.cancelMusic.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await cancelActiveMusicImport();
});
async function open(onImported = vi.fn()) {
  const view = render(<MusicImportButton label="导入背景音乐" onImported={onImported} />);
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  await screen.findByText('等待确认');
  return { ...view, onImported };
}
it('多轨不猜测，明确选轨后只提交一次', async () => {
  const { onImported } = await open();
  const confirm = screen.getByRole('button', { name: '提取并导入' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('选择音轨'), { target: { value: '1' } });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(api.prepareMusic).toHaveBeenCalledWith('selected', expect.any(String), 1);
  expect(api.commitMusic).toHaveBeenCalledTimes(1);
});
it('等待选轨时关闭窗口能够取消并完成清理', async () => {
  const { onImported } = await open();
  await act(async () => cancelActiveMusicImport());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(onImported).not.toHaveBeenCalled();
  expect(api.prepareMusic).not.toHaveBeenCalled();
});
it('处理中取消后迟到结果不能入库，也不能重复启动', async () => {
  let finish!: () => void;
  api.prepareMusic.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { onImported } = await open();
  fireEvent.change(screen.getByLabelText('选择音轨'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '提取并导入' }));
  await waitFor(() => expect(api.prepareMusic).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '取消导入' }));
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.commitMusic).not.toHaveBeenCalled();
  expect(onImported).not.toHaveBeenCalled();
});
it('失败明确反馈、关闭后可重新选择', async () => {
  api.inspectMusic.mockRejectedValueOnce(new Error('视频没有音轨'));
  render(<MusicImportButton label="导入背景音乐" onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  await screen.findByText('视频没有音轨');
  fireEvent.click(screen.getByRole('button', { name: /^关闭$/ }));
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  await screen.findByText('等待确认');
  expect(api.selectFile).toHaveBeenCalledTimes(2);
});
it('入库失败仍清理临时结果', async () => {
  api.commitMusic.mockRejectedValue(new Error('资料已恢复'));
  const { onImported } = await open();
  fireEvent.change(screen.getByLabelText('选择音轨'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '提取并导入' }));
  await screen.findByText('资料已恢复');
  await waitFor(() => expect(api.cancelMusic).toHaveBeenCalled());
  expect(onImported).not.toHaveBeenCalled();
});

it('关窗保存保护期间拒绝新导入，取消关窗后恢复', async () => {
  render(<MusicImportButton label="导入背景音乐" onImported={vi.fn()} />);
  setMusicImportsClosing(true);
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  expect(api.selectFile).not.toHaveBeenCalled();
  setMusicImportsClosing(false);
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  await screen.findByText('等待确认');
});

it('取消反馈始终留在入口容器内，不插入标题栏第三个布局项', async () => {
  api.selectFile.mockResolvedValue(null);
  const { container } = render(
    <div className="row spread">
      <h2>本地声音素材</h2>
      <MusicImportButton label="导入背景音乐" onImported={vi.fn()} />
    </div>,
  );
  const toolbar = container.firstElementChild!;
  expect(toolbar.children).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '导入背景音乐' }));
  await screen.findByText('已取消，未添加音乐。');
  expect(toolbar.children).toHaveLength(2);
  expect(screen.getByRole('status').parentElement).toBe(
    screen.getByRole('button', { name: '导入背景音乐' }).parentElement,
  );
});

it('嵌套音乐选轨位于宿主设置之上，取消仅关闭选轨并归还导入入口', async () => {
  render(
    <Modal open onOpenChange={() => {}} title="声音设置">
      <MusicImportButton label="导入背景音乐" onImported={vi.fn()} />
    </Modal>,
  );
  const parent = screen.getByRole('dialog', { name: '声音设置' });
  const opener = screen.getByRole('button', { name: '导入背景音乐' });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByText('等待确认');
  const tracks = screen.getByRole('dialog', { name: '导入背景音乐' });
  expect(Number(tracks.style.zIndex)).toBeGreaterThan(Number(parent.style.zIndex));
  expect(screen.getByRole('button', { name: '提取并导入' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '取消导入' }));
  await waitFor(() => expect(tracks).not.toBeInTheDocument());
  await waitFor(() => expect(opener).toHaveFocus());
  expect(parent).toBeInTheDocument();
  expect(api.prepareMusic).not.toHaveBeenCalled();
});
