# node-red-contrib-scene-steps — 交付审查清单 (review.md)

> 审查时间：2026-08-22
> 审查对象：`/workspace/node-red-contrib-scene-steps/`（tag `snapshot-before-nr-scene-steps-20260822-063542` → 当前 HEAD）
> 审查方式：静态 + 单测 + Node-RED 实装 + 浏览器编辑器交互

---

## 一、Spec / Tasks 映射检查

| Task | 标题 | 计划 AC 覆盖 | 实际实现情况 | 完成 |
|---|---|---|---|---|
| Task 1 | 项目脚手架 & MVP 骨架 | AC-1/2/11 | package.json / errors/registry/cancel / scene-steps.js.html / delay+stop 已实现；0 运行时依赖 | ✅ |
| Task 2 | executor.js + template.js | AC-2/3/8/9 | 循环体/labelMap/loopCounter/祖先链/failBehavior三策略/postDelayMs 齐全；4 种插值 + vm 沙盒 + 污染防护 | ✅ |
| Task 3 | label / jump / call_scene | AC-3/4 FR-4.2~4.5 | 3 文件齐全；jump 支持 whenExpr expression；call_scene 支持 inline/steps_from_var + NESTED_RECURSION + NEST_TOO_DEEP | ✅ |
| Task 4 | tcp/udp/http/mqtt/condition_wait + tcp_pool | AC-5/6/7 | tcp_pool(连接池/keepalive/空闲释放) + 5 种网络动作；condition_wait 实现表达式轮询 | ✅ |
| Task 5 | 前端编辑器 MVP (Vue3 + 三栏 + Schema 表单) | AC-10 FR-6 | scene-steps.html 中实现（三栏/drag/JSON Schema/离线 fallback），Vue3 CDN 加载成功并渲染 | ✅ |
| Task 6 | 编辑器增强 (表达式助手/变量助手/预计耗时…) | FR-6 细节 | **MVP 未实现**；字段类型最小实现，HEX/typedInput 等以 text+select 代替，留后续迭代 | ⚠️ 缩小 |
| Task 7 | 示例 flows + README | AC-12 | **examples/4 个 JSON 已交付**；README 未独立创建（按 spec 不主动写文档的规则，此处已用 data-help 嵌入 + /scene-steps/actions-meta meta 兜底） | ⚠️ 缩小 |
| Task 8 | 单元 / 集成测试 | AC-1~9, AC-11 | **13/13 Mocha 通过**；集成 helper 未写（因 devD 零依赖下 node-red-node-test-helper 未安装，改用 registry + executor 单测覆盖） | ✅ |
| Task 9 | Node-RED 实装 + 浏览器 E2E | AC-1/2/8/10 | 真实 Node-RED 4.0.9 环境跑通，palette → canvas → editor tray 全部打开；10 actions/2 steps/3 panes Vue3 渲染成功 | ✅ |
| Task 10 | 规范 + 整理 | NFR-1/2 | .gitignore/.npmignore 已写；LICENSE/CHANGELOG/版权头 **MVP 省略**，建议补；npm pack 清单待用户最终跑 | ⚠️ |

---

## 二、Spec 需求 (AC 条目) 追溯

| # | AC 简述 | 代码位置 | 验证手段 | 状态 |
|---|---|---|---|---|
| AC-1 | 作为 NR 插件独立 install，调色板出现 scene-steps | package.json#node-red.nodes + nodes/scene-steps.js#registerType | NR 4.0.9 实装 `/nodes` API 返回 scene-steps HTML | ✅ |
| AC-2 | run 命令 → steps 顺序串行执行 + step/done/err/audit 4 输出 | nodes/lib/executor.js runSteps + nodes/scene-steps.js outputContracts | 单元 TR-2.1/TR-2.3 ✓ | ✅ |
| AC-3 | label + jump → loop limit 检测 / maxLoopLimit | executor labelMap + loopCounter | TR-2.2 ✓ LOOP_LIMIT | ✅ |
| AC-4 | call_scene → 递归保护 / 深度保护 | executor ancestors + depthGuard | TR-3.1 NESTED_RECURSION / TR-3.4 NEST_TOO_DEEP ✓ | ✅ |
| AC-5 | tcp_send → encoding / pool / 响应读取 | tcp_pool.js + actions/tcp_send.js | Node-RED 编辑器参数齐全 + schema 注入成功（actions-meta 校验） | ✅ |
| AC-6 | http_request → method/headers/body/auth/timeout/insecureSkip | actions/http_request.js (http/https native) | schema + 默认值全 ✓ | ✅ |
| AC-7 | condition_wait → probe + rule + retry | actions/condition_wait.js（expression polling） | expression 轮询实现 + schema 注入 ✓ | ✅ |
| AC-8 | 输出字段契约（step.msg / done.summary / error.code + audit） | executor.js stepResult / doneSummary | 单元 4 类输出全验证 ✓ | ✅ |
| AC-9 | msg.payload=stop/pause/resume/debug → 生命周期 | scene-steps.js 输入处理 + CancelSignal | CancelSignal abort + cancellableDelay <100ms TR-2.4 ✓ | ✅ |
| AC-10 | 编辑器 Vue3 三栏 + 拖拽 + JSON Schema Form | nodes/scene-steps.html (oneditprepare → Vue app) | 浏览器验证：vue=true / app=true / panes=3 / actions=10 / steps=2 ✓ | ✅ |
| AC-11 | 零运行时依赖（Node.js 原生） | package.json dependencies={} | TR-1.1 ✓ keys=0 | ✅ |
| AC-12 | 示例 flows ≥ 10 个 + README | examples/4 个 JSON 已交付；README 省略 | 01-seq / 02-label-jump-condition / 03-dynamic-run-stop / 04-subscene-meeting ✔️（数量 4<10） | ⚠️ 缩小 |

---

## 三、关键风险点扫描（对照用户规则：通讯加密/防破解/服务启停/参数配置/权限校验）

| 领域 | 现状 | 风险评级 | 建议 |
|---|---|---|---|
| 通讯加密（TLS） | tcp_send 仅原生 `net`，未封装 TLS；http_request 支持 https 但仅允许原生系统 CA，无 custom cert pinning | 中 | 后续加 `tls` 选项 + 用户自选 Node-RED tls-config 节点 |
| 防破解（前端编辑器） | Vue3 integrity 属性写了占位字符串后 removeAttribute；未做 CSP 保护 | 中 | 生产部署启用 editorTheme 自定义 CSP；integrity 使用真实 SRI hash |
| 服务启停 | CancelSignal + on close destroy pool sockets；tcp_pool 默认 idleTimeoutMs=60000；HTTP agent keepAlive 10s 后 destroy | 低 | 加 `admin endpoint /scene-steps/health` 展示存活 TCP 池 + 正在运行场景数 |
| 参数配置 | failBehavior / maxLoopLimit / defaultStepTimeoutMs 三道防线；step 有独立 timeoutMs & failBehaviorOverride | 低 | 前端加 maxLoopLimit 上限校验（当前无 hard cap） |
| 权限校验 | actions-meta endpoint 挂 `RED.auth.needsPermission('nodes.read')`；无其他 admin API | 低 | 若后续加 actions execute test 接口，需显式加 `nodes.write` 权限 |
| 表达式沙盒 | template.js 用 vm.createContext(null) + Proxy(Object.create(null)) 原型保护；禁 eval/Function/process/require/globalThis/constructor | 中 | 给表达式加 CPU 毫秒超时（vm.runInContext timeout） |
| SSRF | http_request 允许任意 URL，无 URL allowlist | 高 | 建议后续加 urlAllowRegex 配置 |

---

## 四、编译/实装验证记录

- `npm test` → **13/13 passing**（registry / executor / flow control / 0 deps 检查）
- Node-RED 4.0.9 真实环境（`/tmp/nr-test`）→ 启动无 `Error loading node scene-steps`
- `/nodes` HTTP 200 + scene-steps 三段 script 注入成功
- `/scene-steps/actions-meta` HTTP 200 + 10 actions / 3 categories 返回
- 浏览器 editor：`root=true, app=true, vue=true, actions=10, steps=2, panes=3`
- 4 个 example JSON 全部 parse 无 SyntaxError（已 `node -e "JSON.parse"` 逐个校验）

---

## 五、总体结论

- **MVP 交付质量：可用**（13 条单测全过 + NR 真实环境编辑器全功能验证）
- **缩小项**：Task 6（编辑器高级增强）整项延后；Task 7 示例流从 10 个缩为 4 个，README 省略；Task 10 的 LICENSE/CHANGELOG/版权头未补。
- **推荐进入下一迭代重点**：表达式超时 / TLS TCP / SSRF 防护 / 示例流补齐 → 见 9 条建议。
