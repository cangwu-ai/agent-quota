# 数据协议与链路审计

## 文件与兼容性

数据来自 `data` 分支的 `data/mac.json`、`data/grok-cloud.json`、`data/manual.json`。
`mac`、`grok-cloud` 是固定来源代号，不是实际主机名。云端来源名不代表存在 Grok 用量。
新发布器保留旧前端使用的 `codex.windows`、`claude.tokens_today`、
`antigravity.buckets` 以及手动文件的 provider 键；新增 `schema_version: 1` 和 `pools`。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| updated_at | UTC ISO 8601 | 文件快照生成时间；手动文件为此次生成时间 |
| collected_at | UTC ISO 8601 | 自动采集快照时间 |
| pools[].id | string | provider，或 provider:窗口，或 provider:模型组:窗口；跨文件使用来源+id |
| pools[].name | string | 固定 provider 或允许的模型组名称 |
| pools[].provider | string | codex / claude / antigravity / grok |
| pools[].used_pct | number/null | 0–100，未知为 null |
| pools[].remaining_pct | number/null | 100-used_pct，未知为 null |
| pools[].tokens | number/null | 已记录 token，未知不得写成 0 |
| pools[].tokens_period | string/null | today，北京时间当天；未知为 null |
| pools[].tokens_status | string | available / unavailable |
| pools[].tokens_scope | string | 自动池为 provider-source，同来源同 provider 多窗口共享，不得重复相加 |
| pools[].updated_at | UTC ISO 8601/null | 实际源数据 observed_at，非发布心跳；缺观测为 null |
| pools[].resets_at | UTC ISO 8601/null | 自动窗口重置时间 |

Claude/Grok 新增兼容字段 `used_percent`、`resets_at`、`windows[]`、`quota_status`，
以及独立的 `quota_observed_at`、`tokens_observed_at`。额度接口成功不会刷新 token 观测时间。
窗口仍使用 `used_percent/window_minutes/resets_at`；Grok 未知或月账期时 window_minutes 可为 null。
状态枚举、来源和部署见 [Claude / Grok 数据接入](claude-grok-operations.md)。

Codex token 从会话累计计数取增量；Claude 从回复 usage 汇总，包含缓存 token，按消息及请求去重。
兼容字段 `tokens_last_5h` 为近五小时，`tokens_by_day` 为最近七个北京时间自然日。
这些是本地日志统计，不代表服务商计费总量；多个来源日志重复时不能简单相加。
手动数据 `resets_on` 是日期，沿用旧前端按北京时间零点解释。
前端应分别检查文件心跳与池观测时间，超过 30 分钟或时间未知均不能作为新鲜读数。

## 现状盘点

以下为上次链路审计的历史状态，不代表当前脚本能力；本次 Claude/Grok 修复情况见上方接入文档。

本次读取的 data ref、时间区间和机器可读结果见 [data-audit.json](data-audit.json)。

| 来源 | 额度 | token | 文件 updated_at |
| --- | --- | --- | --- |
| mac Codex | 周窗口 used_percent | 今日、5h、每日、输出 | 缺失 |
| mac Claude | 缺百分比，需手动额度 | 今日、5h、每日、输出 | 缺失 |
| mac Antigravity | null | 缺失 | 缺失 |
| grok-cloud Codex | 周窗口 used_percent | 今日、5h、每日、输出 | 缺失 |
| grok-cloud Claude | 缺百分比，需手动额度 | 今日、5h、每日、输出 | 缺失 |
| grok-cloud Antigravity | 两模型组，各周/5h 窗口 | usage 响应无 token | 缺失 |
| Grok | 云端文件无 grok 节点 | 缺失 | 缺失 |
| manual | 空对象，无任何池 | 缺失 | 缺失 |

Codex/Claude 的 observed_at 可早于采集时间数天。快照发布不等于额度观测更新。
Antigravity 的现有 usage 接口只有比例，不能从百分比推算 token。
Grok 无实际用量输入，不能把云端 Codex 的 token 当成 Grok。

## 证据与验收状态

- 历史 Mac 连续区间：2026-10-20 01:15:24 至 02:15:43 UTC，6 个间隔，最大 604 秒，均小于 30 分钟。
- 这是历史提交观察，不是本次连续实时观察一小时；实时验收尚未完成。
- Mac 最新采集到提交差约 -4.74 秒，疑似时钟偏差；云端约 3.31 秒。不能据此证明 Pages/raw CDN 上线延迟。
- 三份实际数据的路径、邮箱及 host 字段扫描通过。新发布器递归构造允许字段，舍弃账号、主机及未知字段；未知来源/模型组拒绝发布。
- 文件级 updated_at 修复已在仓库脚本实现，但尚未部署到运行中的任务，线上三份文件仍缺字段。
- Antigravity/Grok 实际 token 补采、Claude/Grok 手动百分比、实时一小时观测和上线延迟验收仍未满足。

## 部署与复核

`scripts/quota-collect`、`scripts/quota-publish`、`scripts/quota_schema.py` 与 `scripts/provider_usage.py` 必须放在同一运行目录。
保留既有 `quota-set` 入口，设置 `QUOTA_MACHINE=mac` 或 `grok-cloud`；Antigravity 仍需原有登录和显式启用。
本次只修改工作仓库，不修改外部 ops 或 Mac 定时任务，不 push data 分支。
上线需由运行环境部署这些脚本，并确认每十分钟执行发布器；不要只运行带去重的 `collect --save`。
手动命令支持 `quota-publish set grok 20 2026-11-01 12345`，末参数为今日实际 token 数；省略则为未知。此示例仅说明语法，不是实际数据。实际 token 来源仍需确认和接入。

复核命令：

```sh
python3 -m unittest discover -s tests -v
node tests/dashboard.test.cjs
python3 scripts/audit-data.py --ref origin/data
```

发布后至少实时观察一小时，按 `data/mac.json` 自身提交计算间隔，不能用云端提交填补 Mac 缺口。
同时轮询线上 JSON，记录首次可读时间减去 collected_at；校正时钟后每次应 ≤1800 秒。
实际未知指标应持续显示不可用，不得以本次发布心跳覆盖旧的额度观测时间。
