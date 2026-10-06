# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Web GUI 日志卡片** (`lib/client.js`)。插件页上以包名为键注册 `plugins.bundle.config` 槽位，详情页因此出现一个「触发日志」面板：最近的触发记录、按判据/按模型的汇总、一键清空，以及日志路径的复制按钮。零构建——手写的惰性 CJS bundle，运行时只向平台种子表要 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`。
- **宿主侧日志路由** (`lib/log-route.js`)。`GET /reasoning-loop-guard/log` 返回 `{ path, enabled, version, stats, total, matched, entries }`，支持 `limit` / `rule` / `sessionId` / `since` 查询；`POST` 只接受 `{"action":"clear"}`。路由自带**同源回环栅栏**：非回环 `Host`、`Sec-Fetch-Site: cross-site`、或跨源 `Origin` 一律 403——宿主 webServer 本身不提供鉴权，这道栅栏必须由插件自己写。
- **插件元数据**：`icon`（`assets/icon.svg`，即 README 里那枚靶心的无背景版本）与 `locale/en.json` + `locale/zh.json`，因此插件页显示中文标题「推理循环守卫」与中文描述。
- **第三套单元测试** `test/test-card.mjs`：同源栅栏的 15 条判定、路由的方法/查询/上限/关闭态行为、注册走服务，以及客户端 bundle 的协议形态与卡片纯函数。

### Fixed

- **`reasoning_loop_log` 的输出 schema 会让插件整个 `apply()` 失败。** DSH 的 JSON-schema 校验器不支持在带 `type` 的属性上挂 `required`（`JsonSchemaError: unsupported JSON schema: schema.properties.action.required is not supported on type "string"`），而工具的 `output.schema` 是在注册时校验的，于是异常直接打断了 `apply()`——**连带该函数后面二十行的日志路由也一起没注册上**。现在 schema 收敛到校验器真正支持的子集。

## [0.1.0] - 2026-10-06

Initial release.

### Added

- **Reasoning-loop detection** on the `llm/stream` waterfall. Two rules, evaluated every 200 characters over rolling buffers:
  - `periodic-run` (primary) — the tail holds ≥ 4 consecutive identical units with a period in [8, 400].
  - `kgram-repeat` (secondary) — the last 64 characters occur ≥ 12 times in the window.
- **Early stream termination.** On a verdict the guard stops pulling from upstream and emits a terminating `finish` chunk with `code: REASONING_LOOP`, so the step fails visibly instead of idling.
- **Fire journal.** Every fire is appended as one JSON line to `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl`, size-bounded and rotated to `.1`. Journal failures only warn — they never disturb the stream.
- **`reasoning_loop_log` maintenance tool** with `list` / `stats` / `path` / `clear` actions, registered through an optional `ctx.inject(["tools"], …)` so a host without the tools service still gets the guard itself.
- **Config validation** that rejects settings which would silently fail to work (`kgram > window`, `minPeriod >= maxPeriod`, `periodTail < 2 * maxPeriod`, empty `failureCode`, non-positive `every`).
- **Four test suites** (`test/test-guard.mjs`, `test/test-journal.mjs`, `test/smoke/smoke.mjs`, `test/smoke/real-protocol.mjs`).
- **Deterministic synthetic fixtures** (`test/fixtures/`) reproducing the measured shape of the original failure.

### Notes

- `failureCode` defaults to `REASONING_LOOP`, which is deliberately **not** in the retryable set (`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`). Repetition is a property of the request itself, so an automatic retry would re-send the same prompt and loop again. Set `failureCode: EMPTY_RESPONSE` to opt into retries.
- Calibrated on 177 samples (11 positive / 166 negative) from a single session; 11/11 detections and 0/166 false positives across six feeding granularities.
