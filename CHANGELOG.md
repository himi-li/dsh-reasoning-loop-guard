# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-07

### Added

- **Web GUI 日志卡片** (`lib/client.js`)。插件页上以包名为键注册 `plugins.bundle.config` 槽位，详情页因此出现一个「触发日志」面板：最近的触发记录、按判据/按模型的汇总、一键清空，以及日志路径的复制按钮。零构建——手写的惰性 CJS bundle，运行时只向平台种子表要 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`。
- **日志面板可折叠，且一次最多取 100 条**。一条记录默认只显示表头（时间 / 判据 / 度量 / 位置 / 模型），详情（来源、阈值快照、重复片段原文）收在折叠里；**最新一条默认展开**（要解释的通常就是它），工具栏另有「全部展开 / 全部收起」。整页一次只取最新 100 条并在工具栏注明是否被截断——旧版取 50 条且全部展开，记录一多就没法看。
- **宿主侧日志路由** (`lib/log-route.js`)。`GET /reasoning-loop-guard/log` 返回 `{ path, enabled, version, stats, total, matched, entries }`，支持 `limit` / `rule` / `sessionId` / `since` 查询；`POST` 只接受 `{"action":"clear"}`。路由自带**同源回环栅栏**：非回环 `Host`、`Sec-Fetch-Site: cross-site`、或跨源 `Origin` 一律 403——宿主 webServer 本身不提供鉴权，这道栅栏必须由插件自己写。
- **插件元数据**：`icon`（`assets/icon.svg`，即 README 里那枚靶心的无背景版本）与 `locale/en.json` + `locale/zh.json`，因此插件页显示中文标题「推理循环守卫」与中文描述。
- **第三套单元测试** `test/test-card.mjs`：同源栅栏的 15 条判定、路由的方法/查询/上限/关闭态行为、注册走服务，以及客户端 bundle 的协议形态、卡片纯函数与折叠行为。
- **新判据 `filler-run`（兜底）** —— 原始文本末尾连续 ≥ `fillerRun`（默认 400）个装饰字符（空白 / 标点 / 符号）即判定为卡死。归一化把装饰从计数判据里剥掉之后，一个**只**输出装饰的流本来可以无限跑下去；这条判据专门堵这个洞，并刻意做得很迟钝：它**锚定在文本末尾**（模型画完图接着写散文就不再计数），且门槛远高于任何合法排版（实测最宽合法形状 151 字符，见下）。
- **触发记录更详细**：新增 `ttftMs`（首 token 延迟）、`aborted`（调用方是否已中止）、`thresholds`（触发时生效的 14 项阈值快照）、`previewRaw`（未截断的原文尾巴）、`turn` / `step` / `attemptId` / `cwd` / `reasoningChars` / `elapsedMs` / `fromStartMs`，以及 `line-repeat` 的 `share`。卡片与 `reasoning_loop_log` 工具都会渲染这些字段。

### Fixed

- **`line-repeat` 会把「边写代码边推理」当成循环。** 旧判据是「同一归一化行出现 ≥ 2 次且行长 ≥ 10」，于是写 changelog 时写了两遍 `## Unreleased`、重构时同一个标识符落在两行，都会中断用户的流——真实使用中一下午报出两条。修法有数据支撑：在**本机 2799 条真实推理流**（1,920 万字符，从会话存储里解出来的，含 11 个已知真循环）上，旧默认触发 **180 次**，其中 `line-repeat` 177 次、`block-repeat` 3 次。
  - 判据改为 **count 与 share 双条件**：`lineCount: 2 → 3`，新增 `lineShare: 0.1`（重复行占归一化窗口的比例）。分离度是实测的——健康流里最常见的口头禅（`Let me write.`）最高只到 **6.1%**，而最弱的真循环是 **10.2%**；`share` 取 8% 会放进 2 条误报，取 12% 会漏掉真循环。
  - **count 单独不够**：一个 41 字符的长标识符只出现 **2 次**就能把 share 顶到 19.5%，所以 count 不能退回 2。取 3 与取 4 在语料上完全等价，取 3 留出余量。
  - `block-repeat` 只需把 `blockCount: 3 → 4`：3 会在健康推理**引用长文本**时触发（十六进制 dump、插件名清单、系统提示词复述），4 在语料上只剩 3 次触发且全为真循环。这里刻意**不加** share 地板——从 0% 到 25% 结果都一样，加了只是没有数据支撑的复杂度。
  - 两条规则顺带修掉一个**语义缺陷**：它们原来在第一个达标的单元上就 `return`，所以记录的 `count` 永远等于阈值本身，从未反映真实重复次数。现在都改为全扫描取最大重复单元，`count` 因此是真实值（日志里 `count=2` 那种"刚够线"的数字不会再出现）。
- **装饰性字符被误判为推理循环。** 清洗类 `STRIP` 原是一份手写字符表，**漏掉了下划线**：模型画一条 `________` 分隔线时，它归一化后仍是 8 个相同字符，于是 `periodic-run` 以 `period=8 · units=6` 命中，护栏真的中断了那次流，日志里留下一条 8 个下划线的记录（另有一条 8 空格的记录来自更早的 0.1.0，当时还没有归一化）。现在清洗类改为 `[\s\p{P}\p{S}]`——`_` 属 `\p{Pc}`、`─`/`▁` 属 `\p{So}`，旧表都漏了。它是旧表的**严格超集**，且在全部 11 个真实退化样本上新旧两类产出的文本**逐字节相同**，即加宽只删掉了装饰，没有削弱任何一次真实检出。
- **`reasoning_loop_log` 的输出 schema 会让插件整个 `apply()` 失败。** DSH 的 JSON-schema 校验器不支持在带 `type` 的属性上挂 `required`（`JsonSchemaError: unsupported JSON schema: schema.properties.action.required is not supported on type "string"`），而工具的 `output.schema` 是在注册时校验的，于是异常直接打断了 `apply()`——**连带该函数后面二十行的日志路由也一起没注册上**。现在 schema 收敛到校验器真正支持的子集，且 `tools` 与 `webServer` 两处 `ctx.inject` 各自包了 try/catch，互不牵连。

### Notes

- **夹具定标有盲区，这次是真实语料兜住的。** 0.1.0 的 177 样本定标集（11 正 / 166 负）来自**单个失败会话的散文**，报告 0/166 误报，却漏掉了「边写代码边推理」这一整个失败形态——在那个形态上它给出的 0/166 毫无意义。上面所有阈值因此都改由 2799 条真实语料 + 11 个已知真循环共同决定。定标脚本与语料**不随包发布**（语料含真实会话内容）。
- 合法排版的尾部装饰实测天花板：150 列 ASCII 框 151 字符、20 列 markdown 表行 142、setext 下划线 62、`---` 分隔线 5。`fillerRun` 默认 400 是其 2.6 倍。
- **补丁/代码改动在 `node_modules` 内不会热重载**：`dsh-hmr` 默认忽略 `**/node_modules`，且 `PluginManager.reload()` 在没有 hmr 服务时静默不重载；此外 Node 会**在进程内永久缓存**每个包的 `exports` 映射，所以给 manifest 新增 export（例如 `./locale/*.json`）必须**重启 DSH Desktop**，刷新页面不够。README 的安装段已改正。

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
