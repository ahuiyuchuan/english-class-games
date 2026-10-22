# 配音组合源码与构建

维护者：ahui。项目适配器SPDX为GPL-3.0-only；上游源文件按各自原许可，不修改其声明。完整目录在同版本Source.zip附件的resources/tts/licenses中提供，无需账号；安装器只保留原许可和获取说明，避免把构建源码重复安装。离线转交时同时携带源码ZIP。

## 实际版本与归档

- sherpa-onnx 1.13.8 Windows x64 shared MT Release；原始源码及CMake构建文件见本目录的sherpa源码归档。
- ONNX Runtime 1.28.2 CPU，commit `33ca9628233dc8f002435e868d4c2e9f82766ca1`。`sources/onnxruntime-1.28.2.zip`保留根元数据／许可、onnxruntime（除test数据）、include、cmake、tools的原始字节，用于CPU推理；不包含可选training和其他语言绑定。
- `sources/source-lock.json`记录原始归档URL、大小、SHA256及筛选规则。ONNX依赖`ort-*.zip`的版本和SHA1来自上述commit的cmake/deps.txt，下载时逐一比对，再记录SHA256。原始上游许可仍在各归档中。
- `worker/tts-worker.cpp`及`worker/build-tts-worker.ps1`是本项目适配器的可修改源码和实际构建脚本；模型与DLL摘要见上一级manifest.json。Melo模型是独立MIT资源，不是GPL代码。

先解压所需上游归档。不同归档保留原根目录，不能把ZIP本身当作已经安装的SDK。使用CMake、Python、Visual Studio C++／Windows SDK（或已配置的兼容LLVM工具链）。这些通用工具不随源码打包。

## 上游库

ONNX Runtime原始构建入口为tools/ci_build/build.py，Windows入口build.bat。CPU共享库的基本构建控制为：

```powershell
.\build.bat --config Release --build_shared_lib --parallel --skip_tests --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF
```

不要添加CUDA、DirectML、训练或其他未随该CPU分发启用的执行提供器。cmake/deps.txt保留全部上游依赖地址与校验；需要离线构建时，将本目录已提供的对应归档路径作为该副本deps.txt中的URL值（保留SHA1），或使用上游CMake支持的FETCHCONTENT_SOURCE_DIR变量指向已解压源码。不要修改本交付中的原始归档。可选依赖不等于本产品启用了该功能。系统工具或可选提供器仍可能需要额外安装。

sherpa源码根CMakeLists.txt定义实际选项；Windows x64 Release构建共享C API时，启用TTS与所需piper-phonemize，禁用测试和不使用的语言绑定，按其cmake/onnxruntime.cmake指定已构建ONNX头文件、库与DLL路径。源归档中的原始构建脚本、依赖版本和许可证是修改依据；本文件不宣称不同编译器输出可逐字节复现官方二进制。

## 自有适配器

准备包含include、lib、bin的sherpa SDK目录后，在项目根目录执行：

```powershell
pwsh -File scripts/build-tts-worker.ps1 -SherpaRoot <SDK目录> -ProjectRoot <项目源码根目录>
node scripts/verify-speech-resources.mjs --write
```

重新生成manifest属于维护操作，只能在核对版本、许可与实际功能后执行。正常构建只验证摘要，不静默接受变化。更新运行库后必须重新核验语音生成、取消和资源释放，并重新生成资源归档与对应源码，不能用旧收据冒充新版本。

## 验证边界

本轮实际重编译了自有适配器，并用随附DLL和真实模型执行原生发音／取消测试。上游sherpa、eSpeak及ONNX Runtime的完整从零重编译未在本轮完成；源码和构建控制已提供，但不将该步骤标记为通过。当前完整命令与结果以交付验收记录为准。
