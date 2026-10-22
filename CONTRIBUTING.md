# 开发与构建

作者：ahui。自有代码GPL-3.0-only。先更新受影响文档再修改代码，保持UTF-8无BOM、LF和现有组件。项目为React、TypeScript、Tauri／Rust，不采用Java／MyBatis专属框架规则。

## 从随附源码构建

使用PowerShell7，按mise.toml安装Node24.18.1、pnpm11.18.0、Python3.13.14和Rust1.99.1。桌面还需Windows C++工具链／SDK；本机可用便携LLVM时，设置ECG_LLVM_ROOT、ECG_WINDOWS_SYSROOT并点源src-tauri/scripts/native-env.ps1。通用编译器、包管理器和系统库不随源码ZIP提供。

解压源码ZIP，进入目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build:portable
pnpm build
pnpm dev
```

portable-source.zip包含播放器原始TS／TSX／CSS、项目构建配置、锁文件及第三方可修改源码；third-party下有未修改发行源码及从上游原始source内容保留的独立源文件，React、Phosphor、Floating UI等另带实际编译所需上游源码，SoundTouch保留原始源码。上游可选演示与测试截图不属于对应代码的构建输入，未一并复制。构建按锁文件取得工具依赖，网络只用于安装构建依赖，课堂运行不需要网络。源码包不是node_modules缓存，不承诺开发依赖首次安装全离线。

完整桌面源码附件Source.zip还包含Rust依赖源码及配音组件源码／构建说明。安装器只收录运行资源及许可，通过scripts/prepare-desktop-distribution.mjs从已校验资源生成暂存，排除开发源码和重复ZIP；不改写原始开发资源。完整桌面打包需配音模型／运行库等独立资源，它们不属于自有代码许可。使用同一交付中的归档：

```powershell
pnpm resources:prepare -- --archive <Desktop-Resources.tar.gz的本地完整路径>
pnpm build
pnpm notices:native
cargo build --manifest-path src-tauri/Cargo.toml --locked
pnpm tauri build
```

公开版内置音乐由scripts/build-builtin-music.mjs确定性合成，CC0-1.0；pnpm build和CI自动重建并核验元数据。对应源码包含生成脚本、参数与许可，无需从私人安装目录取得音乐。教师导入素材不进入源码包。

恢复先核对归档SHA256、受限路径和每个文件摘要，已有不同文件拒绝覆盖。不自动连接任何远端，不下载占位模型。可修改配音worker按scripts/build-tts-worker.ps1及资源目录的原始构建说明进行，模型和第三方代码各保留许可。

直接Cargo构建前必须先生成前端、对应源码和许可资源；Tauri的beforeBuildCommand已自动按此顺序执行，首次构建不能依赖旧生成文件。桌面开发的beforeDevCommand同样先准备源码；普通pnpm dev仅预览前端。

## 检查与生成

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test --maxWorkers=1
pnpm exec playwright test --workers=1
pnpm exec playwright test --config playwright.portable.config.ts --workers=1
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
pnpm tauri build
```

源码包和许可由scripts/build-source.mjs生成。构建会刷新源码包，不能手改生成文件。Git检出的源码还需按resources/source-upstream/sources.json下载并验证上游源码归档，执行node scripts/prepare-source-inputs.mjs；SheetJS归档因上游下载不稳定随仓库固定摘要提供，不依赖挑战页。随附完整对应源码ZIP已有third-party/upstream，无需重复下载。配音资源从同版Release的Desktop-Resources.tar.gz下载后按上述本地归档命令恢复。CI在正式Release发布、PR或手动触发后按固定Release获取资源、核验摘要并执行检查，不自动发布；首次空仓库推送不触发依赖尚未发布附件的检查。贡献须确认有权按GPL-3.0-only授权，不转授权第三方代码或教师素材。具体范围与既有MIT权利见docs/22-许可证与对应源码.md。
