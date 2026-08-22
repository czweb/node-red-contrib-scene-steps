# node-red-contrib-scene-steps - 产品需求规格

## Overview
- **Summary**: 一个完全独立的 Node-RED 插件（npm 包），提供 "Scene Steps" 单一主节点，把一串**按顺序执行的任务步骤**（延时、TCP/UDP 发送、HTTP 请求、MQTT 发布、条件等待、标签、跳转、停止、嵌套子场景）放进一个节点里，用**任务列表编辑器（拖拽排序 + JSON Schema 表单）**可视化管理，取代 Node-RED 用户用 `split + delay(rate-limit) + flush + switch` 十多个节点+几十条连线表达"线性步骤场景"的连线地狱模式。
- **Purpose**: 解决中控/工业集成场景中"80% 流程都是严格先后顺序 + 每步独立延时/重试/跳转"的用户痛点，让"投影机开机 → 等 30 秒 → 发 TCP → 等响应 → 再 HTTP → 条件不满足循环重试"这样的场景只需 1 个节点、5 行步骤配置。
- **Target Users**: 中控工程师、IoT/工业集成工程师、任何嫌 Node-RED 顺序任务连线太乱的用户。

## Goals
1. 一个 Node-RED 自定义节点 `scene-steps` 承载完整的场景步骤；
2. 节点配置对话框内置完整的步骤任务列表编辑器（非原生三四个输入框）；
3. 动作插件化，MVP 内置 10 种动作：delay / label / jump / stop / call_scene（子场景） / tcp_send / udp_send / http_request / mqtt_publish / condition_wait（条件等待）；
4. 运行时 0 npm 依赖（只用 Node.js 原生 net/dgram/http/https/events/vm/timers）；
5. 完美融入 Node-RED 生态：节点输入 msg.payload 动态触发、4 输出口（Step/Done/Error/Audit）、共享 MQTT/TLS Config Node、上下文/credentials/flow context 兼容、redeploy 时正确清理句柄。

## Non-Goals
1. 不开发任何与现有中控项目（xczk/zk/网关）相关的功能或对接；
2. Phase 1 MVP 不包含 Sidebar 插件、Scene Library Config、Scene Trigger；Phase 2 再考虑；
3. Phase 1 MVP 不包含串口 serial 动作（引入 serialport 有 native binding 安装失败风险）；
4. 不造轮子：不自己写 MQTT client、WebSocket client；直接复用 Node-RED 内置 Config Node；
5. 不做流程 Designer 替代画布：不试图取代 Node-RED 主画布连线，场景外仍可自由连线；
6. 不做多租户 / RBAC（Phase 1 MVP）；Node-RED adminAuth 之外的权限管理 Phase 2 迭代。

## Background & Context
- Node-RED 社区对"顺序任务 + 每步不同延时"的吐槽是 perennial 高频话题，社区典型解决方案是 `split + delay(rate-limit mode) + flush` hack，对新手极不友好，且无法实现"第 3 步失败后从第 1 步重试 5 次"、"条件不满足循环跳转"等场景；
- 现存插件：`node-red-contrib-sequencer`（2016 停更，无 UI，纯 JSON 数据回放）/`node-red-contrib-message-sequencer`（2018 停更，录制/回放）/`smart-nodes`（场景=灯/窗帘预设值，非步骤）均不满足"步骤任务列表"需求；
- 项目完全独立，新建目录 `/workspace/node-red-contrib-scene-steps/`，不依赖 `/workspace` 现有任何代码。

## Functional Requirements

### FR-1 节点注册与 Node-RED 集成
- 插件通过标准 npm 包 `package.json["node-red"]["nodes"]` 声明注册；
- 节点类型名为 `scene-steps`，分类在 `palette` 的 `function` 或新建 `scene` 分类；
- 1 个输入端口，4 个输出端口（Step / Done / Error / Audit）。

### FR-2 输入命令
支持通过 `msg.payload` 命令控制：
- `"run"`（默认或省略）：按 steps 配置开始执行；
- `"stop"`：立即停止当前正在运行的场景（取消延时/取消 TCP 连接）；
- `"pause"` / `"resume"`：暂停与继续；
- `"debug"`：返回配置+运行状态JSON（不执行）；
- `Array of steps`：动态覆盖步骤数组执行；
- `{sceneName:string, payload:"runByName"}`：预留 Library Config 接口，MVP 只输出 error。

### FR-3 输出端口消息契约
- **输出① Step**：每步执行完成后发一条，`{topic:"scene:step", stepIndex, stepId, stepType, stepLabel, status:"ok"|"error"|"skip", input:any, output:any, durationMs, vars:{}, _runId}`；
- **输出② Done**：场景自然结束/全跳过时发一条，`{topic:"scene:done", okCount, skipCount, errorCount, totalDurationMs, vars:{}, history:[...] , _runId}`；
- **输出③ Error**：场景因错误中止时发一条，`{topic:"scene:error", stepIndex, stepType, errorCode, errorMessage, recoverable:boolean, _runId}`；
- **输出④ Audit**：生命周期事件 `{topic:"scene:audit", event:"start"|"finish"|"cancelled"|"step"|"paused", ts, _runId}`。

### FR-4 步骤类型（MVP 10 个）
每个动作插件实现统一接口：`{ type, category, icon, label, configSchema, defaults, validate(config), async execute(ctx) }`

#### 流控动作
- FR-4.1 `delay`：延时等待 `delayMs`；支持 `jitter` 浮动范围；
- FR-4.2 `label`：纯占位 `name`，作为 jump 的跳转目标（预处理阶段建立 labelMap）；
- FR-4.3 `jump`：跳到指定标签；`max` 参数限制跳转次数（防死循环）；可选 `whenExpr` 条件表达式，为真才跳；
- FR-4.4 `stop`：立即终止；可选 `emitAsDone=true/false` 决定从 Done 还是 Error 口吐；
- FR-4.5 `call_scene`：嵌套执行子场景；两种模式：`inline_steps`（直接嵌套 steps 数组）或 `stepsFromVar`（`vars.xxx`）；祖先链防止循环调用（A→B→A）；嵌套深度>10 报错。

#### 网络动作
- FR-4.6 `tcp_send`：向 host:port 发送文本/HEX/Base64 格式 data；支持 `waitResponseMs` 等响应；支持 `poolKey` 场景内复用 socket；
- FR-4.7 `udp_send`：发送 UDP 包；支持 broadcast flag / bindLocalAddr / ttl；
- FR-4.8 `http_request`：发起 HTTP(S) 请求；method/headers/body/timeout/expectStatus/authBasic/bearer 支持；
- FR-4.9 `mqtt_publish`：通过 Node-RED 内置 `mqtt-broker` Config Node（RED.nodes.getNode(brokerId)）发布消息；qos/retain；
- FR-4.10 `condition_wait`：⭐ 核心——周期 probe（tcp/udp/http 发送）+ 响应匹配规则（contains/equals/regex/jsonPath）+ 超时/重试/超时跳转。

### FR-5 执行器运行时行为
- while 循环索引支持 jump 改变（非 for i++）；
- 支持失败策略 `failBehavior: stop | skip | retry:<n>`（节点级）+ `failBehaviorOverride`（步骤级覆盖）；
- 每步 `postDelayMs` 支持"执行完本步后延时"；
- 取消令牌：`msg.payload="stop"` 或 redeploy `on("close")` 时立刻 set cancelled；
- 变量表：`state.vars` 持久化输入 `msg.vars`、上一步 output 结果；步骤配置模板支持 `{{vars.x}}` / `{{input}}` / `{{outputs[-1].field}}` / `{{env.ENV_VAR}}` 插值。

### FR-6 前端编辑器 UI
- 双击节点后打开标准 Node-RED 编辑对话框，内嵌一个步骤列表：
  - **左栏 Palette**：10 种动作卡片，按分类分组，搜索/双击/拖拽可添加；
  - **中栏 StepList**：步骤行，显示序号/图标/类型名/摘要/延时；支持：拖拽排序（SortableJS）、hover 行显示 ⊕插入/📋复制/✕删除按钮、批量多选移动删除包裹子场景、顶栏显示预计总耗时；
  - **右栏 ConfigForm**：选中步骤后按 JSON Schema 动态渲染表单；基础字段类型：text / number / select / boolean / textarea / hex / encoding-select。
- **顶栏场景元数据**：场景名字段、失败策略下拉、maxLoopLimit、defaultStepTimeoutMs；
- **导入/导出 JSON**：复制粘贴 steps 数组；
- **Cancel / Done 按钮**：标准 Node-RED oneditcancel / oneditsave。

### FR-7 配置安全与 Node-RED credentials
- HTTP Basic password / MQTT broker password / 预共享密钥等敏感字段走 credentials 机制（HTML `type="password"` + JS `this.credentials`），不出现在导出的 flow JSON 中；
- 所有消息日志中 password/token/secret/key/authorization（case-insensitive match）字段自动替换为 `***`。

### FR-8 Redeploy / 生命周期
- `node.on("close", done)`：设置 `state.cancelled=true`、清所有定时器、销毁本节点内部创建的 TCP/UDP socket；不触碰共享 mqtt-broker 的连接；等待最多 3s 超时后强制 `done()`。

## Non-Functional Requirements
- **NFR-1 零运行时依赖**：`package.json` 的 `dependencies` 字段必须为空（所有动作只用 Node.js 原生模块）；
- **NFR-2 可安装性**：Node 18 LTS / 20 / 22 / 24 下，`cd ~/.node-red && npm install /path/to/plugin` 100% 成功，无 native build error；
- **NFR-3 编辑器零额外网络请求**：前端编辑器所需 Vue 3 / SortableJS 全部 esbuild 打包成单个 IIFE bundle，内嵌进 HTML；运行时不向 CDN 发请求（避免离线/内网/断网环境无法使用）；
- **NFR-4 主题兼容**：编辑器 CSS 变量对齐 Node-RED 内置 `--red-ui-*` CSS vars，Node-RED v5 暗色主题下文字可读、对比充足；
- **NFR-5 性能**：50 步线性场景（每步 0 delay）连续执行 1000 轮无内存泄漏（RSS 增长<5%）；
- **NFR-6 取消令牌响应**：`msg.payload="stop"` 发出后 100ms 内场景必须进入 cancelled 状态（延时步骤立刻返回，TCP 步骤在当前 socket 读写完成后立刻退出）。

## Constraints
- **Technical Constraints**:
  1. 运行时必须兼容 Node-RED 3.1.0 及以上、Node.js >=18；
  2. 运行时 `dependencies` 必须为 `{}`，0 npm 包；
  3. MQTT 动作必须且只能通过 `RED.nodes.getNode(brokerId)` 复用 Node-RED 内置 `mqtt-broker` config 节点，不自己装 mqtt 包；
  4. 前端编辑器 HTML 文件必须通过 `node-red-test-helper` 能正确加载（符合 `<script type="text/html" data-template-name=...>`、`<script type="text/javascript">` 的三段式结构）。
- **Business Constraints**:
  1. 项目完全独立，不依赖 /workspace 现有任何代码；
  2. 全中文 UI + 中文 README；英文 README 可选；
- **Dependencies**:
  1. DevDeps 允许使用：`node-red`, `node-red-node-test-helper`, `mocha`, `esbuild`, `vue@3`, `sortablejs`。

## Assumptions
1. 用户本机 Node-RED 已正确安装并有基础使用经验；
2. MQTT 动作需要用户在画布上预先存在至少一个 `mqtt-broker` 配置节点；
3. Node-RED 默认的 `functionGlobalContext` / `contextStorage` 至少有默认 memory store。

## Acceptance Criteria

### AC-1: npm 可加载注册
- **Type**: `rule`
- **Given**: 一个空的 Node-RED userDir 工作目录，`npm install /workspace/node-red-contrib-scene-steps` 成功；
- **When**: 启动 Node-RED（`node-red-node-test-helper.load(testNode, flow)`）；
- **Then**: `helper.getNode("scene-steps")` 返回的类型存在于注册中心，`helper.registry.getNodeType("scene-steps")` 非空；
- **Pass Condition**: 无 "Error loading node" 类日志，节点类型注册成功；
- **Evidence**: `npm run test -- --grep "AC-1"` 通过 stdout。

### AC-2: delay + stop 最小场景跑通
- **Type**: `rule`
- **Given**: 配置 `steps=[{type:"delay", config:{delayMs:100}}, {type:"stop", config:{emitAsDone:true}}]` 的 scene-steps 节点；
- **When**: 注入 `msg.payload="run"`；
- **Then**: Done 输出口在 100ms±50ms 内收到 `topic:"scene:done"` 消息，`okCount == 1`；若在 delay 期间注入 stop，则 Audit 口收到 event="cancelled"；
- **Pass Condition**: 输出顺序、时序、字段值全匹配；
- **Evidence**: test/integration 场景用例通过断言。

### AC-3: 标签跳转与死循环保护
- **Type**: `rule`
- **Given**: 5 步场景，其中 step1=label(loop) step2=delay(10) step3=jump(target=loop,max=3) step4=delay(10) step5=stop；
- **When**: 触发 run；
- **Then**: step2 实际执行次数 = 4（1 初始 + 3 跳转），第 4 次命中 maxLoopLimit 后抛 `LOOP_LIMIT`，场景按 failBehavior 结束；
- **Pass Condition**: 历史记录中 delay(10) 出现 =4 次，最终 step 数 <= 场景配置 step 数；
- **Evidence**: executor.test.js "loop detection" 用例 passed。

### AC-4: call_scene 祖先链防 A→B→A
- **Type**: `rule`
- **Given**: 场景 A 的 step3 调用内联场景 B；B 的 step2 又调用内联场景 A（配置嵌套 A→B→A）；
- **When**: 触发 run；
- **Then**: 执行到第二次 call_scene(A) 时立刻抛 `NESTED_RECURSION` 错误；
- **Pass Condition**: Error 口输出 errorCode="NESTED_RECURSION"，且场景立即终止；
- **Evidence**: call_scene.test.js "recursion guard" passed。

### AC-5: tcp_send 正确发送并可等待响应（含 poolKey 复用）
- **Type**: `rule`
- **Given**: 本地 mock TCP server 监听 127.0.0.1:4455，收到 "PING" 立刻回复 "PONG"，100ms 内完成；
- **When**: 执行两个连续的 tcp_send 步骤（host=127.0.0.1 port=4455 data="PING" encoding="utf8" waitResponseMs=500 poolKey="same"）；
- **Then**: 两步骤 output.text 均等于 "PONG"，并且 mock server 记录的 accept 连接次数 =1（poolKey 复用成功，没有第二次握手）；
- **Pass Condition**: 连接数=1，两步骤都拿到响应；
- **Evidence**: tcp_send.test.js "pool reuse" + "echo roundtrip" 均 passed。

### AC-6: http_request 模板变量 + HTTPS + 状态码断言
- **Type**: `rule`
- **Given**: 本地 `https.createServer`（自签 cert）起 HTTPS 监听 4456，路径 /t/{{id}} 返回 200 且 `body={id}`；
- **When**: `msg.vars={id:"abc123"}` 触发场景，http_request 步骤配置 `url="https://127.0.0.1:4456/t/{{vars.id}}"`，`insecureHTTPParser=true`（关闭证书校验），`expectStatus="2xx"`；
- **Then**: http_request 步骤成功，`outputs[-1].data.id == "abc123"`；若把 expectStatus 改成 4xx，该步骤立刻抛 `HTTP_xxx`；
- **Pass Condition**: 正常路径断言通过；非 2xx 产生错误；
- **Evidence**: http_request.test.js "template + https" / "expect fail" 双用例 passed。

### AC-7: condition_wait 匹配+超时行为
- **Type**: `rule`
- **Given**: 本地 TCP 监听 4457，按次序响应前 2 次发送 "NO"，第 3 次响应 "OK"；
- **When**: condition_wait 步骤，probe TCP "CHK"，matchRule={type:"contains", value:"OK"}，intervalMs=30，retries=10，timeoutMs=5000；
- **Then**: 共触发 probe 次数 = 3，最终步骤 status=ok；若改 retries=2，则第 3 次重试后抛 CONDITION_TIMEOUT 并按 onTimeoutJumpTo 跳转；
- **Pass Condition**: 尝试次数精确匹配；超时分支跳转正确；
- **Evidence**: condition_wait.test.js "ok on 3rd" + "timeout after 2" passed。

### AC-8: 输入/输出消息契约正确性
- **Type**: `rule`
- **Given**: 3 步场景（delay 10 → delay 20 → delay 30）；
- **When**: 注入带 `msg.vars={x:1}` 的 run 命令；
- **Then**: 输出①收到 3 条 step 消息（stepIndex 0/1/2 顺序严格递增，无重复无缺失），最后输出② 1 条 done 消息（okCount=3, okCount+errorCount+skipCount==3），每步 vars 继承 `x:1`；
- **Pass Condition**: 每条消息 topic 正确；所有 step 消息先于 done 消息到达；
- **Evidence**: integration/scene_outputs_contract.test.js 时序断言 passed。

### AC-9: Redeploy 时无句柄泄漏 + 正确取消
- **Type**: `rule`
- **Given**: 运行一个 `delay(10000)` 的场景，已启动 100ms；
- **When**: node-red-node-test-helper 调用 `helper.unload()`（等价于 redeploy close）；
- **Then**: 场景在 close 钩子 3s 内返回 done，且 Node.js `process._getActiveHandles()` 中 scene 相关的 Timeout/TCP Handle 数量在 unload 前后不增加（net 增长=0）；
- **Pass Condition**: close 完成 < 3s，handle 差集为空；
- **Evidence**: lifecycle.test.js "no handle leak after unload" 使用 `async_hooks` / active handle 比较断言 passed。

### AC-10: 编辑器端到端可用性
- **Type**: `rubric`
- **Dimension**: 步骤编辑器交互流畅度 + 功能完整性
- **Scale**: 1-5
- **Anchors**:
  - 1 = 节点双击打开仍是简单输入框（无步骤列表 UI）；
  - 3 = 有步骤列表和 Palette，但：无法拖拽排序 / 无法批量选中 / 表单无法渲染所有字段类型（缺失 hex/select 等）；
  - 5 = Palette 搜索+分类分组 OK，步骤列表拖拽/插入/复制/删除全可用，JSON Schema 表单所有字段类型正确渲染，预计总耗时实时显示，JSON 导入导出往返无损，Cancel/Done 按钮工作；
- **Pass Threshold**: >= 4
- **Evidence**: 用 Playwright / Chrome DevTools MCP 对 UI 做手动交互验证 + 截图保存；不少于 8 个关键动作的交互路径截图（添加、删除、拖拽、排序、编辑 delay、编辑 TCP、导入 JSON、导出 JSON、点 Done 保存）。

### AC-11: 零运行时依赖 + 安装成功率
- **Type**: `rule`
- **Given**: `cat /workspace/node-red-contrib-scene-steps/package.json`；
- **When**: 检查字段 `dependencies`；
- **Then**: `dependencies` 字段不存在或等于 `{}`；
- **Pass Condition**: `JSON.parse(package.json).dependencies` 的 own keys 数量 == 0；
- **Evidence**: `node -e "console.log(Object.keys(require('./package.json').dependencies||{}).length)"` 在插件目录输出 0。

### AC-12: 示例 flow 10 个 + 文档
- **Type**: `rubric`
- **Dimension**: 示例和文档可用性（从 0 到第一个场景跑通的新手路径）
- **Scale**: 1-5
- **Anchors**:
  - 1 = 无 README，无 examples；
  - 3 = 有 README，仅有 1~2 个示例；
  - 5 = README 中文完整（安装步骤 / 所有 10 种动作说明 / 4 个输出口字段表 / 常见问题），examples 目录 >= 10 个示例 flow JSON，每个 flow 含 Inject+scene-steps+Debug，`Import` 到 Node-RED 即点即跑；
- **Pass Threshold**: >= 4
- **Evidence**: `ls examples/*.json | wc -l` >= 10；README.md 中文"快速开始"章节步骤完整，覆盖 npm install / import example / inject 按钮点击三步。

## Open Questions
- [ ] MQTT 动作：是否需要 QoS 2？（MVP 先做 QoS 0/1，够用） — **默认 MVP 仅 0/1**；
- [ ] call_scene 的 stepsFromVar 支持 msg.payload.sub_steps？（MVP 支持 inline_steps 即可，stepsFromVar 留 Phase 2） — **MVP 仅 inline_steps**；
- [ ] condition_wait 是否支持 MQTT 订阅作为 probe？（MVP 不做） — **MVP 仅支持 tcp/udp/http probe**；
- [ ] 编辑器是否必须独立 package.json？（建议是，构建时更独立） — **是**；
- [ ] 是否需要提供 CHANGELOG / 语义化版本 CI 发布？（MVP 先 0.1.0 本地 npm pack，不发布官方） — **MVP 本地验证为主，不发 npm**。
