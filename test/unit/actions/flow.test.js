/* eslint-env mocha */
/**
 * Task 3 相关流控动作单测 (AC-4 / call_scene recursion + depth 等)
 *  这里补：
 *   - TR-3.1 call_scene A -> B -> A recursion NESTED_RECURSION
 *   - TR-3.2 call_scene inherit vars (inheritVars=true + varsMerge)
 *   - TR-3.3 jump.whenExpr=false → 不跳转
 *   - TR-3.4 depth > 10 throws NEST_TOO_DEEP
 */
'use strict';

const assert = require('assert');
const { runSteps } = require('../../../nodes/lib/executor');
const registry = require('../../../actions');
const { evalExpression } = require('../../../nodes/lib/template');

const desc = (typeof describe === 'function') ? describe : null;
const itt = (typeof it === 'function') ? it : null;

// A 内嵌 B，B 内嵌 A（指纹相同）→ NESTED_RECURSION
async function TR_3_1() {
  registry.clear();
  registry.register(require('../../../actions/call_scene'));
  const fingerprintStep = { type: 'delay' };   // 目前 delay 未重注册 → 用 call_scene 之外，注册个 pass action
  registry.register({
    type: 'delay', category: 'timing', icon: '', label: 'noop',
    configSchema: {}, defaults: {}, validate() {},
    async execute(ctx) { return { output: { slept: Number(ctx.config.delayMs) || 0 } }; }
  });
  const A = [
    { type: 'delay', config: { delayMs: 0 } },
    { type: 'call_scene', config: { mode: 'inline_steps', inline_steps: [
      { type: 'delay' },
      { type: 'call_scene', config: { mode: 'inline_steps', inline_steps: [
        { type: 'delay' },
        // 指纹和外层 A 前 3 步一致（A 前 3 是 delay + call_scene + ？实际指纹是前 3 step type:label；A 的前 3 个 type = delay + call_scene + X；这里 B 里 A-copy 前 3 个全是同 type）
        { type: 'delay' }
      ]}}
    ]}}
  ];
  // 更直接：A 和 A-copy 前 3 个 step type:label 全相等
  const aSteps = [
    { type: 'delay', label: 'L1' },
    { type: 'delay', label: 'L2' },
    { type: 'call_scene', label: 'L3', config: { mode: 'inline_steps', inline_steps: [
      // B: 2 noop + A-copy（指纹和 A 前 3 个相等 → NESTED_RECURSION）
      { type: 'delay', label: 'BL1' },
      { type: 'delay', label: 'BL2' },
      { type: 'call_scene', label: 'BL3', config: { mode: 'inline_steps', inline_steps: [
        // A' copy（type:label 与 A 前 3 个完全一致 → fingerprint 相同
        { type: 'delay', label: 'L1' },
        { type: 'delay', label: 'L2' },
        { type: 'call_scene', label: 'L3', config: { mode: 'inline_steps', inline_steps: [] } }
      ]}}
    ]}}
  ];
  let errFound = null;
  try {
    await runSteps(aSteps, {
      failBehavior: 'stop', maxLoopLimit: 10, defaultStepTimeoutMs: 10000,
      emit: (ev) => { if (ev.kind === 'error') errFound = ev.payload; }
    });
  } catch (e) { errFound = errFound || e; }
  const code = (errFound && errFound.errorCode) || (errFound && errFound.code);
  assert(code === 'NESTED_RECURSION', `A→B→A 递归应抛 NESTED_RECURSION，实际 ${code}`);
}

// inherit vars
async function TR_3_2() {
  registry.clear();
  registry.register(require('../../../actions/call_scene'));
  // 用一个 write_var 动作（varsMerge）替代 set_variable
  registry.register({
    type: 'write_var', category: 'data', icon: '', label: '写变量',
    configSchema: {}, defaults: {}, validate() {},
    async execute(ctx) {
      const name = ctx.config.name; const value = ctx.config.value;
      return { varsMerge: { [name]: value }, output: { wrote: name } };
    }
  });
  const steps = [{
    type: 'call_scene', config: {
      mode: 'inline_steps', inheritVars: true, injectVars: { a: 1 },
      inline_steps: [
        { type: 'write_var', config: { name: 'a', value: 2 } },   // a:1→2
        { type: 'write_var', config: { name: 'b', value: 'hi' } }
      ]
    }
  }];
  const r = await runSteps(steps, { failBehavior: 'stop', maxLoopLimit: 10, defaultStepTimeoutMs: 10000, emit: () => {} });
  assert.strictEqual(r.vars.a, 2, 'vars.a 写回应为 2');
  assert.strictEqual(r.vars.b, 'hi', 'vars.b 应新增 hi');
}

// jump whenExpr=false
async function TR_3_3() {
  registry.clear();
  registry.register(require('../../../actions/label'));
  registry.register(require('../../../actions/jump'));
  registry.register({
    type: 'delay', category: 'timing', icon: '', label: 'noop',
    configSchema: {}, defaults: {}, validate() {},
    async execute() { return { output: {} }; }
  });
  const steps = [
    { type: 'label', config: { name: 'start' } },
    { type: 'jump',  config: { target: 'start', whenExpr: 'vars.flag === true', max: 2 } },
    { type: 'delay' },
    { type: 'delay' }
  ];
  const r = await runSteps(steps, { failBehavior: 'stop', maxLoopLimit: 999, defaultStepTimeoutMs: 10000, emit: () => {} });
  assert.strictEqual(r.okCount, 4, 'vars.flag 空，jump 不触发，应 4 步全过，实际 ' + r.okCount);
}

// depth > 10 throws NEST_TOO_DEEP
async function TR_3_4() {
  registry.clear();
  registry.register(require('../../../actions/call_scene'));
  registry.register({
    type: 'delay', category: 'timing', icon: '', label: 'noop',
    configSchema: {}, defaults: {}, validate() {},
    async execute() { return { output: {} }; }
  });
  // 单向嵌套链表：每层内部放不同 type:label 的占位，保证 fingerprint 不同
  function buildChain(depth) {
    let inner = [];
    for (let d = depth; d >= 0; d--) {
      inner = [
        { type: 'call_scene', label: 'L_' + d, config: { mode: 'inline_steps', inline_steps: inner } }
      ];
      // 给下一层（外层）加独特 delay，保证 fingerprint 逐层不同
      inner.unshift({ type: 'delay', label: 'D_' + d });
    }
    return inner;
  }
  // 11 层 call_scene（d=11 向下构建 12 层结构）maxDepth=10
  const steps = buildChain(11);
  let errFound = null;
  try {
    await runSteps(steps, { failBehavior: 'stop', maxLoopLimit: 99, maxDepth: 10, defaultStepTimeoutMs: 10000,
      emit: (ev) => { if (ev.kind === 'error') errFound = ev.payload; } });
  } catch (e) { errFound = errFound || e; }
  const code = (errFound && errFound.errorCode) || (errFound && errFound.code);
  assert(code === 'NEST_TOO_DEEP', `11 层嵌套应抛 NEST_TOO_DEEP，实际 ${code}`);
}

if (desc) {
  describe('Task 3 - Flow control actions (label/jump/call_scene)', function () {
    it('TR-3.1 A->B->A recursion => NESTED_RECURSION', async function () { this.timeout(5000); await TR_3_1(); });
    it('TR-3.2 inline subscene + inherit varsMerge writes back okCount', async function () { await TR_3_2(); });
    it('TR-3.3 jump whenExpr false does not jump', async function () { await TR_3_3(); });
    it('TR-3.4 depth > maxDepth(10) => NEST_TOO_DEEP', async function () { this.timeout(5000); await TR_3_4(); });
  });
}

async function runAll() {
  const tests = [
    ['TR-3.1', TR_3_1],
    ['TR-3.2', TR_3_2],
    ['TR-3.3', TR_3_3],
    ['TR-3.4', TR_3_4]
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓', name); pass++; }
    catch (e) { console.error('  ✗', name, '\n   ', e.stack || String(e)); process.exitCode = 1; }
  }
  console.log(`\n${pass}/${tests.length} passed (Task 3)`);
}
if (require.main === module) runAll();
