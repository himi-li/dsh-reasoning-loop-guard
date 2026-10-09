# dsh-reasoning-loop-guard

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="DSH Reasoning Loop Guard" width="150">
  </picture>
</p>

[![tests](https://img.shields.io/badge/tests-8%20suites%20passing-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**简体中文** | [English](README.en.md)

> **AI 使用说明** —— 本项目由 AI 助手协助整理撰写：源码、测试、文档与提交信息均由 AI 智能体（DSH Agent，运行于 DeepSeek Harness）在人类指导下起草；需求定义、方案决策与最终验收由人类作者完成。

检测并提前中断 [DSH](https://github.com/deepseek-ai/deepseek-harness) 中的**推理复读**——也就是「思维链循环卡死」：模型其实已经想完了，却卡在「准备输出」上无限打转，白烧掉几分钟和几十万字符，直到用户放弃并按下停止。

它把「静默卡死好几分钟」变成「立刻可见的报错」。

## 为什么需要它

**问题。** 模型早已做完真正的工程工作——看截图、算坐标、决定改哪个脚本——然后卡在「准备输出」阶段，反复催促自己却始终不落笔：`Let me write. Go. OK. Emit. Now.`。单步输出 **24–28 万字符**、耗时 **200 秒以上**，直到用户手动按下停止。这类轮次最终以**空 `stopReason`** 结束，内容只有**一个 `reasoning` 块**——没有 `text`，也没有 `tool-call`：模型没产出任何可执行动作，只是在思考里空转。而 DSH 当时没有任何护栏能发现并提前叫停。

**做法。** 插件挂在 `llm/stream` 瀑布钩子上（正是 DSH 自己的 `llm-invariant` 所用的同一个扩展点），**只测量流式推理文本**，每 200 字符在滚动缓冲区上评估五条判据；命中即**停止向上游拉取**，发出一个带 `code: "REASONING_LOOP_GUARD"` 的终止块，DSH 随后走它既有的 provider 错误路径。

**效果。** 记录在案的 11 次真实故障**全部在 10,000 字符以内被拦住**；在本机 2,799 条真实推理流（1,920 万字符）上只触发 7 次，且**全部是真循环**。阈值怎么定出来的，见[它解决的问题](#它解决的问题)与[为什么 `line-repeat` 要两个条件](#为什么-line-repeat-要两个条件)。

## 目录

- [为什么需要它](#为什么需要它) · [它解决的问题](#它解决的问题) · [工作原理](#工作原理)
- [安装](#安装) · [配置](#配置) · [功能开关](#功能开关)
- [触发日志与 GUI 面板](#触发日志gui-日志面板与-reasoning_loop_log-工具)
- [关键设计决策](#关键设计决策) · [测试](#测试) · [已知边界](#已知边界)

## 它解决的问题

在一次被完整记录的会话里（12 轮、324 步），**12 轮中有 11 轮**以完全相同的方式结束：

- 模型**早已做完真正的工程工作**——看截图、算坐标、决定改哪个脚本。
- 然后它卡在「准备输出」阶段，反复催促自己却始终不落笔：
  `Let me write. Go. OK. Emit. Now.` / `Writing. OK. Let me write. Go.`
- 单步输出了 **240,000–280,000 字符**，耗时 **208 秒**，直到用户按下停止才结束。

这 11 条 assistant 消息的 `stopReason` 都是**空字符串**，内容只有**一个 `reasoning` 块**——没有 `text`，也没有 `tool-call`。模型没有产出任何一个可执行动作，它只是在自己的思考里空转。

而 DSH 当时没有任何护栏能发现这一点并提前叫停。

## 工作原理

插件挂载在 `llm/stream` 瀑布钩子上——正是 DSH 自己的 `llm-invariant` 校验所用的同一个扩展点——只测量流式推理文本，并在判定成立的瞬间**停止向上游拉取**，随后发出终止块：

```js
{ type: "finish", reason: { kind: "error", failure: { message, code: "REASONING_LOOP_GUARD" } } }
```

DSH 随后走它既有的 provider 错误路径处理：本步以一个可见错误结束，而不是静默空转。

每 `every` 个字符，在滚动缓冲区上评估五条判据：

| 判据 | 定义 | 实测峰值（11 正样本 / 166 负样本） | 阈值 |
| --- | --- | --- | --- |
| `periodic-run`（主判据） | 缓冲区尾部存在 ≥ `minUnits` 个**连续相同的单元**，周期 p ∈ [8, 400] | 正样本 **0..8** 个单元，负样本 **0..2** | 4 |
| `block-repeat` | 同一 `blockMin` 字符的块在窗口内出现 ≥ `blockCount` 次（跨行、跨格式） | 正样本 **0..2**，负样本 **0..0** | 4 |
| `line-repeat` | 同一行（≥ `lineMin` 个字符）出现 ≥ `lineCount` 次，**且**这些重复行占窗口的比例 ≥ `lineShare` | 正样本 **2..2**，负样本 **0..0** | 3 + 10% |
| `kgram-repeat` | 末尾 `kgram` 个字符在窗口内出现 ≥ `kgramThreshold` 次 | 正样本 **1..5**，负样本 **1..1** | 12 |
| `filler-run`（兜底） | **原始**文本末尾连续 ≥ `fillerRun` 个装饰字符（空白 / 标点 / 符号） | 见下文「装饰不是复读」 | 400 |

五条判据是**析取**的：正样本不必触发某一条特定的判据，只要够到任意一条阈值即可。记录在案的 11 次故障里，**2 次由 `periodic-run` 拦下、9 次由 `line-repeat` 拦下**；负样本的最佳比值只到 **0.50**，正样本最低 **1.00**，分离点在 1.00。

### 为什么 `line-repeat` 要两个条件

「同一行出现两次就判循环」在写代码、写文档时是常态——重构时同一个标识符落在两行，写 changelog 时写了两遍 `## Unreleased`，都会中断用户的流。这个问题**没能在 177 样本定标集上暴露**，因为那 11 正 + 166 负**全是散文**，根本不含「边写代码边推理」这一整个失败形态：在那个形态上，0/166 误报说明不了任何事。

真正的定标改在**本机 2799 条真实推理流**（1,920 万字符，含 11 个已知真循环）上做。旧默认在该语料上触发 **180 次**（`line-repeat` 177、`block-repeat` 3），默认新值下只剩 **7 次且全部是真循环**。结论：

- **count 单独不够。** 语料里最常见的口头禅 `Let me write.` 最高能到 17 次，而最弱的真循环是 29 次，只有 1.7 倍余量，不足以押上「打断用户」的代价。
- **share 是判别量。** 重复行占窗口的比例：健康流最高 **6.1%**，最弱真循环 **10.2%**。取 8% 会放进两条误报，取 12% 会漏掉真循环，所以默认 10%。
- **count 也不能退回 2。** 一个 41 字符的长标识符只出现 **2 次**就能把 share 顶到 19.5%，光靠 share 地板拦不住它。取 3 与取 4 在语料上完全等价，取 3 留余量。
- **`block-repeat` 只需把 `blockCount` 从 3 提到 4**：3 会在健康推理**引用长文本**时触发（十六进制 dump、插件名清单、系统提示词复述），4 在语料上只剩 3 次触发且全为真循环。这里刻意**不加** share 地板——从 0% 到 25% 结果都一样，加了只是没有数据支撑的复杂度。

顺带修掉一个语义缺陷：这两条规则原来在第一个达标的单元上就返回，所以日志里的 `count` 永远等于阈值本身，从未反映真实重复次数。现在都改为全扫描取最大重复单元，`count` 因此是真实值。

### 为什么先做归一化

前四条判据都在**归一化文本**上计数：先把空白、标点、符号剥掉，再数重复。这一步不是美化，而是修一个真实的误报——最初的实现直接在原始文本上跑周期判据，于是模型画一条 `________` 分隔线就成了「8 个字符重复 6 次」，护栏真的中断了那次流，日志里留下一条 8 个下划线的记录。

清洗类是 `[\s\p{P}\p{S}]`。它是原先那份手写字符表的**严格超集**：`_` 属于 `\p{Pc}`（连接符标点），`─` / `▁` 属于 `\p{So}`，旧表都漏掉了。在全部 11 个真实退化样本上，新旧两类产出的文本**逐字节相同**——也就是说这次加宽只删掉了装饰，没有删掉任何一个真实循环赖以成立的字符。

### 装饰不是复读，但「一直在画装饰」是

归一化带来一个代价：一个**只**输出装饰的流，在四条计数判据眼里永远是空的，可以无限跑下去。`filler-run` 就是为这一种情况存在的兜底判据，并且刻意做得很迟钝：

- **它锚定在文本末尾。** 模型完全可以合法地画一张宽表格或 ASCII 图；一旦它接着写散文，那段装饰就不再位于尾部、不再计数。只有**持续**输出装饰的流才会触发——扫全窗口会在模型早已画完的图上误报。
- **门槛远高于任何合法排版。** 实测合法形状的最长装饰段：150 宽的 ASCII 框 **151** 字符、20 列 markdown 表行 **142**、setext 下划线 **62**、`---` 分隔线 **5**；而当初那条误报只有 **8** 个下划线。默认值 400 是实测最宽合法形状的 2.6 倍，真正卡住的流会在一个 `every` 周期内越过它。

在六种喂入粒度下（chunk = 1 / 8 / 40 / 200 / 1000 / 4000），五条判据合计仍为 **11/11 全部命中、0/166 零误报**。

**只测量 `reasoning-delta`，绝不测量 `block-end`**——后者会重放整个块的文本，等于人为制造出它正要寻找的那种重复。**也绝不测量 `text-delta`**：正常的长输出（表格、代码）本来就可能重复，漏报好过误杀。

## 安装

本包尚未发布到 npm，从 GitHub 源码安装。DSH 按 profile 隔离：**桌面版用 `desktop`，网页版用 `web`**，装进哪个 profile 就只在那个形态下生效。两个形态的命令只差一个名字。

### 桌面版（desktop）

```powershell
# 用 DSH Desktop 内置的命令运行时执行（独立安装的 npm 版 dsh CLI 会拒绝 --profile desktop）
# 先启动一次 Desktop 初始化它的 profile，再完全退出应用，然后执行
dsh plugin --profile desktop add github:himi-li/dsh-reasoning-loop-guard
```

内置命令运行时拒绝未初始化的 Desktop profile，也不会替它创建普通 CLI profile——所以「先启动一次、再完全退出」是必需的。装完重新打开 Desktop 生效。

### 网页版（web）

```powershell
# 任意 dsh CLI 均可；web profile 不存在时会从随附模板自动创建并初始化
dsh plugin --profile web add github:himi-li/dsh-reasoning-loop-guard
```

**网页版就是把命令里的 `desktop` 换成 `web`。** 通用格式是 `dsh plugin --profile <name> add <包名>`：`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 首次使用时会从随附模板自动初始化，只有 `desktop` 需要「先启动一次、再完全退出」。同一个包可以分别装进多个 profile，互不影响。

这条命令把包装进 profile 的 `dependencies`，并自动把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`——两处都会写，不需要手改 `package.json`。

**本包不需要 `allowBuilds` 授权。** 从 git 安装的插件通常要跑 `prepare` 构建脚本，而 pnpm ≥10 默认拒绝，用户得先往 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds` 再重试。本包直接分发构建好的纯 JavaScript（`lib/` 已入库），没有 `prepare` 脚本，所以首次 `add` 即可装成。卸载用 `dsh plugin --profile <name> remove dsh-reasoning-loop-guard`。

不想用 `dsh plugin` 的话，也可以在 profile 的 `package.json` 里自己写这两处：

```json
{
  "dependencies": {
    "dsh-reasoning-loop-guard": "github:himi-li/dsh-reasoning-loop-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-reasoning-loop-guard"]
    }
  }
}
```

**`dependencies` 和 `bundles` 两处都要写。** DSH 的插件页只列出存在于 profile `dependencies` 里的包（这是「已安装」的判据），而 `bundles` 决定它是否被装载。只写 `bundles` 也能跑，但卡片不会出现在插件页上。

手写时装载方式有两种：用上面那行 `dependencies`（配合 `pnpm install`）；或者直接在 profile 的 `cordis.patch.yml` 里挂载（本包自带的 `cordis.patch.yml` 就是这一份）：

```yaml
- insert:
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
      config: {}
```

**改完需要重启 DSH，而不是只刷新页面。** 有两个各自独立的原因：

1. 宿主对 `node_modules` 的 HMR 是**关闭**的（`dsh-hmr` 的 `ignored` 默认含 `**/node_modules`），所以包内文件的变动不会被监听到。
2. Node 的 ESM 解析器在进程内**永久缓存**每个包的 `exports` 映射。本包新增 `locale/*.json` 这类 export 之后，**同一个宿主进程里永远解析不到它们**——表现为插件页上的标题一直是英文包名，而图标（直读文件、不走 exports）却正常。只有重启才能让宿主重读 manifest。

**给包作者看的验证命令**，无需启动 DSH 即可确认元数据能被正确读出（`icon`/`locale` 是否生效）：

```powershell
node --input-type=module -e "import { readPluginMeta } from '@deepseek-ai/dsh-app-boot'; console.log(readPluginMeta('dsh-reasoning-loop-guard', 'file:///' + process.argv[1].replace(/\\/g,'/') + '/'))" "$PWD"
```

## 配置

所有字段都可以在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- insert:
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
      config:
        enabled: true
        minUnits: 4                # periodic-run：连续重复单元数
        kgramThreshold: 12         # kgram-repeat：尾部 k-gram 的出现次数
        lineCount: 3               # line-repeat：重复行出现次数
        lineShare: 0.1             # line-repeat：重复行占窗口的最低比例
        blockCount: 4              # block-repeat：同一块的重复次数
        fillerRun: 400             # filler-run：末尾连续装饰字符数
        minChars: 800              # 低于这么多字符不做判定
        every: 200                 # 每 N 个字符评估一次
        failureCode: REASONING_LOOP_GUARD

        # 触发日志（见下）
        journal: true
        journalPath: ""            # 默认：$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl
        journalMaxBytes: 524288
        journalPreviewChars: 120
        logTool: true              # 注册 reasoning_loop_log 工具

        # 功能开关（见下文「功能开关」）
        settingsPath: ""           # 默认：$DSH_HOME/dsh-reasoning-loop-guard/config.json（只在 patch 里设）
        recovery:
          enabled: false           # 中断后追加纠正消息并重跑同一步
          message: ""              # 留空使用内置文案
          maxRetries: 2            # 每步最多重试几次（0–10）
        effort:
          enabled: false           # 按档位回写 reasoningEffort
          value: low               # off | low | high | max
        stripHistory:
          enabled: false           # 剥离历史轮的思维链，只留活跃轮
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。patch 里为 false 时插件完全不注册任何流钩子（只读一次，改了要重启）；设置文件里同名键由流监听器逐请求读取，**关掉下一次请求就生效**（见「功能开关」）。 |
| `minChars` | `800` | 短于此长度的推理永不判定。 |
| `every` | `200` | 判定节奏，单位为字符。 |
| `window` | `4096` | k-gram 判据使用的滚动窗口。 |
| `kgram` | `64` | k-gram 判据跟踪的尾部片段长度。 |
| `kgramThreshold` | `12` | 在 `window` 内出现多少次才触发。 |
| `periodTail` | `1200` | 周期判据使用的滚动窗口。 |
| `minPeriod` / `maxPeriod` | `8` / `400` | 周期判据搜索的周期范围。 |
| `minUnits` | `4` | 触发所需的连续相同单元数。 |
| `blockMin` / `blockCount` | `100` / `4` | `block-repeat` 的块长度与出现次数。 |
| `lineMin` / `lineCount` / `lineShare` | `10` / `3` / `0.1` | `line-repeat` 的行长度、出现次数，以及重复行至少要占窗口的比例（见上文「为什么 `line-repeat` 要两个条件」）。 |
| `fillerRun` | `400` | `filler-run`：末尾连续装饰字符达到多少才判定为卡死。 |
| `failureCode` | `REASONING_LOOP_GUARD` | 终止块携带的失败码。**刻意带命名空间**，避免与第三方插件的循环恢复互相串扰（见下文「关键设计决策」）。 |
| `journal` | `true` | 把每次触发记录进 JSONL 日志。 |
| `journalPath` | `""` | 日志位置；留空表示 `$DSH_HOME` 下的默认路径。 |
| `journalMaxBytes` | `524288` | 日志超过该字节数后轮转为 `<path>.1`。 |
| `journalPreviewChars` | `120` | 每条记录保存的「肇事尾巴」字符数。 |
| `logTool` | `true` | 注册 `reasoning_loop_log` 工具。 |
| `settingsPath` | `""` | 功能开关的配置文件位置；留空表示 `$DSH_HOME` 下的默认路径。 |
| `enabled`（设置文件） | `true` | GUI 的检测核心开关。**显式 `false` 才算关**；关掉后不再观察任何流，三条臂随之失效。 |
| `recovery.enabled` | `false` | 中断一次流之后，追加一条纠正消息并重跑同一步。 |
| `recovery.message` | `""` | 纠正消息正文；留空使用内置文案。 |
| `recovery.maxRetries` | `2` | 每步最多自动恢复几次（0–10）。 |
| `effort.enabled` | `false` | 按档位回写请求的 `reasoningEffort`。 |
| `effort.value` | `low` | 强度档位：`off` / `low` / `high` / `max`。 |
| `stripHistory.enabled` | `false` | 剥离历史轮的思维链，只保留活跃轮。 |

`validateConfig()` 会拒绝那些**会静默失效**的配置——`kgram > window`、`minPeriod >= maxPeriod`、`periodTail < 2 * maxPeriod`、`failureCode` 为空、`every` 非正数等等——并在报错信息里点名字段。功能开关还会额外校验：`settingsPath` 必须是字符串、`recovery.maxRetries` 必须是非负整数、`effort.value` 必须在 `off` / `low` / `high` / `max` 之内。

### 功能开关

上面最后七行（`settingsPath` 与三个开关的六个字段）加上 `enabled`，也可以在 **GUI 里改**——但 `settingsPath` 例外：它只在 patch 里设，GUI 把它**只读**地显示出来。在插件页打开本插件，详情页的「触发日志」面板下方有五个区块——**循环守卫**（检测核心总开关）、**自动恢复**（开关 + 纠正消息 + 每步重试次数）、**降低思考强度**（开关 + 强度档位）、**剥离历史思维链**（开关），以及只读的**配置文件**路径。改完点保存，界面会显示「设置已保存」，值写进 `$DSH_HOME/dsh-reasoning-loop-guard/config.json`。

**检测核心默认开启，三个可选臂默认关闭**，在 patch 里和 GUI 里都一样。核心开关是唯一默认值为 `true` 的键——它就是插件本身；三条臂则都改变了护栏之外的行为，所以默认取保守的一侧：装上插件只得到「检测并中断」，想要更多得显式打开。

**关掉检测核心，三条臂随之失效。** 它们只可能响应守卫自己抛出的失败，而守卫不再观察任何流之后就不会再抛出这种失败——所以关掉核心之后，`recovery` / `effort` 即便还开着也不会做任何事。

**核心开关与 patch 里的同名键不是一回事，但不会互相打架。** patch 里的 `enabled: false` 表示「整插件不注册任何钩子」，只在装载时读一次，改了要重启；设置文件里的 `enabled` 由流监听器**逐请求**读取，**关掉后下一次请求就生效**。判定写成「**显式 `false` 才算关**」：键缺失表示「按出厂设置」，也就是开着——这样旧的 `config.json` 与任何只写了部分键的文件都不会被误读成关闭。

**保存后不需要重启。** `config.json` 是**逐键**覆盖 patch 配置的，而且每次读取都重新折叠，所以**下一次请求就生效**。这一点和代码改动不同——`node_modules` 里的代码不会热重载（见「已知边界」）。

**GUI 只能写这七个键，检测阈值永远留在 patch 里。** 这样「这次触发的阈值到底来自哪个文件」不会变成一个需要猜的问题——日志里那份 `thresholds` 快照永远对应 patch。写入是原子的（临时文件 + rename），读侧对缺失或损坏的 `config.json` 一律回落到基线，**绝不抛异常**：一个写坏的设置文件最多让开关回到默认值，不会让护栏变成 inactive。

三个开关各自的机制与代价：

- **自动恢复**（`recovery.*`）。守卫中断一次流之后，向会话追加一条纠正消息并重跑同一步。**为什么必须先追加消息**：重试会重发**完全相同的请求**（`buildRequest` 从会话日志重新推导，被中断的 `assistant/attempt` 不参与推导），所以不带新消息的裸重试必然复现同一个循环。重试预算按**步**计（`sessionId:turn:step`）——按会话计会让一轮坏掉就永久禁用，按 attempt 计会让 `maxRetries` 失去意义。这条消息带的是**产出方自己的 `source.kind`**（会话格式 v4 拒绝 `kind: "plugin"`），副作用是 chat UI 会把它渲染成上下文注记而不是用户气泡。本臂的任何内部故障都落到 `next()`，失败保持与没有插件时一样终局。
- **降低思考强度**（`effort.*`）。按档位回写请求的 `reasoningEffort`。这是**针对病因**的一臂——复读是推理档位太高时的症状，护栏本身只缓解症状——所以如果你的 provider 支持更低的档位，这一臂比护栏更根本。它必须跑在 `dsh-agent` 自己的 `agent/request` 监听器之外（核心会重新推导 provider / model / `reasoningEffort` 并丢掉我们设的值），因此用 `{ prepend: true }` 注册并在 `next()` 之后回写。
- **剥离历史思维链**（`stripHistory.enabled`）。DeepSeek 适配器会把历史 assistant 消息的 `reasoning` 作为线上 `thinking` 块回传，于是第 n 轮模型会读到 1..n-1 轮自己的思维链（包括开启循环的那句「让我再验证一遍」），回放历史还会撑大 prompt 前缀、损害 KV 缓存复用。**边界按「最后一个真实用户轮」切**：之前的 reasoning 是历史、丢弃，之后属于活跃轮、保留。搞错不是装饰性 bug——DeepSeek 会直接拒绝移除了活跃轮 reasoning 的 thinking 请求（`The reasoning_content in the thinking mode must be passed back to the API.`），而 DSH 把工具结果作为 `user` 角色消息投递，所以朴素的「最后一条 user 消息」边界会落在工具循环中间并剥掉活跃轮。**它的代价要明说**：交给 `llm/stream` 的 request 对象是冻结的且 `next()` 不接参数，改 `messages` 只能带着新 options 对象重入 runtime，而该新对象不在 `AGENT_LOOP_REQUESTS` weak set 里，于是 `dsh-agent-loop` 的「请求仍与会话日志推导一致」不变量对它被跳过——**这正是它默认关闭的原因**，也是这一臂只删内容、绝不发明内容的原因。

## 触发日志、GUI 日志面板与 `reasoning_loop_log` 工具

### GUI 里的「触发日志」面板

在 DSH 的**插件**页打开本插件，详情页里会多出一个「触发日志」面板：最近的触发记录（时间、判据、模型、已读字符数、肇事尾巴的预览）、按判据与按模型的汇总、一键清空，以及日志路径的复制按钮。没有触发记录时它显示一句明确的空态文案，而不是一片空白。

列表一次取一页、**最多 100 条**，最新在前。每行始终显示表头（时间、判据、度量、位置、模型），把详情——完整度量、来源（`turn` / `step` / 尝试号）、预览、当时生效的阈值——收在点击之后。最新一条默认展开，因为要解释的通常就是它；工具栏另有**全部展开** / **全部收起**。你自己点开或收起的行会保留选择，直到批量操作覆盖它。工具栏最左侧的**收起列表** / **展开列表**是更粗一级的折叠：它把整个列表连同行头一起收起，只留下工具栏与汇总——记录多的时候想先看统计、或者想暂时把面板腾干净，用这一个按钮即可。两级折叠各管一层，互不覆盖。

这个面板由两半组成，都在本包内：

| 文件 | 作用 |
| --- | --- |
| [`lib/log-route.js`](lib/log-route.js) | 向宿主的 `webServer` 注册 `GET /reasoning-loop-guard/log`，返回 `{ path, enabled, version, settings, stats, total, matched, entries }`；支持 `limit` / `rule` / `sessionId` / `since` 查询，`POST` 只接受 `{"action":"clear"}` 与 `{"action":"set","patch":{…}}` 两个显式变更（都是破坏性的，**刻意不能由链接或预取触发**）。 |
| [`lib/client.js`](lib/client.js) | 手写的惰性 CJS bundle（**零构建步骤**），以包名为键注册 `plugins.bundle.config` 槽位并渲染卡片。运行时只向平台种子表 `require` 两个词：`react` 与 `@deepseek-ai/dsh-client-ui-primitives`。 |

**路由自带同源栅栏。** 宿主的 `webServer` 不提供任何鉴权，所以这道栅栏由插件自己写：非回环 `Host`、`Sec-Fetch-Site: cross-site`、或与 `Host` 不同源的 `Origin`，一律 `403`。请求体上限 16 KiB（超出回 `413` 并断开），非 `GET`/`POST` 回 `405`。你的浏览器本来就带着 DSH 的渲染进程访问令牌，因此同源栅栏不会妨碍正常使用——但一个恰好能访问到该端口的其他程序会被挡在外面。

> 若你的宿主根本没提供 `webServer` 服务，`ctx.inject(["webServer"], …)` 会**静默跳过**路由注册，护栏本体照常工作。这是刻意的：一个诊断面板不该让护栏变成 inactive。

### 触发日志

护栏每触发一次，就向 `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl` 追加一行 JSON：

```json
{"v":1,"at":1760000000000,"iso":"2026-10-06T15:20:00.000Z","rule":"periodic-run",
 "atChars":3120,"failureCode":"REASONING_LOOP_GUARD","pluginVersion":"0.2.0",
 "sessionId":"...","provider":"...","model":"...","purpose":"...",
 "reasoningEffort":"max","turn":17,"step":2,"attemptId":"...","cwd":"...",
 "units":6,"period":64,"elapsedMs":4210,"fromStartMs":18730,"ttftMs":14520,
 "reasoningChars":3120,"aborted":false,
 "preview":"Let me write. Go. OK. Emit. Now. …","previewRaw":"…",
 "thresholds":{"minChars":800,"every":200,"window":4096,"kgram":64,"kgramThreshold":12,
   "periodTail":1200,"minPeriod":8,"maxPeriod":400,"minUnits":4,"blockMin":100,
   "blockCount":4,"lineMin":10,"lineCount":3,"lineShare":0.1,"fillerRun":400}}
```

未知字段会直接省略，因此旧记录只是字段更少，不会写成 `null`。几个值得留意的：`ttftMs` 把「模型很慢、然后才开始打转」和「从第一个 token 就在打转」分开；`aborted` 记录判定落地前调用方是否已经放弃；`thresholds` 是产生这次判定的**确切配置**——几个月后要复盘一次误报，靠的就是它；`previewRaw` 只在 `preview` 被截断时出现，是未截断的原文尾巴。

**`iso` 存 UTC，界面显示本地时间。** 落盘的 `iso` 是规范的 UTC 形式（`…Z`），因为它必须无歧义；而**你读到的地方一律是本地墙钟时间**——面板的行时间与「时间跨度」、`reasoning_loop_log` 的 `list` 行与 `stats` 的 `span:` 行，都经同一个 `localStamp()` 渲染。这样一条 16:25 的触发就不会看起来像 08:25。同理，`stats` 的「按天」也按**本地日**切分，与行时间一致。

日志是有界的（`journalMaxBytes`，默认 512 KiB → 轮转为 `fires.jsonl.1`），每次写入都包在 try/catch 里，日志故障**只会告警，绝不影响流**。设为 `journal: false` 可整体关闭。

插件还会注册一个只读的维护工具 `reasoning_loop_log`：

| `action` | 返回 |
| --- | --- |
| `list`（默认） | 最近的触发记录，最新在前。可按 `rule`、`sessionId`、`since`（epoch 毫秒）过滤，用 `limit` 限制条数。 |
| `stats` | 汇总：总数、按判据、按模型、按天，以及最早/最晚时间戳。 |
| `path` | 解析后的日志路径。 |
| `clear` | 删除日志（连同轮转出的 `.1`）。 |

于是「最近到底有没有在触发、是在哪个模型上触发的？」只需一次工具调用，而不用去会话日志里翻。

## 关键设计决策

**`failureCode` 故意放在默认可重试集合之外。** 可重试的失败码是 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`，`REASONING_LOOP_GUARD` 不在其中，因此 `dsh-llm-retry` 不会自动重试。原因是：复读是**这次请求本身**的性质，自动重试会把整个 prompt 再发一遍，白烧同样的 token 再复读一次。如果你确实想要重试，把 `failureCode` 设为 `EMPTY_RESPONSE`。

**`failureCode` 默认带命名空间，是为了不和别的插件串台。** 0.2.0 之前默认值是通用的 `REASONING_LOOP`，而**其他插件也会自带循环检测，并按失败码驱动自己的恢复逻辑**。本机实测到的一个真实冲突：`dsh-our-free-model` v2.0.0 在 `vendor/channel-pack/pack.js` 里编进了自己的 `loop-recovery`，它用 `error.code === "REASONING_LOOP"` 精确匹配来决定是否**自动续跑**——于是本守卫的中断被它当成自己的失败捕获，它随即用 `agent.followup()` 注入一条 `source.kind: "user"` 的消息（与用户手打「继续」同形）重排了一整轮。后果有两个，而且都很难查：**（1）**本插件的三个功能开关全关时，看起来仍然「自动触发了」——因为续跑根本不来自本插件；**（2）**用户点停止按钮也停不下来——按钮只中止当前流，那条已经排队的续跑消息照样会跑起来。改成 `REASONING_LOOP_GUARD` 后精确匹配不再命中，本守卫的失败回到只由 `dsh-llm-retry` 的集合语义处理。如果你在 0.2.0 之前用过本插件、又在别处按 `REASONING_LOOP` 做了匹配，升级后需要跟着改。

**这类串扰无法从原理上根除。** 命名空间只挡住了**精确匹配**通用码的第三方恢复逻辑。若某个插件改成前缀匹配、或也去认 `REASONING_LOOP_GUARD`，冲突会回来——那时只能把 `failureCode` 改到一个双方都不认的值。反向也要注意：**别的插件自己检测到的循环仍会走它自己的恢复路径**，本插件的开关管不到它。

**应急止血：环境变量。** 命名空间修掉了**精确匹配**这一种串扰，但同类冲突无法从原理上根除（见上一条）。如果又遇到「开关全关却自动续跑、停止按钮也停不下来」，可以先用环境变量把第三方那一侧关掉，不必等本插件发新版：

| 环境变量 | 设为 | 作用 |
| --- | --- | --- |
| `DSH_REASONING_LOOP_GUARD` | `0` | 关掉第三方插件**自带的**循环检测（它自己也有一套 `createReasoningLoopDetector`，与它驱动恢复逻辑的判定同源）。 |
| `DSH_REASONING_LOOP_AUTO_RESUME` | `0` | 关掉第三方插件的**自动续跑**。 |

两个变量都在第三方插件里以「**未设即开**」的方式读取（`resolveReasoningLoopGuardFlag()` 只在值为 `0` / `false` / `no` / `off` 时才判为关），所以必须显式设成 `0`。**它们只影响那个插件自己的行为，不影响本守卫**——本插件不读任何 `DSH_*` 环境变量。

设成**系统/用户环境变量**，不要写进 `~/.dsh/.env`：DSH 的启动器把 `DSH_` 前缀列为「只允许启动环境设置」的保留前缀，写在 `.env` 里会被直接拒绝。

```powershell
# 当前用户级，永久生效
[Environment]::SetEnvironmentVariable('DSH_REASONING_LOOP_GUARD', '0', 'User')
[Environment]::SetEnvironmentVariable('DSH_REASONING_LOOP_AUTO_RESUME', '0', 'User')
```

**必须注销重登（或重启系统）才生效，只重启 DSH 不够。** 环境变量在登录时由 `explorer.exe` 一次性广播给进程环境块；已有进程——包括 DSH 桌面端及其 Host 子进程——不会收到后写入的值。设完后用 `Get-EnvironmentVariable(...,'User')` 或 `reg query HKCU\Environment` 能立刻读到 `0`，但当前进程的 `$env:` 仍为空，这是正常的。要立刻验证，可以完全退出 DSH 后从**新开的**终端启动它。

**每条流都新建一个检测器。** 自动重试会从零开始计数，上一次尝试的重复不会累积到下一次。

**对工具服务没有硬依赖。** 工具是通过 `ctx.inject(["tools"], …)` 注册的——一种**可选**注入。若写成硬 `inject`，那么在任何没有 tools 服务的宿主上插件都会变成 inactive，等于为了一个诊断功能而把护栏本身也关掉了。

**两条可选臂注入的服务名是 `agents`，不是 `agent`。** `@deepseek-ai/dsh-agent` 把自己的注册表注册为 `super(ctx, "agents")`，所以 `ctx.inject(["agent"], …)` **永远解析不到**：Cordis 在依赖不满足时不会调用回调，连一条告警都不会有。0.2.2 及以前正是写成了单数 `agent`，后果是「自动恢复」与「降低思考强度」两条臂**从未注册**，而 GUI 开关照旧显示「开」——打开自动恢复后中断仍然直接终态失败，日志里一条 `recovery` 都没有。单数 `agent` 只是该插件在 typert 里注册的 **wire 类型名**，不是 Cordis 服务名；`dsh-llm-retry` 挂在同一个 `agent/request-error` 事件上，用的是 `inject = ["agents", …]`。这条已经由 `test/smoke/smoke.mjs` 的两组断言钉住（注入列表必须含 `agents` 且不得含 `agent`；`agents` 解析成功时两条臂必须都注册）。

**零运行时依赖。** 除了声明为 peer 的 DSH 宿主包之外，插件不导入任何东西。

## 测试

```powershell
npm test
```

八套测试，必须全部通过：

| 套件 | 覆盖内容 |
| --- | --- |
| [`test/test-guard.mjs`](test/test-guard.mjs) | 六种 chunk 大小下的检测器定标、分离度、`guardStream` 协议一致性（恰好一个终止 `finish`、提前停止、已中止信号的处理、健康流不被改动）、消息渲染。 |
| [`test/test-journal.mjs`](test/test-journal.mjs) | `$DSH_HOME` 解析、preview 截断、记录形状、解析容错、过滤、`stats` 聚合、轮转，以及「日志故障永不抛异常」这条保证。 |
| [`test/test-settings.mjs`](test/test-settings.mjs) | 功能开关的两条承重性质：保存对**下一次** `get()` 可见（每次折叠），以及坏文件表现得像全新安装、绝不像崩溃；另有检测核心开关的默认值与「阈值不进 GUI」的边界。 |
| [`test/test-recovery.mjs`](test/test-recovery.mjs) | 自动恢复臂的契约全在**何时**行动：禁用时让路、只认护栏自己的失败、返回 `{kind:"retry"}` 前必须追加良构消息、必须耗尽每步预算、任何内部故障都要落到 `next()`。 |
| [`test/test-strip.mjs`](test/test-strip.mjs) | 剥离历史思维链臂的边界判定——每条检查都因「剥掉活跃轮 reasoning 会被 DeepSeek 拒绝」这一失败模式而存在。 |
| [`test/test-card.mjs`](test/test-card.mjs) | 日志路由的同源栅栏判定、方法与查询参数、上限与关闭态、注册走服务，以及客户端 bundle 的协议形态（在 `window.__ModuleLoader__` 伪装下真的加载它）与卡片的纯函数。 |
| [`test/smoke/smoke.mjs`](test/smoke/smoke.mjs) | 用桩宿主驱动真实的 `apply()`：配置校验、全局只注册一个 `llm/stream` 监听器、工具注册、该工具的端到端行为，以及**可选注入的服务名**（必须索要 `agents`、不得索要单数 `agent`；`agents` 解析成功时两条可选臂必须都注册且思考强度臂带 `{ prepend: true }`）。 |
| [`test/smoke/real-protocol.mjs`](test/smoke/real-protocol.mjs) | 真实的 `@deepseek-ai/dsh-llm` 不变量校验门，断言护栏的输出是一条**合法**的流。 |

两个 smoke 套件通过 [`test/smoke/resolve-hook.mjs`](test/smoke/resolve-hook.mjs) 把 `@deepseek-ai/*` 解析到 app 与 profile 的安装位置，因此不必启动 DSH 就能验证宿主侧的那一半。

### 端到端验证记录

开发期间，护栏还额外用**真实的 `dsh` CLI 驱动一个真实的 agent loop**做过端到端验证，跑在一个隔离 profile 上，该 profile 的默认模型是一个只用于测试的适配器，回放一段退化推理流。这里没有任何东西是仿制品：不是 loop，不是瀑布钩子，不是不变量校验门，也不是 CLI 的错误出口。

两臂、十一项断言：

| | 护栏开启 | 护栏关闭（同一条流） |
| --- | --- | --- |
| 退出码 | **1** | **0** |
| 上游实际发出 | **3120 / 7659 字符** | 7659 / 7659 字符 |
| 上游是否跑到自己的结尾 | 否 | 是 |
| stderr | `REASONING_LOOP_GUARD: … 周期 64 字符，重复 6 次，已读到 3120 字符` | — |
| stdout | 空 | `TG-FAKE-OK` |

也就是说：护栏**确实把上游生成器截断了**（而不是等流跑完才报个错）；而关掉护栏后，同一条流完整跑完、毫发无损——这排除了「测试装置本身是坏的」这种可能。

> 这套端到端装置属于开发脚手架，不随包发布。上面八套测试才是随包交付的。

## 测试夹具

护栏的阈值是针对一次真实故障定标的，但那段会话的推理文本属于隐私，因此仓库里提交的 [`test/fixtures/`](test/fixtures/) 夹具是**合成的**。它们复现了原始数据**实测出来的形状**——相同的行数（11 / 166）、相同的逐行字符数（从一条 24.4 万字符的大块，到 502 字符的小块），以及相同的复读几何（单元周期经过挑选，使 k-gram 判据计得 20..162 次命中、周期判据计得 5..50 个单元）。

生成器带随机种子且完全确定，因此重新生成会产出逐字节相同的文件，任何 diff 都是真实变更。

## 已知边界

- **它不是通用看门狗。** 这几条判据针对的是一种特定的退化形态——尾部连续重复。换一种卡法（比如无限工具调用循环，或者模型在语义上绕圈但并不逐字重复）不会触发它。
- **首次触发的位置**取决于喂入粒度：最早约 3000 字符，最晚约 56000 字符。记录在案的 11 次故障都会在 10,000 字符以内被拦住。
- **定标样本曾是单个会话的 177 条，样本量偏小——已知有盲区。** 它全是散文，不含「边写代码边推理」这一形态，因此在那上面报出的 0/166 误报**不能**外推。`line-repeat` / `block-repeat` 的阈值后来改用 2,799 条真实语料重新定标（见上文「为什么 `line-repeat` 要两个条件」）。若实践中仍出现误报，优先调高 `lineShare`（比例地板）或 `minUnits` / `kgramThreshold`；若误报来自装饰（比如你的模型习惯画很宽的图），调高 `fillerRun`。
- **只输出装饰的流会被兜底判据拦下，阈值可调。** 见上文「装饰不是复读」：默认 400 已高于实测最宽合法排版（151），但如果你的场景里合法图形更长，把它调高即可。
- **护栏本身只缓解症状。** 如果你的 provider 支持更低的推理档位，那才是针对病因——可以打开上面的**降低思考强度**开关（见「功能开关」），或者在你的 DSH 配置里直接调低。
- **检测核心与三个功能臂的开关语义不同，别混淆。** 检测核心（`enabled`）默认**开启**，它是插件本身；三条臂默认**关闭**，代价在各自小节里写明。尤其 `stripHistory` 会让 `dsh-agent-loop` 的「请求仍与会话日志推导一致」不变量被跳过（见「功能开关」），`recovery` 会向会话追加一条消息。这些都是默认关闭的原因，不是可以忽略的细节。
- **失败码与第三方插件的串扰已由命名空间修掉，但同类冲突无法从原理上根除。** 0.2.0 起本插件默认用 `REASONING_LOOP_GUARD`（见「关键设计决策」），所以按通用 `REASONING_LOOP` 精确匹配的第三方恢复逻辑不会再捕获本守卫的中断。但如果某个插件改成**前缀匹配**、或干脆也去认 `REASONING_LOOP_GUARD`，串扰就会回来——那时只能改 `failureCode` 到一个双方都不认的值。反过来也要注意：**别的插件自己检测到的循环仍然会走它自己的恢复路径**，本插件的开关管不到它。又遇到串扰时，可先用 `DSH_REASONING_LOOP_GUARD=0` / `DSH_REASONING_LOOP_AUTO_RESUME=0` 应急（见「关键设计决策」）。

## 许可证

[MIT](LICENSE)
