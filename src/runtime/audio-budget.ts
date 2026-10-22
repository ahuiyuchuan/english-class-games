/**
 * 声音准备与播放共用的解码缓存限制。按设计中的十进制 MB 计为 64,000,000
 * 字节，避免使用 MiB 放宽边界；背景音乐经媒体元素按需读取，不占此缓存。
 * @author ahui
 */
export const DECODED_AUDIO_BUDGET = 64_000_000;
