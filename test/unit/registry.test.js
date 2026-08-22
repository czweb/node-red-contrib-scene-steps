/* eslint-env mocha */
/**
 * Phase 0 MVP：最小 unit 测试（registry / delay / stop）
 * 不需要 mocha 的话直接用 node test/unit/registry.test.js 也能跑（自启动断言）
 */

'use strict';

const assert = require('assert');
const path = require('path');

if (typeof describe === 'function') describe('Task 1 MVP - 最小骨架', function () {
  it('TR-1.1: 0 运行时依赖（dependencies keys = 0）', function () {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
    const count = pkg.dependencies ? Object.keys(pkg.dependencies).length : 0;
    assert.strictEqual(count, 0, `package.json dependencies 应该 = {}，实际有 ${count} 个 keys: ${JSON.stringify(pkg.dependencies)}`);
  });

  it('TR-1.2: registry 列出 6 个 action (call_scene/condition_wait/delay/http_request/jump/label/mqtt_publish/stop/tcp_send/udp_send)', function () {
    // 其他测试会调用 registry.clear() / register() 污染单例，
    // 这里先清 ACTIONS Map，再从 require.cache 里删掉所有 actions/* 和 actions/index.js
    // 让 actions/index.js 重新执行一遍完整的内置动作注册，确保 10 个核心动作都在。
    const path = require('path');
    const projRoot = path.resolve(__dirname, '..', '..');
    const registry = require('../../actions');
    registry.clear();
    function deleteCache(fn) {
      for (const k of Object.keys(require.cache)) {
        if (fn(k)) delete require.cache[k];
      }
    }
    const actionsIdx = require.resolve(path.join(projRoot, 'actions'));
    deleteCache(k => k === actionsIdx || k.indexOf(path.join(projRoot, 'actions') + path.sep) === 0);
    const registryFresh = require('../../actions');
    const metas = registryFresh.listMeta();
    const types = metas.map(m => m.type).sort();
    const expected = ['call_scene','condition_wait','delay','http_request','jump','label','mqtt_publish','stop','tcp_send','udp_send'].sort();
    assert.deepStrictEqual(types, expected, `期望包含全部 10 个核心动作，实际 ${types}`);
    // 每个 action 的 execute 必须是函数
    for (const t of types) {
      const a = registry.get(t);
      assert.strictEqual(typeof a.execute, 'function', `${t}.execute 不是函数`);
      assert.strictEqual(typeof a.configSchema, 'object', `${t}.configSchema 不是对象`);
    }
    registry.clear();
  });

  it('TR-1.3: require("./nodes/scene-steps") 成功返回导出函数', function () {
    // scene-steps.js 内部 require('../actions') 可能触发 re-register，
    // 这里先 clear ACTIONS，并清掉 actions/* 与 scene-steps 相关 require.cache，
    // 再重新 require scene-steps，确保 require 本身不抛
    const path = require('path');
    const projRoot = path.resolve(__dirname, '..', '..');
    const reg = require('../../actions');
    reg.clear();
    const actionsIdx = require.resolve(path.join(projRoot, 'actions'));
    const sceneSteps = require.resolve(path.join(projRoot, 'nodes', 'scene-steps'));
    for (const k of Object.keys(require.cache)) {
      if (k === actionsIdx ||
          k === sceneSteps ||
          k.indexOf(path.join(projRoot, 'actions') + path.sep) === 0 ||
          k.indexOf(path.join(projRoot, 'nodes', 'lib') + path.sep) === 0) {
        delete require.cache[k];
      }
    }
    const modPath = require.resolve('../../nodes/scene-steps');
    const mod = require(modPath);
    assert.strictEqual(typeof mod, 'function', 'scene-steps.js 必须导出 function(RED) 注册器');
  });
});

// 无 mocha 运行时的兜底执行器（`node test/unit/registry.test.js` 也能跑）
if (require.main === module) {
  (async () => {
    const tests = [
      ['TR-1.1', () => {
        const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
        const count = pkg.dependencies ? Object.keys(pkg.dependencies).length : 0;
        if (count !== 0) throw new Error('deps count ' + count);
      }],
      ['TR-1.2', () => {
        const r = require('../../actions');
        const ts = r.listMeta().map(m => m.type).sort();
        const expected = ['call_scene','condition_wait','delay','http_request','jump','label','mqtt_publish','stop','tcp_send','udp_send'].sort();
        if (ts.join(',') !== expected.join(',')) throw new Error('types: ' + ts);
        r.clear();
      }],
      ['TR-1.3', () => {
        const m = require('../../nodes/scene-steps');
        if (typeof m !== 'function') throw new Error('not a function');
      }]
    ];
    let pass = 0;
    for (const [name, fn] of tests) {
      try { fn(); console.log('  ✓', name); pass++; }
      catch (e) { console.error('  ✗', name, e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass}/${tests.length} passed`);
  })();
}
