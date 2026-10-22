# 1.0.0 发布验收

作者：ahui。产品1.0.0，自有代码GPL-3.0-only。首发单词节拍三模式，主要验收1920×1080。本轮仅调整安装资源与源码交付及对应入口，没有改变教学规则、数据协议或教师资料库。

## 本轮结果

安装器由966,420,507字节（921.65MiB）缩小至412,132,280字节（393.04MiB），减少554,288,227字节（528.61MiB），约57.35%。最终SHA256为`dbacb0ca252d61385c0cbf4ae3a65855301239a58f9082d1152b2d8282c0103b`。

根因是完整桌面源码ZIP、其中已有的配音构建源码、播放器源码ZIP被重复收录。安装器改从逐文件校验的运行暂存打包，保留模型、DLL、词表、原许可及WebView2离线安装器；排除245,030,164字节配音构建源码，不删除原始开发文件。完整桌面源码作为同版本Source.zip独立附件，按GPLv3 6(d)在同一发行页同等提供；物理介质按6(a)同时携带源码。程序内只保留一份播放器源码，用于断网导出；每个HTML仍内嵌自己的源码。

关于页保留四个GitHub入口，新增精确本版本完整源码下载；桌面本地入口改为版本／地址／摘要说明。完整桌面源码下载需要网络、无需账号，安装、配音、导出和课堂仍离线可用。公开版内置自制100 BPM节奏音CC0-1.0，原视频音乐不进入公开产物。

## 实际执行

使用PowerShell7、明确UTF-8，Node24.18.1／pnpm11.18.0／Python3.13.14／Rust1.99.1，原生环境为src-tauri/scripts/native-env.ps1。本轮证据位于validation/installer-size-20261023，交付evidence保留日志、截图和收据。

| 命令／流程 | 实际结果与边界 |
| --- | --- |
| pnpm format:check、pnpm lint、pnpm exec tsc --noEmit、git diff --check | 通过，保持UTF-8无BOM、LF |
| node --test scripts/prepare-desktop-distribution.test.mjs | 4项通过：运行文件保留、开发源码排除、精确版本／摘要和异常中止保护 |
| pnpm test --maxWorkers=1 | 最终49文件674项全部通过；第一次并行构建期间有一项初始化10秒超时，随后减少并行负载完整重跑通过，未放宽超时或修改业务断言 |
| cargo fmt、cargo clippy --locked --all-targets -- -D warnings | 通过 |
| cargo test --manifest-path src-tauri/Cargo.toml --locked | 78通过、2忽略，包含真实配音、三模式和变速包往返、源码收据和固定链接校验；忽略项需要完整媒体夹具或可用英文WinRT音色 |
| pnpm exec playwright test tests/e2e/brand-about-tab.spec.ts --workers=1 | 4项通过，实际浏览器验证1920与720布局、键盘、离线播放器源码下载、手动更新、固定完整源码附件及离页取消；网络响应为受控测试，不冒充GitHub正式附件下载 |
| pnpm exec playwright test --config playwright.portable.config.ts --workers=1 | 24项全部通过；无开发服务器、file://和浏览器断网，含三模式源码下载、完整播放、设置与损坏数据处理 |
| pnpm exec playwright test --config playwright.portable.config.ts --workers=1 -g '三模式实际导出保留许可' | 最终附件名规范化后，重新生成三模式示例并额外复测1项通过；只改文档下载地址，课堂实现与此前24项完整回归一致 |
| pnpm build、pnpm notices:native、pnpm tauri build | 通过；实际生成新播放器、完整源码、精简运行资源和Windows安装器 |
| node scripts/build-examples.mjs、node scripts/build-tempo-example.mjs | 四套当前离线HTML及对应可编辑包重新生成，使用自制节奏音和本轮源码 |
| 7-Zip测试／解包、node validation/installer-size-20261023/verify-installer.mjs | 通过；96个安装资源、5个实际EXE内嵌前端资源读回一致；源码获取收据匹配完整ZIP，安装目录不含桌面／播放器源码ZIP，EXE只保留一个播放器源码资源 |
| 实际解包配音组件 | 使用包内worker／DLL／模型，清空外部工具PATH，实际生成英语2.659秒、中文1.997秒单声道44.1kHz WAV；不依赖被移除的构建源码，不等同物理听觉或干净系统安装测试 |
| 实际包内WebView2 | 214,823,632字节，与精简前逐字节一致；Microsoft签名Valid。自有安装器未签名，两者不混淆 |
| 对应源码逐文件读回 | portable 10,303项、desktop 23,702项逐项摘要一致，ZIP路径唯一，第三方源码与许可保持原字节 |
| 从本轮源码独立复建 | 在D:/temp/ecg-size-source-final-20261023执行pnpm install --offline --frozen-lockfile和pnpm build通过；重建源码ZIP摘要与交付完全一致，使用本机依赖缓存，不宣称首次新机开发构建无需联网 |
| 远端Tag、正式Release与服务端附件摘要 | 按github-release-publish技能核验；最终公开状态、Tag指向与5项附件服务端digest见交付evidence/release-receipt.json，不把本地构建或草稿当作已公开发行 |

精简前完整应用浏览器基线为66通过、1自然播放超时，后者隔离复测通过。本轮实际重跑的是受影响关于页4项和离线24项，不把基线全量结果冒充本轮全页面重跑。旧成果指纹、教学设置和课堂时钟未修改，相关单元及原生往返仍纳入本轮检查。

## 限制

- 未在干净Windows10／11设备实测完整安装、升级、卸载与旧安装目录的空间回收；不自动递归清理用户目录。新安装器体积和包内文件已实际核验。
- 实际桌面关于页操作未执行：先前自动审批拒绝启动解包应用并开启调试端口，返回blocked by policy；未绕过，采用真实浏览器、原生白名单／收据及实际EXE字节验证，不冒充桌面界面操作通过。
- 上游sherpa／eSpeak／ONNX Runtime完整C++从零重编译未完成，完整对应源码和控制脚本已提供。
- 未重新测量物理音画输出延迟或完整听觉音质；没有修改音乐处理、教学时钟、动效或粒子实现，不以本轮包体优化声称上述指标提升。
- 构建保留第三方use-client／PURE注释、较大chunk及本机Microsoft调试PDB缺失警告，未调高阈值隐藏。

自有GPL、第三方和教师素材边界见docs/22-许可证与对应源码.md；此前合法授予的MIT权利不追溯撤销。安装器、源码、HTML、可编辑包及开发资源的最终大小／SHA256以最新交付manifest.json和SHA256SUMS.txt为准；远端发布完成后另核对Tag与服务端digest。只保留最新交付，不用旧摘要代替新产物。

发布格式复核：Tag注释仅为产品名与版本；Release按简介、重点功能、快速开始、下载说明、数据说明、项目信息、界面预览组织。CI为独立代码检查，不是发布技能要求的步骤或门槛。最终文档更新后重新构建源码、播放器、离线示例和安装器，再核对包内字节及摘要；本次不改变课堂逻辑。
