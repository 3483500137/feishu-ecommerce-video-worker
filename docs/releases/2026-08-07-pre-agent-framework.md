# Pre-Agent Framework Baseline — 2026-08-07

## Purpose

This tag preserves the complete Feishu e-commerce video workflow immediately before the generic workflow runtime and Feishu bot agent work begins.

## Included capabilities

- Feishu Base-driven persona, prompt, video-generation, LTX reconstruction, hot-topic, account, and publishing workflows.
- Configurable model routing with locally protected DPAPI credentials.
- Local media relay, MultiPost browser bridge, Douyin/Kuaishou account support, and safe retry behavior.
- Voicebox narration sources, scripts, subtitle/timeline sources, validation frames, QA output, and demonstration videos.

## Validation

`npm test` passed with 231 tests on 2026-08-07.

## Media versioning

Approximately 0.6 GiB of media is preserved with Git LFS: demonstration MP4 files, narration WAV files, frame JPG files, and document QA PDF/PNG artifacts. Scripts, text, subtitle, and timeline files remain normal Git files.

## Known boundary

This baseline is the existing vertical e-commerce video system. It does not yet include the generic workflow runtime, declarative workflow packages, Feishu bot gateway, member authorization, workflow discovery package, or a knowledge-provider abstraction. Those changes start from the next implementation branch.
