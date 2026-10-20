# Agent 额度监控

个人用的 AI Agent 额度与 token 用量面板，由 GitHub Pages 发布。

- `main` 分支：面板网页。
- `data` 分支：额度快照，由作者的 Mac 每 10 分钟、云电脑每次执行任务后推送；手动额度用 `quota-set` 更新。

面板中的 ChatGPT、Codex、Claude、Grok、Antigravity 图标为各自所有者的商标，仅用于标识对应服务。

## 前端数据模块

`frontend/quota-data.mjs` 是无依赖浏览器 ES module，导入不会启动网络请求或计时器：

```html
<script type="module">
  import { loadQuota, startQuotaRefresh } from './frontend/quota-data.mjs';
  const initial = await loadQuota();
  console.log(initial);
  const stop = startQuotaRefresh(({ pools, totalTokens, updatedAt, staleLevel, errors }) => {
    // 使用这些字段渲染仪表盘；errors[].message 可直接展示失败提示。
    console.log({ pools, totalTokens, updatedAt, staleLevel, errors });
  });
  // 组件卸载时调用 stop()，移除计时器和 visibilitychange 监听。
</script>
```

- `loadQuota()` 并行读取 data 分支 raw 地址的 `data/mac.json`、`data/grok-cloud.json`、`manual.json`。manual 根路径返回 404 时兼容 `data/manual.json`。每次请求有独立防缓存参数及 `cache: no-store`，15 秒超时。
- 返回 `{ pools, totalTokens, updatedAt, staleLevel, errors }`；`createQuotaLoader({ fetch, now, baseUrl, timeoutMs })` 可创建独立缓存实例。缓存仅保存在当前模块实例内，不跨页面重载。
- 池保留协议中的字段，`id` 加来源前缀，附带 `source` 和 `staleLevel`。兼容旧版 windows/buckets、tokens_today 与手动 used_percent；未知比例、token 和时间保持 null。
- `totalTokens` 是所有来源已知的**当日记录 token**之和，非余额或计费总量。新协议仅计 `tokens_period: today`，`provider-source` 同来源同 provider 的多窗口只计一次；跨来源按独立采集日志相加，若上游日志重复仍会重复计数。未知 token 不计入合计，0 表示已知合计为零，不代表所有池都有记录。
- `updatedAt` 为最老的来源快照时间，任一来源无时间时为 null；过期状态同时检查文件心跳和池实际观测时间，避免新发布掩盖旧读数。`fresh` 为不超过 30 分钟，`warning` 为超过 30 分钟（黄），`critical` 为超过 60 分钟或时间未知（红）。每池也有独立过期状态。
- 拉取或解析失败保留该来源上次成功数据，其时间不变；`errors` 返回来源和提示，恢复成功后清除。其余来源仍更新。并发调用合并请求。
- 另返回 `sources[]`：每个来源的 `{ source, loaded, updatedAt, staleLevel, failed }`，供页面分别展示 Mac / 云电脑的更新时间。
- `startQuotaRefresh(onUpdate)` 立即加载、每 5 分钟刷新、页面回前台立刻刷新；返回清理函数，可选 `onError` 处理消费者回调异常。

## 仪表盘页面

`index.html` 是环形图仪表盘（卡 04 定稿）：纯 SVG 环形图，无第三方库；`frontend/dashboard-model.mjs` 是不碰 DOM 的视图模型（按 provider 合并成卡片、K/M/B 缩写、相对时间、顶栏过期状态）。

- 每池一张卡：官方 logo（`assets/logos/*-dark.svg`）、环形图（已用 / 剩余可切换，按 60/80 分级着色，80% 警戒刻度）、今日 token。数字悬停、长按、点按或键盘聚焦显示精确值。
- 合计区：今日 token 全部合计（等于各卡相加，不一致时控制台告警）、占比环、近 7 天堆叠柱。
- 顶栏：上次更新（相对时间 + 绝对时间）与过期状态（>30 分钟黄、>60 分钟红）；断网、拉取失败、数据过期时显示提示条，保留上次数据，不白屏。
- `prefers-reduced-motion: reduce` 时环形图不做过渡动画。
- 本地验证：在仓库根目录起静态服务器（如 `python3 -m http.server 8000`）。默认读 data 分支；加 `?base=./相对目录/` 可读同源本地 JSON（目录下放 `data/mac.json`、`data/grok-cloud.json`、`manual.json`），只接受相对路径。

运行本地假数据测试（Node 20+，无安装依赖）：

```sh
node --test tests/
```
