/**
 * Bounded offline speech worker. UTF-16 file arguments and UTF-8 input files avoid
 * the upstream CLI's Windows ANSI argv conversion; teaching text is never logged.
 * The parent launches one worker per item and owns timeout/cancellation. A process
 * handle watchdog also exits if the parent crashes, so no orphan inference remains.
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 ahui. Upstream sherpa/eSpeak licenses remain unchanged.
 * @author ahui
 */
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include "sherpa-onnx/c-api/c-api.h"

/** Little-endian PCM fields; Windows x64 is the only distributed worker target. */
template <typename T> void field(std::ofstream &out, T value) {
  out.write(reinterpret_cast<const char *>(&value), sizeof(value));
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 5) return 2;
  const float speed = static_cast<float>(_wtof(argv[3]));
  if (!std::isfinite(speed) || speed < .75f || speed > 1.25f) return 2;
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, wcstoul(argv[4], nullptr, 10));
  if (!parent) return 3;
  std::thread([parent] {
    WaitForSingleObject(parent, INFINITE);
    CloseHandle(parent);
    ExitProcess(3);
  }).detach();
  try {
    std::ifstream input{std::filesystem::path(argv[1]), std::ios::binary};
    if (!input) return 4;
    std::string text{std::istreambuf_iterator<char>(input), {}};
    if (text.empty() || text.size() > 800 || text.find('\0') != std::string::npos) return 4;
    SherpaOnnxOfflineTtsConfig config{};
    // Relative, fixed model paths also work when the installation path is Chinese.
    // The parent sets cwd to the verified installation resource directory.
    config.model.vits.model = "model/model.onnx";
    config.model.vits.tokens = "model/tokens.txt";
    config.model.vits.lexicon = "model/lexicon.txt";
    config.model.vits.noise_scale = .667f;
    config.model.vits.noise_scale_w = .8f;
    config.model.vits.length_scale = 1;
    config.model.num_threads = 2;
    config.model.provider = "cpu";
    config.max_num_sentences = 1;
    config.silence_scale = 1;
    const auto *tts = SherpaOnnxCreateOfflineTts(&config);
    if (!tts) return 5;
    SherpaOnnxGenerationConfig generation{};
    generation.sid = 0;
    generation.speed = speed;
    generation.silence_scale = 1;
    const auto *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
        tts, text.c_str(), &generation, nullptr, nullptr);
    int result = 6;
    if (audio && audio->n > 0 && audio->sample_rate > 0 &&
        audio->n <= audio->sample_rate * 30) {
      std::ofstream out{std::filesystem::path(argv[2]), std::ios::binary};
      const uint32_t bytes = static_cast<uint32_t>(audio->n) * 2;
      out.write("RIFF", 4); field(out, bytes + 36); out.write("WAVEfmt ", 8);
      field(out, uint32_t{16}); field(out, uint16_t{1}); field(out, uint16_t{1});
      field(out, uint32_t(audio->sample_rate)); field(out, uint32_t(audio->sample_rate * 2));
      field(out, uint16_t{2}); field(out, uint16_t{16}); out.write("data", 4); field(out, bytes);
      bool complete = true;
      for (int i = 0; i < audio->n; ++i) {
        // A non-finite sample makes the complete item invalid, never a successful
        // truncated WAV. The parent removes the rejected temporary output.
        if (!std::isfinite(audio->samples[i])) { complete = false; break; }
        field(out, static_cast<int16_t>(std::clamp(audio->samples[i], -1.f, 1.f) * 32767));
      }
      out.flush();
      result = complete && out ? 0 : 7;
    }
    if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    SherpaOnnxDestroyOfflineTts(tts);
    return result;
  } catch (...) {
    // No exception details/teaching text escape into app logs; parent reports an
    // actionable failure and validates/deletes any incomplete output file.
    return 8;
  }
}
