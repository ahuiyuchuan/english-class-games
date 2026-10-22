/** 备课应用入口。离线课堂使用同一游戏运行组件，但不加载数据库或桌面服务。 @author ahui */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedbackProvider } from '../shared/ui';
import { App } from './App';
import '../shared/styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const root = document.getElementById('root');
if (!root) throw new Error('应用入口缺失。');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>
        <App />
      </FeedbackProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
