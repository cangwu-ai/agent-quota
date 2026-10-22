# Frontend quota data layer implementation plan

Goal: 完成任务卡 02 的纯前端读取、统一池、token 合计、过期判断和刷新生命周期。
Architecture: 无依赖 ES module；工厂隔离每个消费者的缓存，默认实例导出 loadQuota；支持 card-01 pools 协议及旧 UI 字段。
Spec: 任务卡 02-frontend-data-layer.md；接口兼容 card-01 docs/data-schema.md。

- [x] 本地 JSON fixtures + Node 内置测试：今日合计、多窗口去重、30/60 分钟边界、缺文件、缓存保留、坏 JSON、旧协议。
- [x] 实现 frontend/quota-data.mjs：loadQuota 返回 pools/totalTokens/updatedAt/staleLevel，并附 errors 提示；原始地址使用 cache:no-store 与每次变化参数。
- [x] 实现 startQuotaRefresh：立即加载、300000ms 定时、回前台刷新、可清理、请求合并；假时钟与 EventTarget 验证。
- [x] README 记录浏览器接入和指标语义；执行所有测试、diff 检查并提交 card-02。

Review focus: 缺失时间不得新鲜；池时间不能被文件心跳覆盖；manual 根目录优先且仅 404 兼容旧路径；未知 token 为 null；一个来源多个窗口不可重复合计。

Validation: node tests/quota-data.test.mjs，15/15；node --test tests/quota-data.test.mjs 通过；node --check 与 git diff --check 通过。Python discover 未发现测试（原有目录仅含 pycache）。独立审查发现文件心跳未知被池时间覆盖，已增加失败回归并修复。
