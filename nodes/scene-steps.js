/* eslint-disable */
/**
 * scene-steps — nodes/scene-steps.js
 * Node-RED 自定义节点 "scene-steps" 的运行时注册。
 *
 * 架构：
 *  - actions/* 内的动作通过 actions/index.js 自动 registry.register()
 *  - executor.runSteps(steps, options) 执行主循环（while + 跳转 + failBehavior）
 *  - options.emit({kind, payload}) 回调 → 4 输出口（step / done / error / audit）
 *
 * 输入（msg.payload）:
 *   "run" / 省略 → 执行节点内配置 steps
 *   "stop"     → signal.abort
 *   "pause" / "resume"
 *   "debug"    → step 输出配置 + 状态
 *   step:Array → 动态覆盖 steps 执行
 */

'use strict';

// 自动注册所有内置动作
require('../actions');
const { runSteps } = require('./lib/executor');
const { createSignal } = require('./lib/cancel');
const { SceneError, ERROR_CODES } = require('./lib/errors');

const MAX_LOOP_DEFAULT = 1000;
const DEFAULT_FAIL = 'stop';
const DEFAULT_TIMEOUT = 15000;

function cloneSafe(v) {
  if (v == null) return v;
  if (typeof v !== 'object' && typeof v !== 'function') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; }
}

function genRunId() {
  return Math.random().toString(36).slice(2, 12);
}

// 把 input.steps（可能是字符串或数组）规范成数组
function normalizeSteps(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* fallthrough */ }
  }
  return [];
}

module.exports = function (RED) {
  // 给前端编辑器提供动作注册表元数据（types/categories/configSchema/...）
  // 路径：/scene-steps/actions-meta
  try {
    if (typeof RED.httpAdmin.get === 'function') {
      RED.httpAdmin.get('/scene-steps/actions-meta', RED.auth.needsPermission ? RED.auth.needsPermission('scene-steps.read') : (_req, _res, next) => next(), function (_req, res) {
        const registry = require('../actions');
        const metas = registry.listMeta().map(m => ({
          type: m.type,
          category: m.category,
          icon: m.icon,
          label: m.label,
          configSchema: m.configSchema,
          defaults: m.defaults
        }));
        const categories = Array.from(new Set(metas.map(m => m.category).filter(Boolean)));
        res.json({ ok: true, version: (require('../package.json').version || '0.1.0'), categories, actions: metas });
      });
    }
  } catch (e) { /* ignore */ }

  function SceneStepsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    // 把 RED 引用挂到 node，供 call_scene(ref_scene 模式) 通过 RED.nodes.eachNode 查目标场景
    node._red = RED;

    node.name = config.name || '';
    node.sceneId = config.sceneId || '';
    node.failBehavior = config.failBehavior || DEFAULT_FAIL;
    node.maxLoopLimit = Number(config.maxLoopLimit) || MAX_LOOP_DEFAULT;
    node.defaultStepTimeoutMs = Number(config.defaultStepTimeoutMs) || DEFAULT_TIMEOUT;
    node.steps = normalizeSteps(config.steps);

    let currentSignal = null;
    let currentRunning = false;

    const updateInitial = () => {
      node.status({ fill: 'grey', shape: 'ring', text: `${node.steps.length} 步 · 就绪` });
    };
    updateInitial();

    node.on('input', async (msg, send, done) => {
      const cmd = (typeof msg.payload === 'string')
        ? msg.payload.toLowerCase().trim()
        : (Array.isArray(msg.payload) ? '__dynamic_steps__' : '');

      if (cmd === 'stop') {
        if (currentSignal) currentSignal.abort('user stop');
        node.status({ fill: 'gray', shape: 'dot', text: '已停止' });
        send([null, null, null, { topic: 'scene:audit', event: 'cancelled', ts: Date.now(), _runId: node._lastRunId }]);
        return done && done();
      }
      if (cmd === 'pause') {
        if (currentSignal) currentSignal.pause();
        node.status({ fill: 'yellow', shape: 'ring', text: '暂停中' });
        send([null, null, null, { topic: 'scene:audit', event: 'paused', ts: Date.now(), _runId: node._lastRunId }]);
        return done && done();
      }
      if (cmd === 'resume') {
        if (currentSignal) currentSignal.resume();
        node.status({ fill: 'yellow', shape: 'ring', text: '继续中' });
        return done && done();
      }
      if (cmd === 'debug') {
        send([{
          topic: 'scene:debug',
          name: node.name,
          stepCount: node.steps.length,
          steps: cloneSafe(node.steps),
          failBehavior: node.failBehavior,
          maxLoopLimit: node.maxLoopLimit,
          defaultStepTimeoutMs: node.defaultStepTimeoutMs,
          running: currentRunning,
          _runId: node._lastRunId
        }, null, null, null]);
        return done && done();
      }

      // run / dynamic_steps
      let actualSteps = node.steps;
      if (cmd === '__dynamic_steps__') actualSteps = msg.payload;
      actualSteps = normalizeSteps(actualSteps);
      if (actualSteps.length === 0) {
        send([null, { topic: 'scene:done', okCount: 0, skipCount: 0, errorCount: 0, totalDurationMs: 0, vars: {}, history: [], _runId: node._lastRunId }, null, null]);
        node.status({ fill: 'green', shape: 'dot', text: '空场景·完成' });
        return done && done();
      }

      if (currentSignal) currentSignal.abort('new run started');
      const signal = createSignal();
      currentSignal = signal;
      currentRunning = true;
      node._lastRunId = genRunId();
      node.status({ fill: 'yellow', shape: 'ring', text: `0/${actualSteps.length}` });

      try {
        const result = await runSteps(actualSteps, {
          failBehavior: node.failBehavior,
          maxLoopLimit: node.maxLoopLimit,
          defaultStepTimeoutMs: node.defaultStepTimeoutMs,
          redNode: node,
          selfSceneId: node.sceneId,   // 用于 call_scene(ref_scene) 循环检测
          signal,
          inputMsg: msg,
          emit: (ev) => {
            const { kind, payload } = ev;
            if (kind === 'step') send([Object.assign({}, payload), null, null, null]);
            else if (kind === 'done') send([null, Object.assign({}, payload), null, null]);
            else if (kind === 'error') send([null, null, Object.assign({}, payload), null]);
            else if (kind === 'audit') send([null, null, null, Object.assign({}, payload)]);
          }
        });

        // 若是 stop.emitAsDone=false 且 error=CANCELLED，则再补一条 Error（executor 已经 emit error，不再重复）
        if (result.error) {
          // 额外更新 node.status（若 executor 内部未覆盖）
          const code = result.error.code || 'ERROR';
          node.status({ fill: 'red', shape: 'dot', text: code });
        } else {
          const total = actualSteps.length;
          const shape = result.okCount >= total ? 'dot' : 'ring';
          node.status({ fill: 'green', shape, text: `完成 ${result.okCount}/${total}` });
        }
      } catch (e) {
        // 顶层兜底（极端路径，executor 内部应该把错误 emit 过了）
        node.status({ fill: 'red', shape: 'dot', text: `Fatal: ${(e && e.code) || 'ERR'}` });
        send([null, null, {
          topic: 'scene:error', stepIndex: -1, stepType: 'runtime',
          errorCode: (e && e.code) || ERROR_CODES.ACTION_ERROR.code,
          errorMessage: (e && e.message) || String(e),
          recoverable: !(e instanceof SceneError) || e.recoverable !== false,
          _runId: node._lastRunId
        }, { topic: 'scene:audit', event: 'cancelled', ts: Date.now(), _runId: node._lastRunId }]);
      } finally {
        currentRunning = false;
        if (currentSignal === signal) currentSignal = null;
        done && done();
      }
    });

    node.on('close', function (removed, done) {
      if (currentSignal) currentSignal.abort('node close');
      currentRunning = false;
      currentSignal = null;
      setTimeout(done, 50);
    });
  }

  RED.nodes.registerType('scene-steps', SceneStepsNode, {
    inputs: 1,
    outputs: 4,
    outputLabels: ['step', 'done', 'error', 'audit'],
    category: 'function'
  });
};
