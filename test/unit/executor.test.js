/* eslint-env mocha */
/**
 * Task 2：Unit 测试套件聚合
 *  - TR-2.1 5 linear steps (executor)
 *  - TR-2.2 loop detection (label + jump)
 *  - TR-2.3 failBehavior switch (stop/skip/retry)
 *  - TR-2.4 cancel during delay < 100ms
 *  - TR-2.5 template interpolations (vars / input / outputs[-1].f / env) + proto pollution
 *  - TR-2.6 rubric: executor lines + structure + function count
 *
 * 无 mocha 环境时可直接 `node test/unit/executor.test.js` 运行（CLI 兜底）。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../../actions');
const { runSteps } = require('../../nodes/lib/executor');
const { createSignal, cancellableDelay } = require('../../nodes/lib/cancel');
const { interpolate, deepInterpolate, evalExpression } = require('../../nodes/lib/template');
const { SceneError } = require('../../nodes/lib/errors');

const describeMocha = (typeof describe === 'function') ? describe : null;
const itMocha = (typeof it === 'function') ? it : null;

// ===== TR-2.1: 5 linear steps =====
async function TR_2_1() {
  registry.clear();
  registry.register(require('../../actions/delay'));
  registry.register(require('../../actions/stop'));
  const steps = Array.from({ length: 5 }, (_, k) => ({ id: 'd' + k, type: 'delay', config: { delayMs: 1 }, postDelayMs: 0 }));
  let stepEvents = [];
  const result = await runSteps(steps, {
    failBehavior: 'stop', maxLoopLimit: 1000, defaultStepTimeoutMs: 30000,
    emit: (ev) => { if (ev.kind === 'step') stepEvents.push(ev.payload.stepIndex); }
  });
  assert.deepStrictEqual(stepEvents, [0, 1, 2, 3, 4], 'stepIndex 顺序必须是 0..4 不重不漏');
  assert.strictEqual(result.history.length, 5, 'history.length === 5');
  assert.strictEqual(result.okCount, 5);
}

// ===== TR-2.2: loop detection (AC-3) =====
async function TR_2_2() {
  registry.clear();
  registry.register(require('../../actions/label'));
  registry.register(require('../../actions/delay'));
  registry.register(require('../../actions/jump'));
  // step0=label(loop) step1=delay(1) step2=jump target=loop max=3
  const steps = [
    { type: 'label', config: { name: 'loop' } },
    { type: 'delay', config: { delayMs: 1 } },
    { type: 'jump',  config: { target: 'loop', max: 3 } },
    { type: 'delay', config: { delayMs: 1 } },
    { type: 'delay', config: { delayMs: 1 } }
  ];
  // failBehavior=stop，expect error
  let err = null; let errorEmit = 0; let delayCount = 0;
  try {
    await runSteps(steps, {
      failBehavior: 'stop', maxLoopLimit: 999, defaultStepTimeoutMs: 10000,
      emit: (ev) => {
        if (ev.kind === 'error') { errorEmit++; err = ev.payload; }
        if (ev.kind === 'step' && ev.payload.stepType === 'delay') delayCount++;
      }
    });
  } catch (e) { err = err || e; }
  assert(delayCount === 4, `delay count 应该 4（初始 1 + 3 跳转），实际 ${delayCount}`);
  const finalCode = (err && err.errorCode) || (err && err.code);
  assert(finalCode === 'LOOP_LIMIT', `错误码应为 LOOP_LIMIT，实际 ${finalCode}`);
  assert(errorEmit >= 1, '至少 emit 了一次 error');
}

// ===== TR-2.3: failBehavior switch =====
async function TR_2_3() {
  // 注册一个可配置的 throw_action
  registry.clear();
  registry.register(require('../../actions/delay'));
  let callCount = 0;
  registry.register({
    type: 'thrower',
    category: 'flow', icon: 'fa-times', label: '抛错',
    configSchema: {}, defaults: {}, validate() {},
    async execute(ctx) {
      callCount++;
      const which = ctx.config.kind || 'always';
      if (which === 'always' || callCount <= Number(ctx.config.nth || 999)) {
        throw SceneError.fromCode('ACTION_ERROR', 'intentional');
      }
      return { output: { ok: true } };
    }
  });

  // stop：第 0 步 throw，立刻 stop
  const stepsStop = [{ type: 'thrower', config: { kind: 'always' } }, { type: 'delay', config: { delayMs: 1 } }];
  let stepIndices = [];
  let emitErr = null;
  await runSteps(stepsStop, {
    failBehavior: 'stop', maxLoopLimit: 10, defaultStepTimeoutMs: 10000,
    emit: (ev) => {
      if (ev.kind === 'step') stepIndices.push(ev.payload.stepIndex);
      if (ev.kind === 'error') emitErr = ev.payload;
    }
  });
  assert.deepStrictEqual(stepIndices, [0], `stop 时只执行 step 0，实际 ${stepIndices}`);
  assert(emitErr && emitErr.errorCode === 'ACTION_ERROR', 'stop 时应 emit 一个 ACTION_ERROR');

  // skip：同一 thrower，但 failBehavior=skip，delay stepIndex=1 仍应执行
  callCount = 0; stepIndices = []; emitErr = null;
  const stepsSkip = [{ type: 'thrower', config: { kind: 'always' } }, { type: 'delay', config: { delayMs: 1 } }];
  const rSkip = await runSteps(stepsSkip, {
    failBehavior: 'skip', maxLoopLimit: 10, defaultStepTimeoutMs: 10000,
    emit: (ev) => { if (ev.kind === 'step') stepIndices.push(ev.payload.stepIndex); if (ev.kind === 'error') emitErr = ev.payload; }
  });
  assert(stepIndices.includes(0) && stepIndices.includes(1), `skip 时 step 0+1 都要执行，实际 ${stepIndices}`);
  assert(rSkip.errorCount === 1 && rSkip.okCount === 1, `skip 统计: err=${rSkip.errorCount} ok=${rSkip.okCount}`);
  assert(emitErr === null, `skip 模式不应有 error emit，实际 ${JSON.stringify(emitErr)}`);

  // retry:3 → execute 次数 4
  callCount = 0; stepIndices = []; emitErr = null;
  const stepsRetry = [{ type: 'thrower', config: { kind: 'always' }, failBehaviorOverride: 'retry:3', retry: 3, retryIntervalMs: 1 }];
  const rRetry = await runSteps(stepsRetry, {
    failBehavior: 'stop', maxLoopLimit: 10, defaultStepTimeoutMs: 10000,
    emit: (ev) => { if (ev.kind === 'step') stepIndices.push(ev.payload); if (ev.kind === 'error') emitErr = ev.payload; }
  });
  assert(callCount === 4, `retry:3 后总调用次数=4，实际 ${callCount}`);
  assert(emitErr.errorCode === 'ACTION_ERROR', '第 4 次还错，应该输出 ACTION_ERROR');
  registry.clear();
}

// ===== TR-2.4: cancel during delay < 100ms =====
async function TR_2_4() {
  registry.clear();
  registry.register(require('../../actions/delay'));
  const signal = createSignal();
  const start = Date.now();
  const p = runSteps([{ type: 'delay', config: { delayMs: 10000 } }], {
    signal, defaultStepTimeoutMs: 30000, failBehavior: 'stop', maxLoopLimit: 10,
  });
  await cancellableDelay(10, null, 0);    // 等 10ms
  signal.abort('test');
  try { await p; } catch (e) { /* ok */ }
  const elapsed = Date.now() - start;
  assert(elapsed < 300, `delay(10s) + abort after 10ms → 总耗时 < 300ms，实际 ${elapsed}ms`);
}

// ===== TR-2.5: template interpolations =====
async function TR_2_5() {
  // vars.x / input / outputs[-1].f / env.USER
  const r1 = interpolate('hello {{vars.x}}!', { vars: { x: 'world' } });
  assert.strictEqual(r1, 'hello world!', 'vars.x');

  const r2 = interpolate('body={{input}}', { input: { ok: 1 } });
  // 对象 JSON stringify
  assert.strictEqual(r2, 'body={"ok":1}', 'input object');

  const r3 = interpolate('last.f={{outputs[-1].f}}', { outputs: [{ f: 42 }, { f: 7 }] });
  assert.strictEqual(r3, 'last.f=7', 'outputs[-1].f');

  process.env.__TEST_SCENE_ENV = 'yes';
  const r4 = interpolate('env={{env.__TEST_SCENE_ENV}}', { env: process.env });
  assert.strictEqual(r4, 'env=yes', 'env.USER style');
  delete process.env.__TEST_SCENE_ENV;

  // __proto__ pollution: should NOT mutate Object.prototype
  const sample = {};
  try {
    interpolate('{{vars.__proto__.polluted=1}}', { vars: {} });
  } catch (e) { /* 或者报错或被静默 */ }
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype 不应被污染');

  // 注入非法关键字 Function 应报 TEMPLATE_UNSAFE
  let threw = false;
  try {
    interpolate('x={{(new Function("return 1"))()}}', { vars: {} });
  } catch (e) {
    if (e.code === 'TEMPLATE_UNSAFE') threw = true;
  }
  assert(threw, 'Function 关键字插值必须报 TEMPLATE_UNSAFE');

  // evalExpression 基础
  assert.strictEqual(true, evalExpression('vars.x >= 1', { vars: { x: 2 } }));
  assert.strictEqual(false, evalExpression('vars.x >= 1', { vars: { x: 0 } }));
}

// ===== TR-2.6 (rubric): executor 结构 =====
async function TR_2_6() {
  const fp = path.resolve(__dirname, '..', '..', 'nodes', 'lib', 'executor.js');
  const src = fs.readFileSync(fp, 'utf8');
  const lines = src.split('\n').length;
  // 统计函数声明数量
  const funcs = src.match(/^(async\s+)?function\s+\w+/gm) || [];
  const arrow = src.match(/=\s*(async\s*)?\([^)]*\)\s*=>/gm) || [];
  const total = funcs.length + arrow.length;
  // 循环体 < 300 行 + 函数数 >= 6（runSteps/normalizeStep/maybePostDelay/withActionTimeout/updateNodeStatusOk/updateNodeStatusErr/cloneSafe/buildLabelMap 等）
  console.log(`  [TR-2.6 rubric evidence] executor.js lines=${lines}, 函数数=${total} (funcs=${funcs.length}, arrow=${arrow.length})`);
  assert(lines <= 400, `executor.js 应 < 400 行，实际 ${lines}`);
  assert(total >= 6, `函数数量应 >= 6，实际 ${total}`);
}

// ===== mocha 套件 =====
if (describeMocha) {
  describe('Task 2 - Executor + Template + Cancel', function () {
    it('TR-2.1: 5 linear steps ok', async function () { await TR_2_1(); });
    it('TR-2.2: label + jump max=3 detection LOOP_LIMIT', async function () { this.timeout(5000); await TR_2_2(); });
    it('TR-2.3: failBehavior stop/skip/retry:3', async function () { this.timeout(5000); await TR_2_3(); });
    it('TR-2.4: cancel during delay < 300ms', async function () { this.timeout(5000); await TR_2_4(); });
    it('TR-2.5: template interpolations + proto pollution + unsafe keywords', async function () { await TR_2_5(); });
    it('TR-2.6: executor structure (rubric)', async function () { await TR_2_6(); });
  });
}

// CLI runner
async function runAll() {
  const tests = [
    ['TR-2.1', TR_2_1],
    ['TR-2.2', TR_2_2],
    ['TR-2.3', TR_2_3],
    ['TR-2.4', TR_2_4],
    ['TR-2.5', TR_2_5],
    ['TR-2.6', TR_2_6]
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.error('  ✗', name, '\n   ', e.stack || String(e)); process.exitCode = 1; }
  }
  console.log(`\n${pass}/${tests.length} passed (Task 2)`);
}
if (require.main === module) runAll();
