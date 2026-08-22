/* eslint-disable */
/**
 * scene-steps — nodes/lib/executor.js
 * 场景步骤执行引擎核心。
 *
 * 输入：{ steps, options: { failBehavior, maxLoopLimit, defaultStepTimeoutMs, ancestors, redNode, signal, inputMsg, emit } }
 * 输出：Promise<{ okCount, skipCount, errorCount, totalDurationMs, vars, history }>
 *
 * 设计：
 *  1. while (i < len) 主循环，索引支持 jump 改变（而非 for 计数器）
 *  2. 预处理阶段：扫描所有 label，建立 labelMap -> Map<labelName, stepIndex>
 *  3. loopCounter[labelName]++ ：每次 jump 到某 label 累计，超 maxLoopLimit 抛 LOOP_LIMIT
 *  4. 祖先链 ancestors: string[]：call_scene 时追加当前 node.id+depth，命中即 NESTED_RECURSION；深度>10 抛 NEST_TOO_DEEP
 *  5. failBehavior：stop(立刻 Error)/skip(记 skip status 继续)/retry(n):n 次 retry 后仍失败按 stop
 *  6. 每步支持 failBehaviorOverride 覆盖节点级
 *  7. steps[i].postDelayMs：动作成功后的延时
 *  8. 支持 action.execute 返回值 flow 指令：{flow:"stop"} / {flow:"jump", target, max?} / {flow:"subscene_done"} / {varsMerge:{}} 合并到 state.vars
 *  9. emit({kind, payload}) 回调把 step/done/error/audit 发出去（由 scene-steps.js 映射到 node.send 4 口）
 */

'use strict';

const registry = require('./registry');
const { SceneError, ERROR_CODES } = require('./errors');
const { cancellableDelay } = require('./cancel');
const { deepInterpolate, evalExpression } = require('./template');

const DEFAULT_OPT = Object.freeze({
  failBehavior: 'stop',
  maxLoopLimit: 1000,
  defaultStepTimeoutMs: 15000,
  maxDepth: 10
});

function genRunId() {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * 主入口。
 * @param {Array} steps 
 * @param {object} opts
 * @returns {Promise<{okCount, skipCount, errorCount, totalDurationMs, vars, history, stoppedBy, error}>}
 */
async function runSteps(steps, opts) {
  const options = Object.assign({}, DEFAULT_OPT, opts || {});
  const startAt = Date.now();
  const runId = genRunId();
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const ancestors = Array.isArray(options.ancestors) ? options.ancestors.slice() : [];
  // sceneAncestors: 跟踪被调用的 sceneId 链，用于 ref_scene 间接循环检测 A→B→C→A
  const sceneAncestors = Array.isArray(options.sceneAncestors) ? options.sceneAncestors.slice() : [];
  const redNode = options.redNode || null;
  const signal = options.signal || null;   // CancelSignal

  // 把当前 steps 本身的 fingerprint 写入祖先链（与 call_scene 保持一致），
  // 这样 A(顶层) → B(call_scene) → A'(call_scene) 时 A 的 fingerprint 仍可被查重命中。
  // 与 call_scene.js 指纹算法同步：前 3 步 type:label 以 | 连接。
  const selfFingerprint = (Array.isArray(steps) ? steps.slice(0, 3) : [])
    .map(s => (s && typeof s === 'object') ? `${s.type || '?'}:${s.label || ''}` : '?:')
    .join('|');
  const selfAncestorKey = `call_scene(${selfFingerprint})`;
  if (selfFingerprint && ancestors.indexOf(selfAncestorKey) !== -1) {
    throw SceneError.fromCode('NESTED_RECURSION', `子场景递归(指纹): ${selfFingerprint}`);
  }
  ancestors.push(selfAncestorKey);

  // sceneId 查重：若本场景的 sceneId 已经在 sceneAncestors 链中（祖先链上某场景已调过本场景），
  // 视为间接循环（A→B→C→A）。sceneAncestors 由父 runNested 透传，已包含所有祖先场景的 sceneId。
  // 顶层调用时 options.selfSceneId 是当前节点 sceneId，sceneAncestors 为 []，不会命中自己。
  const selfSceneId = options.selfSceneId || '';
  if (selfSceneId && sceneAncestors.indexOf(selfSceneId) !== -1) {
    throw SceneError.fromCode('NESTED_RECURSION', `子场景递归(sceneId): ${selfSceneId}，调用链: ${sceneAncestors.join(' → ')} → ${selfSceneId}`);
  }
  // 把当前场景加入链尾，供子调用查重
  if (selfSceneId) sceneAncestors.push(selfSceneId);

  // 祖先链 / 深度检查（子场景调用时由 call_scene 传入 ancestors）
  if (ancestors.length > options.maxDepth) {
    throw SceneError.fromCode('NEST_TOO_DEEP', `嵌套深度 > ${options.maxDepth}`);
  }

  const len = steps.length;
  const state = {
    vars: Object.assign({}, (options.inputMsg && options.inputMsg.vars) || {}),
    outputs: new Array(len).fill(null), // 每步 output 数组（与 steps 索引对应，重复跳转同一索引会被覆盖，可通过 history 看全）
    history: [],
    labelMap: buildLabelMap(steps),
    loopCounter: {},       // { labelName: count }
    retryCounts: new Array(len).fill(0),  // 每步已重试次数（基于索引，避免 normalizeStep 返回新对象导致计数丢失）
    stoppedBy: null,       // 记录 stop 动作决定如何输出
    error: null
  };

  // 预处理：labelMap
  function buildLabelMap(s) {
    const m = new Map();
    for (let i = 0; i < s.length; i++) {
      if (s[i] && s[i].type === 'label' && s[i].config && s[i].config.name) {
        m.set(String(s[i].config.name), i);
      }
    }
    return m;
  }

  emit({ kind: 'audit', payload: { topic: 'scene:audit', event: 'start', ts: startAt, _runId: runId, stepCount: steps.length, depth: ancestors.length } });

  let i = 0;
  while (i < len) {
    // 取消令牌：立刻中止循环
    if (signal && signal.aborted) {
      state.error = SceneError.fromCode('CANCELLED');
      break;
    }
    // 暂停令牌：等待
    if (signal && signal.paused) {
      emit({ kind: 'audit', payload: { topic: 'scene:audit', event: 'paused', ts: Date.now(), _runId: runId } });
      try { await signal.ifPausedWait(); } catch (e) { state.error = e; break; }
    }

    const step = normalizeStep(steps[i], i);
    const stepStart = Date.now();
    let result = null;

    try {
      // 1) 获取 action
      const action = registry.get(step.type);
      // 2) 模板展开
      const tmplCtx = { vars: state.vars, input: (options.inputMsg && options.inputMsg.payload), outputs: state.outputs };
      const config = Object.assign(
        {},
        action.defaults,
        deepInterpolate(step.config || {}, tmplCtx)
      );
      // 3) action 自定义校验
      if (typeof action.validate === 'function') action.validate(config);

      // 4) 组装 ctx：outputs 通过 state 可见；不再写 step._outputs（step 每轮是新对象）
      const ctx = {
        step, stepIndex: i,
        outputs: state.outputs,
        config,
        vars: state.vars,
        signal,
        node: redNode,
        runId,
        labelMap: state.labelMap,
        maxLoopLimit: options.maxLoopLimit,
        ancestors,
        // call_scene 内部再调 runSteps 时用：
        // childSceneId: 由 call_scene ref_scene 模式传入被调用场景的 sceneId，作为子 runSteps 的 selfSceneId
        // sceneAncestors 已含父场景 sceneId，直接透传（子入口会再 push 自己的 sceneId）
        runNested: (subSteps, extraAncestor, childSceneId) => runSteps(subSteps, Object.assign({}, options, {
          ancestors: ancestors.concat([extraAncestor || ('depth-' + ancestors.length)]),
          sceneAncestors: sceneAncestors.slice(),
          selfSceneId: childSceneId || '',
          inputMsg: { vars: state.vars, payload: null },
          emit: (ev) => { /* 子场景 emit 过滤：只转发 step 消息给外部 */ if (ev.kind === 'step' || ev.kind === 'error') emit(ev); }
        }))
      };

      // 5) 执行（含 defaultStepTimeoutMs 软超时）
      result = await withActionTimeout(action, ctx, Number(step.timeoutMs) || options.defaultStepTimeoutMs, signal);

      // 6) varsMerge
      if (result && result.varsMerge && typeof result.varsMerge === 'object') {
        Object.assign(state.vars, result.varsMerge);
      }

      const duration = Date.now() - stepStart;
      state.outputs[i] = (result && result.output) !== undefined ? result.output : null;
      state.history.push({ stepIndex: i, type: step.type, id: step.id, status: 'ok', durationMs: duration });
      emit({ kind: 'step', payload: {
        topic: 'scene:step', stepIndex: i, stepId: step.id, stepType: step.type, stepLabel: step.label || '',
        status: 'ok',
        input: cloneSafe(step.config),
        output: cloneSafe((result && result.output) || undefined),
        durationMs: duration,
        vars: cloneSafe(state.vars),
        _runId: runId
      }});
      if (redNode && typeof redNode.status === 'function') updateNodeStatusOk(redNode, i, steps.length, step.type);

      // 7) flow 控制指令
      if (result && result.flow === 'stop') {
        state.stoppedBy = Object.assign({ emitAsDone: true }, result && result.output ? (result.output.stop || result.output) : {});
        break;
      }
      if (result && result.flow === 'jump') {
        const target = result.target;
        if (!state.labelMap.has(target)) throw SceneError.fromCode('LABEL_NOT_FOUND', target);
        const newIndex = state.labelMap.get(target);
        state.loopCounter[target] = (state.loopCounter[target] || 0) + 1;
        const limit = Number(result.max) || options.maxLoopLimit;
        if (state.loopCounter[target] > limit) throw SceneError.fromCode('LOOP_LIMIT', `标签 ${target} 跳转超 ${limit} 次`);
        i = newIndex;
        // postDelayMs：jump 后仍要执行当前步 postDelay
        await maybePostDelay(step, signal);
        continue;
      }
      // 普通下一步
      await maybePostDelay(step, signal);
      i++;
    } catch (err) {
      const duration = Date.now() - stepStart;
      const code = (err instanceof SceneError) ? err.code : ERROR_CODES.ACTION_ERROR.code;
      const rec  = (err instanceof SceneError) ? err.recoverable : true;
      const fb   = step.failBehaviorOverride || options.failBehavior;

      state.history.push({ stepIndex: i, type: step.type, id: step.id, status: 'error', durationMs: duration, error: code });
      emit({ kind: 'step', payload: {
        topic: 'scene:step', stepIndex: i, stepId: step.id, stepType: step.type, stepLabel: step.label || '',
        status: 'error',
        errorCode: code, errorMessage: err.message || String(err),
        durationMs: duration, vars: cloneSafe(state.vars), _runId: runId
      }});
      if (redNode && typeof redNode.status === 'function') updateNodeStatusErr(redNode, i, steps.length, step.type, code);

      let handled = false;
      if (fb === 'skip') {
        handled = true;
        // 再发一条 skip step 消息？历史里记录 skip 即可
        i++;
      } else if (/^retry(?::(\d+))?$/.test(fb)) {
        // retry:n
        const m = /^retry(?::(\d+))?$/.exec(fb);
        const n = Math.min(10, Math.max(0, Number(step.retry) || (m[1] ? Number(m[1]) : 1)));
        const retryCount = state.retryCounts[i] || 0;
        if (retryCount < n) {
          state.retryCounts[i] = retryCount + 1;
          const intv = Number(step.retryIntervalMs) || 500;
          if (intv > 0) {
            try { await cancellableDelay(intv, signal); } catch (e) { state.error = e; break; }
          }
          // continue 同一条 step（不 i++）
          handled = true;
        }
      }

      if (!handled) {
        // stop：抛错到外层 Error 口
        state.error = (err instanceof SceneError) ? err : new SceneError(err.message || String(err), { code, recoverable: rec });
        emit({ kind: 'error', payload: {
          topic: 'scene:error', stepIndex: i, stepType: step.type,
          errorCode: code, errorMessage: state.error.message, recoverable: rec, _runId: runId
        }});
        break;
      }
    }
  } // end while

  const totalDuration = Date.now() - startAt;
  // 汇总结果
  const ok = state.history.filter(h => h.status === 'ok').length;
  const sk = state.history.filter(h => h.status === 'skip').length;
  const er = state.history.filter(h => h.status === 'error').length;

  // 取消信号 → audit cancelled
  if (signal && signal.aborted && !state.error) {
    state.error = SceneError.fromCode('CANCELLED');
  }
  const finalError = state.error;

  // stop.emitAsDone → 用 done 输出；否则若 error → error 输出
  if (state.stoppedBy && state.stoppedBy.emitAsDone === true && !finalError) {
    emit({ kind: 'done', payload: {
      topic: 'scene:done', okCount: ok, skipCount: sk, errorCount: er, totalDurationMs: totalDuration,
      vars: cloneSafe(state.vars), history: state.history, stopped: true,
      reason: state.stoppedBy.reason, _runId: runId
    }});
    emit({ kind: 'audit', payload: { topic: 'scene:audit', event: 'finish', ts: Date.now(), _runId: runId } });
    return { okCount: ok, skipCount: sk, errorCount: er, totalDurationMs: totalDuration, vars: state.vars, history: state.history, stoppedBy: state.stoppedBy, error: null };
  }
  if (finalError) {
    emit({ kind: 'audit', payload: { topic: 'scene:audit', event: 'cancelled', ts: Date.now(), _runId: runId, errorCode: finalError.code } });
    return { okCount: ok, skipCount: sk, errorCount: er, totalDurationMs: totalDuration, vars: state.vars, history: state.history, stoppedBy: state.stoppedBy, error: finalError };
  }

  emit({ kind: 'done', payload: {
    topic: 'scene:done', okCount: ok, skipCount: sk, errorCount: er, totalDurationMs: totalDuration,
    vars: cloneSafe(state.vars), history: state.history, _runId: runId
  }});
  emit({ kind: 'audit', payload: { topic: 'scene:audit', event: 'finish', ts: Date.now(), _runId: runId } });
  return { okCount: ok, skipCount: sk, errorCount: er, totalDurationMs: totalDuration, vars: state.vars, history: state.history, stoppedBy: state.stoppedBy, error: null };
}

function normalizeStep(s, idx) {
  if (!s || typeof s !== 'object') return { id: 'st_' + idx, type: 'delay', config: { delayMs: 0 }, postDelayMs: 0 };
  return Object.assign({ id: 'st_' + idx, label: '', config: {}, postDelayMs: 0 }, s);
}

async function maybePostDelay(step, signal) {
  const pd = Number(step.postDelayMs);
  if (pd && pd > 0) await cancellableDelay(pd, signal);
}

/**
 * 对 action.execute 套一层软超时（非强制中断，到期后继续跑但场景记为 ACTION_TIMEOUT）。
 * 可选：signal.aborted 直接拒绝。
 */
function withActionTimeout(action, ctx, timeoutMs, signal) {
  return new Promise(async (resolve, reject) => {
    let finished = false;
    let tid = null;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(tid);
      reject(SceneError.fromCode('CANCELLED'));
    };
    if (signal) signal.once('abort', onAbort);
    tid = setTimeout(() => {
      if (finished) return;
      // 超时不主动杀死 action.execute；这里标记一个软警告（MVP 策略：不 resolve 不 reject 继续等，
      // 等 action 实际结束后再按超时继续？MVP 选择：直接抛 ACTION_TIMEOUT 让 failBehavior 决定）
      if (!finished) {
        finished = true;
        if (signal) signal.off('abort', onAbort);
        reject(SceneError.fromCode('ACTION_TIMEOUT', `${action.type} 步骤超过 ${timeoutMs}ms`));
      }
    }, Math.max(50, Math.floor(Number(timeoutMs) || DEFAULT_OPT.defaultStepTimeoutMs)));

    try {
      const r = await action.execute(ctx);
      if (!finished) { finished = true; clearTimeout(tid); if (signal) signal.off('abort', onAbort); resolve(r); }
    } catch (e) {
      if (!finished) { finished = true; clearTimeout(tid); if (signal) signal.off('abort', onAbort); reject(e); }
    }
  });
}

function updateNodeStatusOk(node, i, len, type) {
  try {
    node.status({ fill: 'green', shape: i + 1 >= len ? 'dot' : 'ring', text: `${i + 1}/${len} ${type}` });
  } catch (e) {}
}
function updateNodeStatusErr(node, i, len, type, code) {
  try {
    node.status({ fill: 'red', shape: 'dot', text: `${i + 1}/${len} ${type} ${code}` });
  } catch (e) {}
}

function cloneSafe(v) {
  if (v == null) return v;
  if (typeof v !== 'object' && typeof v !== 'function') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; }
}

module.exports = { runSteps, normalizeStep };
