// @vitest-environment jsdom
/** 验证进度口径及取消边界，状态夹具不代替原生声音制作验收。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { TaskRecord } from '../../platform/native';
import { TaskProgress } from './TaskProgress';

afterEach(cleanup);
const task: TaskRecord = {
  taskId: 'progress',
  kind: 'speech',
  stage: '声音制作',
  state: 'running',
  completed: 5,
  total: 8,
  results: [],
  failures: [],
  cancelRequested: false,
  createdAt: '',
  updatedAt: '',
};

it('失败计入已处理但不计成功，取消不填满进度', () => {
  render(
    <TaskProgress
      task={{
        ...task,
        state: 'cancelled',
        failures: [
          {
            requestId: 'bad',
            objectId: 'word',
            error: { code: 'FAILED', message: '测试错误', retryable: true },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '6');
  expect(screen.getByText('成功 5 项')).toBeInTheDocument();
  expect(screen.getByText('失败 1 项')).toBeInTheDocument();
  expect(screen.getByText('未处理 2 项')).toBeInTheDocument();
  expect(screen.getByText('制作已取消')).toBeInTheDocument();
});

it('未知总量不显示虚假百分比，取消请求立即停止工作动效', () => {
  const { container } = render(
    <TaskProgress task={{ ...task, total: 0, completed: 0, cancelRequested: true }} />,
  );
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  expect(container.firstChild).toHaveAttribute('data-active', 'false');
  expect(screen.getByText('正在取消，请稍候')).toBeInTheDocument();
});
