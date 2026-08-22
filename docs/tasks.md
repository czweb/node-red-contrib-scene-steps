# node-red-contrib-scene-steps - 实施任务队列

> 所有任务按依赖顺序排列；每个任务的 AC 映射、TR（测试要求）如下。

---

## Task 1: 项目脚手架 + 最小可跑骨架（Phase 0）
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 在 `/workspace/node-red-contrib-scene-steps/` 新建目录结构（nodes/、nodes/lib/、actions/、editor-src/、test/、examples/、icons/）；
  - 写 `package.json`（name/version/node-red 字段/engines/deps 为空/peerDeps/devDeps/scripts）；
  - 写 `nodes/lib/registry.js`（actions 注册/获取/枚举 meta）；
  - 写 `nodes/lib/errors.js`（SceneError 类 + 错误码枚举）；
  - 写 `nodes/lib/cancel.js`（取消令牌 + 暂停信号辅助，AbortController 风格包装）；
  - 写 `nodes/scene-steps.js` 最小骨架：`RED.nodes.registerType("scene-steps", ...)`、on(input) 识别 msg.payload run/stop/debug/pause/resume、status 颜色、on close 钩子；
  - 写 `nodes/scene-steps.html` 最小版本（3 段结构：data-template-name 配置只有 name / steps(json string) 两个原生输入框；data-help-name 帮助文本）；
  - 写 `actions/index.js` 聚合 + `actions/delay.js` + `actions/stop.js` 两个最小动作，注册到 registry；
  - 写 2 个最小 unit 测试（delay / stop）用 mocha + 最小断言（无需 helper）；
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-11
- **Test Requirements**:
  - `rule` TR-1.1: 进入 `/workspace/node-red-contrib-scene-steps` 执行 `node -e "console.log(Object.keys(require('./package.json').dependencies||{}).length)"`，stdout 等于 "0"；
  - `rule` TR-1.2: `node test/unit/registry.test.js` 能列出 delay 与 stop 两个 action 的 meta；
  - `rule` TR-1.3: `node -e "require('./nodes/scene-steps')"` 不抛异常（只验证 CommonJS require 通过）；
  - `rubric` TR-1.4: 目录完整性；Scale 1-5；1=无分层；3=缺 2+ 目录；5=所有必需目录存在且含占位 index；Threshold >= 4；Evidence: `find . -maxdepth 2 -type d | sort` 与预期列表比较；
- **Notes**: 此步完成后，项目可以 `npm link` 到 Node-RED 并在调色板看到 scene-steps 节点，虽然编辑器很土。
- **Completion Evidence**:
  - TR-1.1 执行 `node -e "console.log(Object.keys(require('./package.json').dependencies||{}).length)"` → stdout = "0"；
  - TR-1.2 执行 `node test/unit/registry.test.js` → stdout `3/3 passed`（TR-1.1/TR-1.2/TR-1.3 三条断言全通过）；
  - TR-1.3 `require.resolve('./nodes/scene-steps')` CommonJS 成功，返回 function(RED) 注册器；
  - TR-1.4 (rubric) 评分 = 5：必需 8 大目录（nodes nodes/lib actions editor-src editor-src/dist editor-src/src test examples icons test/unit test/integration test/e2e_screenshots）全部创建；`.gitignore` + `.npmignore` 交付；
  - 目录清单命令：`find /workspace/node-red-contrib-scene-steps -maxdepth 2 -type d` 正确返回 13 个子目录。

---

## Task 2: 执行引擎 executor.js + 模板引擎 template.js（Phase 1 核心）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - 写 `nodes/lib/template.js`：实现 `{{vars.x}}` / `{{input}}` / `{{outputs[-1].f}}` / `{{env.ENV}}` 四种插值；用 `new Function("vars","input","outputs","env","flow","global","return ...")` 安全沙盒；白名单限制访问字段（禁止访问 __proto__ 等）；
  - 写 `nodes/lib/executor.js`：实现 §3.1 的执行循环（while 循环 + 预扫描 labelMap + loopCounter + 祖先链 + failBehavior 三策略 + postDelayMs + ActionContext 构建）；
  - 在 `scene-steps.js` 接入：run 命令时 new Executor(...)，把 4 条输出正确映射到 `node.send([stepOut, doneOut, errOut, auditOut])`；
  - 扩展 `msg.payload` 命令：支持 step 数组动态覆盖；
  - 新增 `cancel.js`：加入 `CancellableDelay(ms, signal)` 实现（Promise.race([sleep, signalAborted]) 模式 + 清 timeout）；
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-8, AC-9
- **Test Requirements**:
  - `rule` TR-2.1: executor.test.js "5 linear steps ok" — 顺序 5 个 delay(1) 步骤，history 长度 =5，索引 0,1,2,3,4 不重不漏（断言每步 stepIndex 严格递增+1）；
  - `rule` TR-2.2: executor.test.js "label + jump max=3 detection" — 对应 AC-3 的 loop limit 用例，最终 step 执行 delay 次数 =4，抛错 code=LOOP_LIMIT；
  - `rule` TR-2.3: executor.test.js "failBehavior switch" — 分别设置 stop / skip / retry:3，注入人工抛错的 mock action，验证 stop 立刻 Error 输出；skip 输出 step.skip 后继续；retry 调 action.execute 次数=4（原 1 次+3 次）；
  - `rule` TR-2.4: cancel.test.js "cancel during delay in <100ms" — delay(10000) 启动后 10ms 发 abort，总结束耗时 <100ms；
  - `rule` TR-2.5: template.test.js "all interpolations" — 验证 vars.x / input / outputs[-1].f / env.USER 四种插值结果分别正确；同时注入 `{{vars.__proto__.polluted=1}}` 确保不污染 Object.prototype；
  - `rubric` TR-2.6: 执行引擎代码结构清晰度；Scale 1-5；1=一团 function，单文件>800 行；3=可分模块但循环体>250 行嵌套过深未提取子函数；5=executor.js 循环主流程 <120 行，错误分发/failBehavior/步骤审计 均为独立子函数；Threshold >= 4；Evidence: `wc -l nodes/lib/executor.js && grep -c "^  \+if\|  \+for" nodes/lib/executor.js` 比率合理 + 函数名 review。

---

## Task 3: 流控动作插件（Phase 1 后半：label / jump / call_scene）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - 写 `actions/label.js`：Meta + execute（noop，实际 labelMap 在 executor 预扫描阶段建）；
  - 写 `actions/jump.js`：Meta(configSchema 含 target(select 动态枚举所有 label 名)、max(number, default=1000)、whenExpr(text)）；execute 返回 `{ flow: "jump", target, maxCheck: true/false }`；
  - 写 `actions/call_scene.js`：Meta（两种模式切换 radio，inline_steps 走"子步骤编辑器"—此处 MVP 简化为 JSON 文本输入框，在 Task 7 再升级为嵌套编辑器）；execute：深拷贝 steps，递归调用 Executor.run(steps, ancestors.concat(parentId))，祖先命中直接抛 NESTED_RECURSION；嵌套深度计数 >10 抛 NEST_TOO_DEEP；
  - 在 executor 中接入 jump 与 call_scene 返回的 flow 指令；
  - 扩展 jump 的 whenExpr：复用 template.js 的表达式沙盒（whenExpr 直接是 return 后面的语句）；
- **Acceptance Criteria Addressed**: AC-3, AC-4, FR-4.2 ~ FR-4.5
- **Test Requirements**:
  - `rule` TR-3.1: call_scene.test.js "A -> B -> A recursion" — 抛出错误 code=NESTED_RECURSION，Error 口有消息；
  - `rule` TR-3.2: call_scene.test.js "inline 3 steps + inheritVars" — 父 vars.x=1，子场景 setVariable（此处 MVP 用 delay(0)+ varsMerge）后 vars.x+1 写回，父 done 输出 vars.x==2；
  - `rule` TR-3.3: jump.test.js "whenExpr false passes" — jump 配置 whenExpr="vars.flag===true" 实际 vars.flag=false，则不跳转继续下一行；
  - `rule` TR-3.4: call_scene.test.js "depth > 10 throws NEST_TOO_DEEP" — 11 层单向嵌套 call_scene 链 → 最后一层抛错；

---

## Task 4: 网络动作：TCP / UDP / HTTP / MQTT / condition_wait + TCP Pool（Phase 2）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - 写 `nodes/lib/tcp-pool.js`：以 `(nodeId, poolKey)` 为 key 的 Map，`getSocket()` 复用 net.Socket；场景 on close 时池里所有 socket.destroy()；支持超时释放；
  - 写 `actions/tcp_send.js`：host/port/data string / encoding(utf8/hex/base64) / waitResponseMs / closeAfter / poolKey / bindAddr；用 net.Socket，响应按 buffer 收完或 timeout 结束，output={raw,text,hex,elapsed}；
  - 写 `actions/udp_send.js`：dgram.createSocket('udp4'/'udp6') / bindLocalAddr / broadcast / ttl / encoding；返回 output={bytesSent, elapsed}；
  - 写 `actions/http_request.js`：method / url / headers(JSON) / body / bodyEncoding(json/form/text/none) / timeoutMs / expectStatus(2xx/200/3xx+301…) / auth(type=basic|bearer|none, user+pass走credentials或token) / insecureSkipTlsVerify / proxy(暂 MVP 不做，直接禁用，写 TODO)；用 Node.js 原生 `http.request` + `https.request`，响应 body 读入 Buffer 后转 text 或按 content-type 尝试 JSON parse；
  - 写 `actions/mqtt_publish.js`：brokerId(typedInput: "mqtt-broker") / topic / payload / qos(0/1) / retain；通过 `RED.nodes.getNode(brokerId)` 校验存在且 `client.connected`，未连接抛 `MQTT_NOT_CONNECTED`；连接后 `client.publish(topic, payload, {qos, retain}, callback)`，完成 resolve；
  - 写 `nodes/lib/condition.js`：匹配引擎 — `matchRule(raw, rule)` 支持 contains / equals / equalsIgnoreCase / regex / jsonPath 五种；jsonPath 用最小实现（手写 200 行，不引入 jsonpath 依赖）；
  - 写 `actions/condition_wait.js`：probe.protocol(tcp/udp/http) + probe.config(对应 tcp_send/udp_send/http_request 配置) + expectRule(type/value/jsonPath?) + intervalMs / retries / timeoutMs / onTimeoutJumpTo(label)；内部循环，每 intervalMs 触发一次 probe，match 通过 status=ok 返回，否则重试，retries 用完 CONDITION_TIMEOUT + 可选 jump；
- **Acceptance Criteria Addressed**: AC-5, AC-6, AC-7
- **Test Requirements**:
  - `rule` TR-4.1: tcp_send.test.js "echo roundtrip + poolKey reuse"（对应当 AC-5）；
  - `rule` TR-4.2: tcp_send.test.js "hex data" — data="010203" encoding=hex → socket 收到 Buffer<01 02 03>；
  - `rule` TR-4.3: udp_send.test.js "broadcast + ttl" — mock dgram，验证 socket.setBroadcast(true) 与 socket.setTTL(128) 在发送前被调用；
  - `rule` TR-4.4: http_request.test.js "template + https + expectFail"（对应 AC-6）；
  - `rule` TR-4.5: mqtt_publish.test.js "no broker config throws MQTT_CONFIG_MISSING" — brokerId 不存在或 client 未 ready 时，抛出合适错误码；
  - `rule` TR-4.6: condition.test.js "5 rule types" — 对 5 种 matchRule 类型各 2 条正反用例全通过；
  - `rule` TR-4.7: condition_wait.test.js "OK on 3rd / timeout after 2"（对应 AC-7）；

---

## Task 5: 前端编辑器 MVP（Vue3 + 三栏布局 + 增删改 + 拖拽 + JSON Schema 表单）（Phase 3）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - 新建 `editor-src/package.json`（vue@3 + sortablejs + esbuild）+ `esbuild.config.js`（iife bundle，入口 src/main.js，输出 editor-src/dist/scene-steps-editor.bundle.js，gzip 后 < 220KB 目标）；
  - 实现 `App.vue`：顶栏（name / failBehavior 下拉 / maxLoopLimit / defaultStepTimeoutMs）+ 三栏 CSS grid；
  - 实现 `Palette.vue`：从 `window.__sceneStepsActionMetas`（由 HTML 脚本注入，避免二次请求）读取动作 meta；分组显示（时序流控/网络通讯）；搜索框过滤；双击或拖拽 emit "add-action"；
  - 实现 `StepList.vue` + `StepRow.vue`：SortableJS 拖拽重排，支持 handle 拖拽；每行 hover 显示 插入⊕/复制📋/删除✕；全选/反选批量操作；计算预计总耗时（∑ step.defaultTimeoutMs*0.5 + postDelayMs）；
  - 实现 `ConfigForm.vue`（轻量 JSON Schema → 表单生成器，<250 行）：支持 field types: text / number / select(options) / boolean(checkbox) / textarea / hex(带字符过滤 0-9a-f 自动去空格大写) / encoding(utf8/hex/base64 radio)；v-model 双向绑定 steps[idx].config；
  - **嵌入 scene-steps.html**：在 `data-template-name="scene-steps"` 模板中，除了标准 `<input type="hidden" id="node-input-steps">`（保存 JSON 序列化后的 steps），再放 `<div id="scene-steps-editor-mount"></div>` + `<script src="resources/scene-steps/editor.bundle.js" onerror="fallbackInline()"></script>`；fallback 把 dist 的 IIFE 内容 inline（用构建时 Read 后转义），保证内网无 resources 路径时也能打开；
  - 实现 `oneditsave`：Vue root.$data 导出 → JSON.stringify 写入 `#node-input-steps` 等 hidden input；实现 `oneditcancel` 清理 Vue 实例；实现 `oneditprepare` 根据 hidden input 值 restore Vue store；
- **Acceptance Criteria Addressed**: AC-10, FR-6
- **Test Requirements**:
  - `rubric` TR-5.1: 编辑器 UI 交互（AC-10），Scale 1-5，Threshold >= 4；Evidence: 手动运行 Node-RED + Playwright/Chrome MCP 做 8 个关键动作（新增 delay→改值→拖拽→删除→JSON 导入→导出→Cancel 取消不写回→Done 保存后 reopen 数据一致），保存 8 张截图；
  - `rule` TR-5.2: JSON 往返无损 — 导入复杂 steps JSON（12 步含所有动作类型 + 特殊字符）→ 保存 → reopen → 导出 → 字符串与原文件 deep equal（忽略 key 顺序）；
  - `rule` TR-5.3: hex 字段过滤 — 在 hex 输入框输入 "01 gg !!" 后 model 值应该是 "01"；
  - `rule` TR-5.4: 拖拽结果 — SortableJS 触发 move 第 0 行到第 3 行，model steps 顺序正确；

---

## Task 6: 编辑器增强（Phase 4 前半：表达式助手 / 变量助手 / 预计耗时 / HEX 格式化 / 配置节点选择器）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 5
- **Description**:
  - `VarInsertDialog.vue`：按钮在所有 text / textarea / hex 输入框旁（通过自定义 schema UI 扩展 `x-varsHint: true`）触发，弹窗展示已知 vars 列表（静态默认 + 当前 steps 中 varsMerge 定义扫描推断 + msg.vars 占位符），点击插入 `{{vars.name}}` 文本；
  - `ExprEditorDialog.vue`：jump 的 whenExpr 字段 + condition_wait matchRule value 字段旁按钮触发，弹窗提供：变量选择器（vars./outputs./env.）+ 运算符面板（==!= < > && || contains regex）+ 输入样本"模拟 vars"区 + "Test"按钮，用 template.js 相同 Function 沙盒实时求值；
  - `TimeEstimate.vue`：顶栏显示"预计总耗时"条，细分为 step timeout（黄色条）与 postDelay（蓝色条），点击展开显示每步贡献 breakdown table；
  - hex 输入增强：失焦自动去空格转大写 + 每 2 字节加分隔符（01 02 03），但写回 model 去掉分隔符；
  - 自定义字段类型：`mqtt-broker-picker`（Node-RED `typedInput` 里 mqtt-broker 配置节点）与 `tcp-config-picker`；在 HTML 中用 RED 注册 typedInput 机制或手写枚举 RED.nodes.eachConfig 得到所有 mqtt-broker id/name 列表；
  - `package.json` 中 `node-red.resources` 字段配置，把 editor.bundle.js 挂到 `/resources/scene-steps/editor.bundle.js` HTTP 路径；
- **Acceptance Criteria Addressed**: FR-6 细节, AC-10(提分)
- **Test Requirements**:
  - `rule` TR-6.1: VarInsert 点击插入 — 模拟点击 VarInsert 按钮，选中"roomId"后输入框的值结尾处出现"{{vars.roomId}}"；
  - `rule` TR-6.2: ExprEditor 实时求值 — 设置 sample vars={code:200} whenExpr="vars.code==200" → Test 返回 true；
  - `rule` TR-6.3: HEX 失焦格式化 — 输入 "1a2b3c" 失焦 → 显示 "1A 2B 3C" → model 保存 "1A2B3C"（无空格）；
  - `rubric` TR-6.4: 配置节点选择器正确性；Scale 1-5，1=硬编码 broker ID，3=枚举但无图标/名称，5=枚举所有 mqtt-broker config node，显示 name+图标，选中后写回 brokerId 字符串；Threshold >= 4；

---

## Task 7: 示例 flows 10 个 + README 中文文档（Phase 4 后半）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 6
- **Description**:
  - 写 `examples/01_basic_delay_sequence.json`：3 步 delay 序列 + inject(点击 run) + scene-steps + 4 个 debug 分别接 4 个输出口；
  - 写 `examples/02_tcp_send_and_echo.json`：含 function + TCP server（Node-RED 原生 tcp-in/tcp-out 或用 function + net）+ scene-steps 2 步 tcp_send 验证 poolKey；
  - 写 `examples/03_jump_and_label_loop.json`：投影机开机→等 2s→condition_wait OK→否则跳回 label retry；
  - 写 `examples/04_nested_subscene.json`：call_scene inline 模式，主场景 2 步 + 子场景 3 步；
  - 写 `examples/05_condition_wait_modbus-like.json`：tcp probe "03 00 00 00 0A"（Modbus RTU 风格）→ jsonPath 匹配；
  - 写 `examples/06_http_api_chain.json`：HTTP GET token → varsMerge 存 token → HTTP POST 带 Authorization Bearer；
  - 写 `examples/07_fail_behavior.json`：注入 4 个节点，failBehavior 分别 stop/skip/retry:3 并排对比输出；
  - 写 `examples/08_udp_broadcast_discovery.json`：udp_send 255.255.255.255 broadcast=true；
  - 写 `examples/09_dynamic_steps_from_input.json`：function 节点构造 steps 数组 → 动态注入 scene-steps 执行；
  - 写 `examples/10_stop_and_pause_resume.json`：按钮组 inject 分别 run/stop/pause/resume，观察 step 进度；
  - 写 `README.md` 中文：安装（本地 npm install / npm link 两种）、节点介绍、4 输出口字段表、10 种动作参数详细说明、常见问题、附截图 3 张（节点外观、编辑器全貌、配置表单特写）；
- **Acceptance Criteria Addressed**: AC-12
- **Test Requirements**:
  - `rule` TR-7.1: `ls /workspace/node-red-contrib-scene-steps/examples/*.json | wc -l` 结果 ≥10；
  - `rule` TR-7.2: 每个 JSON 文件 `node -e "JSON.parse(require('fs').readFileSync('./examples/xxx.json','utf8'))"` 均不抛 SyntaxError；
  - `rubric` TR-7.3: README 完整性（AC-12），Scale 1-5 Threshold >= 4；Evidence: README.md 章节检查（安装/节点介绍/输出口字段/动作说明/FAQ），不少于 8 章。

---

## Task 8: 单元测试 + 集成测试 + Node-RED helper 流程全验证（Phase 5）
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 7
- **Description**:
  - 完善 `package.json` 根 scripts：`"test": "mocha --recursive test/unit test/integration --timeout 15000 --exit"`；
  - 写 `test/integration/_helper.js`：启动 node-red-node-test-helper，加载 scene-steps 节点；
  - 写 `test/integration/spec_nodes_register.js`：对应 AC-1（registerType）；
  - 写 `test/integration/spec_outputs_contract.js`：对应 AC-8（3 step 场景输出顺序字段）；
  - 写 `test/integration/spec_lifecycle_no_leak.js`：对应 AC-9（unload close 后句柄）；用 process._getActiveHandles() 前后比较（忽略 Node-RED 本身的 handles）；
  - 写 `test/unit/actions/*.test.js` 全补齐（delay/stop/label/jump/call_scene/tcp_send/udp_send/http_request/mqtt_publish/condition_wait）每个至少 3 个用例；
  - 写 `test/unit/registry.test.js` / `template.test.js` / `executor.test.js` / `condition.test.js` / `cancel.test.js` / `tcp-pool.test.js` 全补齐；
  - npm test 跑一遍，确保通过率 100%，无挂起用例（mocha --exit 是保护网）；
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11
- **Test Requirements**:
  - `rule` TR-8.1: `npm test` 退出码 = 0，测试用例数 ≥ 40，passing / failing = failing = 0；
  - `rule` TR-8.2: `npm test 2>&1 | grep "error\|Error\|FAIL" | grep -v "passed\|✓"` （失败关键词）数量 = 0；
  - `rule` TR-8.3: 所有 TR-* 提到的用例全部在输出中出现 "✓ xxx" 或 "passing"；
  - `rubric` TR-8.4: 测试覆盖率（主观估计），Scale 1-5，1=测试<10 条；3=30 条但关键 AC 有空缺；5=每个 AC 对应 1+ 条集成用例 + 单元用例覆盖正反边界；Threshold >= 4；

---

## Task 9: 本地 Node-RED 实装 & 浏览器交互验证（End-to-End）
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 8
- **Description**:
  - 单独新建临时 Node-RED 运行目录 `/tmp/nr-test-userdir`；
  - `cd /tmp/nr-test-userdir && npm init -y && npm install node-red@latest node-red-node-test-helper /workspace/node-red-contrib-scene-steps --no-audit --no-fund`；
  - 启动真实 Node-RED：`npx node-red -u /tmp/nr-test-userdir -p 18890`，blocking=false 后台；
  - 用浏览器（Chrome DevTools MCP / Playwright）：
    1. 访问 http://localhost:18890，确认调色板 scene 分类出现 scene-steps；
    2. 拖到画布 → 双击 → 步骤编辑器打开；
    3. 添加 5 步（delay/tcp_send/http_request/jump/condition_wait），验证 Palette/List/Form 全交互；
    4. 点 Done 保存 → Deploy → 接 inject → 点 inject 按钮；
    5. 切到 Debug 面板，看 4 个输出口消息（Step 5 条 / Done 1 条）；
    6. 浏览器截图 3 张（编辑器 UI / Deploy 前画布 / Debug 面板输出），保存到 `test/e2e_screenshots/`；
  - 停止 Node-RED 进程；
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-8, AC-10
- **Test Requirements**:
  - `rule` TR-9.1: 真实 Node-RED 启动日志无 "Error loading node scene-steps" 异常；
  - `rule` TR-9.2: 编辑器打开无 console.error（浏览器 console 消息级别 error = 0）；
  - `rule` TR-9.3: 点击 inject 后 Debug 面板出现 3+ 条 scene:step 消息 + 1 条 scene:done；
  - `rubric` TR-9.4: E2E 截图完整性，Scale 1-5，1=无截图/白屏；3=截图有但缺步骤编辑器细节；5=3 张截图齐全 + 节点状态颜色与步骤输出清晰可见；Threshold >= 4；
- **Notes**: 此 Task 是高优先级，因为真实运行环境和 helper mock 会有差异（MQTT config node、typedInput、editor 资源路径等）。

---

## Task 10: 代码规范 + 最终整理（打包前自检）
- **Status**: `pending`
- **Priority**: low
- **Depends On**: Task 9
- **Description**:
  - 写 `.gitignore` / `.npmignore`，排除 editor-src/node_modules / test / .trae 等；
  - 写 `LICENSE`（MIT）；
  - 写 `CHANGELOG.md` 首版 0.1.0；
  - 所有 JS 文件顶部版权头 + 简单 JSDoc 注释（至少主类/主函数）；
  - `npm pack --dry-run`，列出打包文件清单，确认 `dependencies={}` + 无意外大文件（editor bundle.js 除外）；
  - 跑最后一次 `npm test` + `npm pack --dry-run` 作为交付前检查；
- **Acceptance Criteria Addressed**: AC-11, NFR-1/2
- **Test Requirements**:
  - `rule` TR-10.1: `npm pack --dry-run 2>&1 | grep -E "^npm notice" | head -5` + tarball 文件列表，确认不含 test/ + editor-src/源文件；
  - `rule` TR-10.2: `node -e "const p=JSON.parse(require('fs').readFileSync('./package.json','utf8')); console.log(JSON.stringify(p.dependencies||{}))==='{}' ? 0 : 1"` 退出码=0；
  - `rule` TR-10.3: `npm test` 仍 100% 通过；
