/**
 * 所有独立课堂成品共用的离线来源与许可正文。
 * 内容随构建固定，运行时不读取网络或用户电脑的其他文件。
 * @author ahui
 */
import attribution from '../../resources/ATTRIBUTION.txt?raw';
import dictionaryLicense from '../../resources/dictionary/LICENSE-ECDICT.txt?raw';
import sloganLicense from '../../resources/LICENSE-SLOGAN-TEMPLATES.txt?raw';
import dependencyNotices from '../../resources/THIRD-PARTY-NOTICES.txt?raw';
import projectLicense from '../../LICENSE?raw';
import copyright from '../../COPYRIGHT?raw';
import musicLicense from '../../resources/music/LICENSE-CC0.txt?raw';
import musicSource from '../../resources/music/README.txt?raw';

/** 完整保留数据、模板及生产依赖许可，导出时由 HTML 文本编码防止结束标记逃逸。 */
export const THIRD_PARTY_ATTRIBUTION = [
  attribution,
  dictionaryLicense,
  sloganLicense,
  dependencyNotices,
  musicSource,
  musicLicense,
].join('\n\n');

/** 自有许可与第三方原许可随每次导出一起保留。 */
export const CLASSROOM_ATTRIBUTION = [copyright, projectLicense, THIRD_PARTY_ATTRIBUTION].join(
  '\n\n',
);
