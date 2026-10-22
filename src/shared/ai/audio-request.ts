/** 声音需求的公共身份，不引用桌面API或任何游戏规则。 @author ahui */
import type { AudioRequest } from '../../platform/types';

/** 只规范空白，保留大小写、语言、音色和语速，避免不同读音误用同一声音。 */
export function audioRequestKey(request: AudioRequest): string {
  return JSON.stringify([
    request.text.trim().replace(/\s+/gu, ' '),
    request.language,
    request.voiceId,
    request.rate,
  ]);
}
