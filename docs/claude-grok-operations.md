# Claude / Grok 数据接入与复核

## 故障原因

本次检查 `origin/data`：Claude 已有 token 记录，但没有百分比；`manual.json` 是 `{}`；
`grok-cloud.json` 只有 Codex、Claude、Antigravity，文件名不代表 Grok 记录。
页面原来只从 manual 取 Claude/Grok 百分比，不读取自动节点，也不展示 Grok token。
发布白名单原来还会丢失 Claude/Grok 兼容节点中的百分比。

## 采集来源

| 服务 | 订阅额度 | 本地 token |
| --- | --- | --- |
| Claude | `GET https://api.anthropic.com/api/oauth/usage`，已有 OAuth 登录 | `CLAUDE_CONFIG_DIR/projects/**/*.jsonl`，包含 subagents |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`，已有订阅登录 | `GROK_HOME/sessions/*/*/usage.json` 的逐轮增量；旧版回退 `updates.jsonl` 的 `turn_completed.usage` |

Claude 支持旧版 `seven_day/five_hour.utilization` 和新版 `limits[].kind/percent`。
只选整体周额度及会话额度，不把模型专属额度混入整体周额度。
Grok 优先使用 `config.creditUsagePercent/currentPeriod.end`，兼容旧 `monthlyLimit/used/billingPeriodEnd`。
Grok 完整 token 已包含缓存和 reasoning 子集，不再额外加一次；同目录两种日志不双计。

接口是客户端使用的内部接口，字段可能变化；空响应不会当作 0%。依据：
[Grok 客户端 billing 实现](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs)、
[Grok 逐轮 usage 格式](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/usage_file.rs)、
[Claude usage 接口反馈](https://github.com/anthropics/claude-code/issues/31637)。

Claude 默认从 `~/.claude/.credentials.json` 读取，Mac 缺少文件时读取 `Claude Code-credentials` 钥匙串；
也支持已有 `CLAUDE_CODE_OAUTH_TOKEN`。Grok 默认读取 `~/.grok/auth.json` 的唯一第一方订阅登录；
API key 不代表 SuperGrok 订阅，不用于本查询。多个订阅登录时不猜测账户。
配置目录可通过 `CLAUDE_CONFIG_DIR`、`GROK_HOME` 指定。

没有模型调用，不发送 `/usage` 提示词，不打开浏览器、不刷新令牌、不修改登录文件。
每个网络请求超时 15 秒，只请求一次。令牌只在采集进程内使用，公开文件仅保留白名单字段。

## 部署现有采集任务

页面合并发布只能更新前端，不能更新 Mac/云电脑上 `quota-publish` 指向的旧脚本。
运行环境需把以下四个文件部署到同一个真实目录（若入口是软链接，应更新软链接实际指向的目录）：

```text
scripts/quota-collect
scripts/quota-publish
scripts/quota_schema.py
scripts/provider_usage.py
```

例如现有云电脑入口指向 `ai-studio/ops`，四个文件应一起更新到该目录，保留 `quota-set` 指向
`quota-publish` 的软链接。不要只更新网页或单独复制 `quota-collect`。

在运行账号的终端执行只读本地验证（不会推送）：

```sh
QUOTA_MACHINE=grok-cloud python3 scripts/quota-collect > /tmp/quota-check.json
python3 -c 'import json; d=json.load(open("/tmp/quota-check.json")); print({k:{f:(d.get(k) or {}).get(f) for f in ("quota_status","used_percent","tokens_today")} for k in ("claude","grok")})'
```

Mac 使用 `QUOTA_MACHINE=mac`。保留原有发布频率（Mac 每 10 分钟、云电脑任务后）。
部署后由运行任务执行 `quota-publish`，检查 data 分支对应 JSON 中的 provider 节点，再刷新网页。
前端通过 main 的数据模块每五分钟读取一次 raw JSON，回到前台立即刷新；文件 `collected_at` 是心跳，额度以 `quota_observed_at` 为准，token 过期判断独立使用 `tokens_observed_at`。

## 状态与恢复

| quota_status | 页面提示 | 恢复动作 |
| --- | --- | --- |
| available | 自动采集 | 无需处理；超过 30 分钟标为数据过期 |
| not_configured | 待登录采集 | 在采集设备的运行账号登录 Claude / Grok，核对配置目录 |
| auth_required | 登录已失效 | 在采集设备重新登录，等待下一轮 |
| request_failed | 额度读取失败 | 检查运行环境网络/代理，下一轮重试 |
| rate_limited | 接口限流 | 降低外部重复查询频率，等待下一轮 |
| unsupported | 额度暂不可读 | 检查客户端接口是否变化；可按真实读数手动回退 |

前端取 Mac、云端和手动读数中较新的有效额度，已结束周期不继续作为本周期百分比。
旧读数保留时间和过期提示；没有百分比时 token 仍独立显示。
手动更新方式（下列数值仅为命令示例，不是实际用量）：

```sh
quota-publish set claude 20 2026-11-01
quota-publish set grok 30 2026-11-01 12345
```

第四个参数是记录当天的实际 token，可选。仅在记录的北京时间当天参与今日统计，自动 token 可用时优先。
没有日志时 token 是未知；有七天内日志、当天无调用时今日可以是实际的 0。
本地 Code/Build token 不包括所有 App/Bot 用量；多设备复制同一日志时不应同时发布，两端统计仍会相加。

## 本次验证与限制

```sh
python3 -m unittest discover -s tests -v
for test_file in tests/*.test.*; do
  node "$test_file" || exit 1
done
git diff --check
```

测试覆盖采集、发布白名单、真实页面脚本，包括零值、旧格式、窗口选择、手动回退、过期、跨日及隐私。
真实本机采集能读出 Claude token；额度请求因沙箱代理不可连接返回 `request_failed`。
本机 Grok 登录已过期，返回 `auth_required`；现存 Grok 日志超出七天统计窗口，未伪造本周 token。
Chrome/Chromium 在此沙箱均因 socket 权限无法启动，未完成浏览器截图/布局实测。

本次仅修改仓库文件，没有提交、推送、修改外部 ops/定时任务或线上数据。
线上验收仍需部署四个脚本、恢复有效登录，并在网页核对真实额度及重置时间；当前不能声称线上已恢复。
