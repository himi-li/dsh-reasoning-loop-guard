# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- **安装说明改为区分桌面版与网页版，并改用标准的 `dsh plugin --profile <name> add <包名>` 命令。** 原文只给了一句「在 profile 目录下执行 `npm install github:…`」，既没有说明 DSH 的 profile 隔离，也没有区分两种运行形态。现在 README 两版各给出两个小节：桌面版（`desktop`）与网页版（`web`），命令只差一个名字。桌面版额外写明两个前提——必须用 DSH Desktop 内置的命令运行时（独立安装的 npm 版 `dsh` CLI 会拒绝 `--profile desktop`），且要先启动一次 Desktop 初始化它的 profile、完全退出应用后再执行（内置运行时拒绝未初始化的 Desktop profile，也不会替它创建普通 CLI profile）；`web` 等 profile 则会从随附模板自动初始化。同时补充：这条命令会把包写进 profile 的 `dependencies`，并自动把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`，无需手改 `package.json`；**本包不需要 `allowBuilds` 授权**（从 git 安装的插件通常要跑 `prepare`，pnpm ≥10 默认拒绝，而本包直接分发构建好的纯 JavaScript、`lib/` 已入库、没有 `prepare` 脚本），并给出对应的卸载命令。手写安装与 `cordis.patch.yml` 挂载两节保留，只把引言改成与 `dsh plugin` 并列的「不想用命令时」的说法。

## [0.2.2] - 2026-10-08

### Fixed

- **触发时间不再按 UTC 显示，界面与工具一律渲染本地时间。** 持久化的 `iso` 字段按规范存 UTC（`new Date(now).toISOString()`），而所有人类可读的界面此前都直接把这个 UTC 串打印出来：日志面板的行时间与「时间跨度」统计、`reasoning_loop_log` 工具的 `list` 行与 `stats` 的 `span:` 行。现在新增唯一格式化入口 `localStamp(ms)`（`lib/journal.js` 导出，`lib/client.js` 内联同构实现，因为浏览器端不能 import 宿主），把 epoch 毫秒渲染成本地 `YYYY-MM-DD HH:MM:SS`；`iso` 仍按 UTC 持久化不变。面板行优先用 `at`（原始瞬时值，无需解析），`iso` 仅作旧记录的兜底。**按天汇总同步改为按本地日切分**（`journal.stats().byDay`），否则「按天」表会与它上方显示的行时间互相矛盾。

## [0.2.1] - 2026-10-08

### Added

- **检测核心现在有了 GUI 开关** (`enabled`，默认开)。0.2.0 的功能开关面板能管三条可选臂，却管不到最要紧的那一个：检测本身。`enabled` 是 `EDITABLE_KEYS` 里唯一默认值为 `true` 的键，也是唯一与 patch 同名却不冲突的键——patch 层的 `enabled: false` 仍表示「整插件不注册任何钩子」（只读一次），而设置文件里的 `enabled` 由流监听器**逐请求**读取，所以关掉它**下一次请求就生效**。关掉之后守卫不再观察任何流，三条可选臂也随之失效（它们只可能响应守卫自己抛出的失败）。判定写成「**显式 `false` 才算关**」：缺键表示「按出厂设置」，也就是开着——这样旧的 `config.json` 和既有的测试桩都不会被误读成关闭。
- **日志列表新增整体折叠**（工具栏「收起列表 / 展开列表」）。此前的「全部展开 / 全部收起」只批量控制**每条记录详情**的开合，100 条行头始终铺在页面上；新按钮把整个列表连同行头一起收起，只留下工具栏与统计。两级折叠各管一层，互不覆盖。

### Fixed

- **默认失败码从通用的 `REASONING_LOOP` 改为带命名空间的 `REASONING_LOOP_GUARD`，修掉与第三方插件的串扰。** 起因是一次真实故障：本插件的三个功能开关**全部关闭**，用户却看到推理被中断后**自动续跑**，而且**点停止按钮也停不下来**。取证结论是失败码撞车——`dsh-our-free-model` v2.0.0 在 `vendor/channel-pack/pack.js` 里编进了它自己的 `loop-recovery`，用 `error.code === "REASONING_LOOP"` 精确匹配判断「这是不是我自己的循环失败」，于是**本守卫的中断被它捕获**，它随即调 `agent.followup()` 注入一条 `source.kind: "user"` 的消息（与用户手打「继续」同形）重排了一整轮。这解释了全部症状：续跑不来自本插件（所以开关全关也照跑），而停止按钮只中止当前流（所以已经排队的续跑消息照样执行）。证据链完整：宿主日志三行相邻记录——`[reasoning-loop-guard] … aborting stream`、`[dsh-agent-error] … [REASONING_LOOP]`、`[our-free-model] [codearts-auth] … 思考陷入重复被中止，已自动续跑（第 1/2 次）`；会话原始日志（多帧 zstd，488 帧 / 887 条记录）里那条注入消息的 `source` 只有 `{"kind":"user"}` 而无 `rpcId`，与真实用户消息的形态不同。`test/smoke/smoke.mjs` 新增两条断言把默认值钉住（等于 `FAILURE_CODE`、且**不等于**通用 `REASONING_LOOP`），防止这个撞车再回来。

### Notes

- **`REASONING_LOOP` → `REASONING_LOOP_GUARD` 是行为可见的改动，升级前请留意。** 若你在别处按失败码做了匹配（告警规则、日志过滤、别的插件），需要跟着改。`failureCode` 仍可在 patch 里覆盖；`lib/guard.js` 导出的 `FAILURE_CODE` 是唯一权威默认值，`lib/index.js` 与 `lib/recovery.js` 都从它取值，不再各写一份字面量。
- **这类串扰无法从原理上根除。** 命名空间只挡住了**精确匹配**通用码的第三方恢复逻辑。若某个插件改成前缀匹配、或也去认 `REASONING_LOOP_GUARD`，冲突会回来——那时只能把 `failureCode` 改到一个双方都不认的值。反向也要注意：**别的插件自己检测到的循环仍会走它自己的恢复路径**，本插件的开关管不到它。
- **环境变量是可用的紧急止血阀。** 若串扰再次发生，可以在**系统环境变量**里设 `DSH_REASONING_LOOP_GUARD=0`（关掉第三方自带的循环检测）与 `DSH_REASONING_LOOP_AUTO_RESUME=0`（关掉它的自动续跑），两者都在第三方插件里以「未设即开」的方式读取。注意环境变量必须**注销重登或重启系统**才会广播到已有进程；只重启 DSH 不够。详见 README「关键设计决策」。

## [0.2.0] - 2026-10-07

### Added

- **Web GUI 日志卡片** (`lib/client.js`)。插件页上以包名为键注册 `plugins.bundle.config` 槽位，详情页因此出现一个「触发日志」面板：最近的触发记录、按判据/按模型的汇总、一键清空，以及日志路径的复制按钮。零构建——手写的惰性 CJS bundle，运行时只向平台种子表要 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`。
- **日志面板可折叠，且一次最多取 100 条**。一条记录默认只显示表头（时间 / 判据 / 度量 / 位置 / 模型），详情（来源、阈值快照、重复片段原文）收在折叠里；**最新一条默认展开**（要解释的通常就是它），工具栏另有「全部展开 / 全部收起」。整页一次只取最新 100 条并在工具栏注明是否被截断——旧版取 50 条且全部展开，记录一多就没法看。
- **宿主侧日志路由** (`lib/log-route.js`)。`GET /reasoning-loop-guard/log` 返回 `{ path, enabled, version, stats, total, matched, entries }`，支持 `limit` / `rule` / `sessionId` / `since` 查询；`POST` 只接受两个显式变更：`{"action":"clear"}` 与 `{"action":"set","patch":{…}}`。路由自带**同源回环栅栏**：非回环 `Host`、`Sec-Fetch-Site: cross-site`、或跨源 `Origin` 一律 403——宿主 webServer 本身不提供鉴权，这道栅栏必须由插件自己写。
- **GUI「功能开关」面板与插件自己的配置文件** (`lib/settings.js`)。详情页的日志面板下方多出四个区块：**自动恢复**（开关 + 纠正消息 + 每步重试次数）、**降低思考强度**（开关 + 强度档位）、**剥离历史思维链**（开关），以及只读的**配置文件**路径。改完点保存即写入 `$DSH_HOME/dsh-reasoning-loop-guard/config.json`（可用 `settingsPath` 改位置），**下一次请求就生效，不需要重启**——`fold()` 每次读取都重新折叠，所以保存后不必等重启。设置走的是插件自己的日志路由而非 DSH 的 settings 服务，因为**插件配置没有远程 API**；卡片与路由是同一表面的两半。三个开关**全部默认关闭**。
- **设置面刻意收窄到六个键** (`EDITABLE_KEYS`)。GUI 只能写 `recovery.enabled` / `recovery.message` / `recovery.maxRetries` / `effort.enabled` / `effort.value` / `stripHistory.enabled`——**检测阈值永远留在 patch 里**，这样「这次触发的阈值来自哪个文件」不会变成需要猜的问题。`config.json` 按**逐键**覆盖 patch 配置，只覆盖它真的写了的那几个键；写入是原子的（临时文件 + rename，mode 0600），读侧对缺失/损坏文件一律回落到基线，绝不抛异常。
- **自动恢复臂** (`lib/recovery.js`，**默认关闭**)。守卫中断一次流之后，向会话追加一条纠正消息并重跑同一步，最多 `recovery.maxRetries`（默认 2）次。为什么必须先追加消息：重试会**重发完全相同的请求**（`buildRequest` 从会话日志重新推导，被中断的 `assistant/attempt` 不参与推导），所以裸重试必然复现同一个循环。纠正消息必须带**产出方自己的 `source.kind`**（会话格式 v4 拒绝 `kind: "plugin"`），副作用是 chat UI 会把它渲染成上下文注记而不是用户气泡——正是机器插入的提示该有的样子。重试预算按**步**计（`sessionId:turn:step`）：按会话计会让一轮坏掉就永久禁用，按 attempt 计会让 `maxRetries` 失去意义。返回 `{kind:"retry"}` 时**故意不调用 `next()`**，否则平台会在重试排上之前就把失败定成终局；本臂的任何内部故障都落到 `next()`，失败保持与没有插件时一样终局。
- **降低思考强度臂**（**默认关闭**）。`agent/request` 上按 `effort.value`（`off` / `low` / `high` / `max`，默认 `low`）回写 `reasoningEffort`。监听器用 `{ prepend: true }` 注册并在 `next()` 之后回写——因为 `dsh-agent` 会重新推导 provider / model / reasoningEffort 并丢掉我们设的值，所以必须跑在核心自己的监听器之外。这是**针对病因**的一臂：复读是推理档位太高时的症状，护栏本身只缓解症状。
- **剥离历史思维链臂** (`lib/strip.js`，**默认关闭**)。DeepSeek 适配器会把历史 assistant 消息的 `reasoning` 作为线上 `thinking` 块回传，于是第 n 轮模型会读到 1..n-1 轮自己的思维链（包括开启循环的那句「让我再验证一遍」），回放历史还会撑大 prompt 前缀、损害 KV 缓存复用。**边界按「最后一个真实用户轮」切**：之前的 reasoning 是历史、丢弃；之后属于活跃轮、保留——搞错不是装饰性 bug，DeepSeek 会直接拒绝移除了活跃轮 reasoning 的 thinking 请求（`The reasoning_content in the thinking mode must be passed back to the API.`）。DSH 把工具结果作为 `user` 角色消息投递，所以朴素的「最后一条 user 消息」边界会落在工具循环中间并剥掉活跃轮，`isGenuineUserTurn()` 因此要求该 user 消息里至少有一个非 `tool-result` 的块。**明说的代价**：交给 `llm/stream` 的 request 对象是冻结的且 `next()` 不接参数，改 `messages` 只能带着新 options 对象重入 runtime，而该对象不在 `AGENT_LOOP_REQUESTS` weak set 里，于是 `dsh-agent-loop` 的「请求仍与会话日志推导一致」不变量对它被跳过——**这正是它默认关闭的原因**，也是插件在此只删内容、绝不发明内容的原因。形态上它是纯决策函数：要么返回改写后的 options、要么返回 `null`，因此它不是同一 waterfall 上的第二个监听器（否则会让护栏把同一次循环记两遍日志）。
- **插件元数据**：`icon`（`assets/icon.svg`，即 README 里那枚靶心的无背景版本）与 `locale/en.json` + `locale/zh.json`，因此插件页显示中文标题「推理循环守卫」与中文描述。
- **新增四套单元测试** `test/test-card.mjs`、`test/test-settings.mjs`、`test/test-recovery.mjs`、`test/test-strip.mjs`（连同 0.1.0 的 guard / journal 两套与两个 smoke 套件，`npm test` 现串行跑 **8 套**）。`test-card` 覆盖同源栅栏的 15 条判定、路由的方法/查询/上限/关闭态行为、注册走服务，以及客户端 bundle 的协议形态、卡片纯函数与折叠行为；`test-settings` 盯两条承重性质——**保存对下一次 `get()` 可见**（每次折叠），以及**坏文件表现得像全新安装、绝不像崩溃**；`test-recovery` 的契约全在**何时**行动——禁用时让路、只认护栏自己的失败、返回 `{kind:"retry"}` 前必须追加良构消息、必须耗尽每步预算、任何内部故障都要落到 `next()`；`test-strip` 的每条检查都因「剥掉活跃轮 reasoning 会被 DeepSeek 拒绝」这一失败模式而存在。
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
- **补丁/代码改动在 `node_modules` 内不会热重载**：`dsh-hmr` 默认忽略 `**/node_modules`，且 `PluginManager.reload()` 在没有 hmr 服务时静默不重载；此外 Node 会**在进程内永久缓存**每个包的 `exports` 映射，所以给 manifest 新增 export（例如 `./locale/*.json`）必须**重启 DSH Desktop**，刷新页面不够。README 的安装段已改正。注意这条只约束**代码**：功能开关存的是 `config.json`，保存后下一次请求即生效，**不需要重启**。
- **三个可选功能臂全部默认关闭**（`recovery.enabled` / `effort.enabled` / `stripHistory.enabled`，默认均为 `false`），在 patch 里和 GUI 里都一样。它们都改变了护栏之外的行为——追加消息、改写请求的推理档位、改写发给 provider 的消息列表——所以默认值取保守的一侧：装上插件只得到「检测并中断」，想要更多得显式打开。检测阈值则相反，始终在 patch 里、GUI 不可写。

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
