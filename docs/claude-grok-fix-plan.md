# Claude / Grok 修复计划

依据：任务卡 01，修复 agent-quota 的数据源和页面；仅修改 card-01 文件，不提交、不推送、不切分支。

## 证据与方案

`origin/data` 中 Claude 有日志 token，但没有百分比；manual 是空对象；云端文件没有 Grok 节点。
页面 Claude/Grok 只读取 manual；Grok 没有 token 系列。发布器把 Claude/Grok 的百分比写入 pools 却丢弃兼容节点。
本机 Grok Build 实际存在 `sessions/*/*/usage.json`（按轮增量）及旧版 `updates.jsonl`（turn_completed usage）。

保留 Python 标准库和原有静态页面，增加只读账户额度查询，并使用日志记录的 token。
仅修文案不能补齐数据；从 token 估算订阅百分比没有可靠分母，因此不采用。
自动额度与手动额度选择较新观测；同账户额度不跨机器相加。日志 token 与额度观测时间分开。
请求失败/未登录/未知结构保持未知，不伪造零；认证材料和原始响应不进入公开文件。

## 执行与验证

- [x] 数据源：先编写失败测试，再新增 `scripts/provider_usage.py`，接入 `quota-collect`。
  验证 Claude 新旧额度结构、Grok 新旧账期结构、零值、缺失值、超时、认证失效、日志去重、缓存不重复计算。
- [x] 发布：修复 `quota_schema.py` 保留兼容额度及窗口、状态和独立时间；白名单继续排除私密字段。
- [x] 页面：测试后修复 `index.html` 的自动额度选择、Grok token、北京时间跨日、手动回退、过期/缺失提示。
  使用 Node 内置测试运行真实页面脚本。浏览器桌面/手机实测未完成：Chrome 与 Chromium 因沙箱 socket 权限均无法启动。
- [x] 交付：更新部署文档，运行 Python 与 Node 回归、采集到发布的集成验证和页面脚本测试、diff 检查。

验证记录：Python 20/20、Node 10/10；独立审查发现 HTTP 响应提前断连会阻断整轮采集，
已用 IncompleteRead 失败测试复现，捕获 HTTPException 后通过；没有提交或部署。

## 重点边界

真实零与缺数据不同；额度查询成功不代表本地 token 观测更新；旧 snapshot 不能把昨日 token 标成今日；
Grok usage.json 与 updates.jsonl 同时存在时不能双计；一个服务失败不能阻断其他服务发布。
当前沙箱外网代理不可连接，不能声称完成线上部署或实时账户验证。
