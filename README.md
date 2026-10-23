# Agent 额度监控

个人用的 AI Agent 额度与 token 用量面板，由 GitHub Pages 发布。

- `main` 分支：面板网页。
- `data` 分支：额度快照，由作者的 Mac 每 10 分钟、云电脑每次执行任务后推送；手动额度用 `quota-set` 更新。

Claude / Grok 支持通过采集设备已有订阅登录只读查询额度；Claude Code / Grok Build 日志用于 token 统计。
页面分别显示自动/手动读数、过期和登录状态。缺少额度百分比时仍展示已记录 token，不从 token 推算额度。

采集、部署、手动回退及验证见 [Claude / Grok 数据接入](docs/claude-grok-operations.md)。

面板中的 ChatGPT、Codex、Claude、Grok、Antigravity 图标为各自所有者的商标，仅用于标识对应服务。
