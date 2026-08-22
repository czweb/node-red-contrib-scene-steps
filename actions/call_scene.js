/* eslint-disable */
/**
 * scene-steps — actions/call_scene.js
 * 嵌套子场景。MVP 只支持 inline_steps（把步骤数组内嵌在 config 内）。
 * 通过 ctx.runNested(subSteps, extraAncestor) 递归调用 executor.runSteps，
 * 自动触发祖先链查重 / 深度限制。
 */

'use strict';

const { SceneError } = require('../nodes/lib/errors');

const action = {
  type: 'call_scene',
  category: 'flow',
  icon: 'fa-film',
  label: '子场景',
  configSchema: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode:          { type: 'string',  title: '模式', enum: ['ref_scene', 'inline_steps', 'steps_from_var'], default: 'ref_scene' },
      refSceneId:    { type: 'string',  title: '引用场景(mode=ref_scene)', default: '', format: 'select-scene' },
      inline_steps:  { type: 'array',   title: '内嵌步骤数组', default: [], items: { type: 'object' } },
      stepsVar:      { type: 'string',  title: '变量名(mode=steps_from_var 时)', default: '' },
      inheritVars:   { type: 'boolean', title: '继承父场景变量', default: true },
      injectVars:    { type: 'object',  title: '注入额外变量(JSON)', default: {} }
    }
  },
  defaults: { mode: 'ref_scene', refSceneId: '', inline_steps: [], stepsVar: '', inheritVars: true, injectVars: {} },
  validate(cfg) {
    if (cfg.mode === 'ref_scene') {
      if (!cfg.refSceneId) throw new Error('refSceneId 不能为空（请在编辑器下拉选择目标场景）');
    } else if (cfg.mode === 'inline_steps') {
      if (!Array.isArray(cfg.inline_steps)) throw new Error('inline_steps 必须是数组');
    } else if (cfg.mode === 'steps_from_var') {
      if (!cfg.stepsVar) throw new Error('stepsVar 不能为空');
    } else {
      throw new Error('mode 必须是 ref_scene / inline_steps / steps_from_var');
    }
    return true;
  },
  async execute(ctx) {
    let subSteps;
    let childSceneId = '';   // 仅 ref_scene 模式有值，用于循环检测
    if (ctx.config.mode === 'ref_scene') {
      const refId = String(ctx.config.refSceneId || '');
      if (!refId) throw SceneError.fromCode('CONFIG_INVALID', 'ref_scene 模式: refSceneId 为空');
      // 从 RED.nodes 枚举所有 scene-steps 节点，找匹配 sceneId 的那个
      const RED = ctx.node && ctx.node._red ? ctx.node._red : null;
      // 兼容：scene-steps.js 把 RED 挂到 node 上（_red）；否则尝试 ctx.red
      const redApi = RED || ctx.red || (typeof global !== 'undefined' && global.__sceneStepsRED) || null;
      if (!redApi || typeof redApi.nodes.eachNode !== 'function') {
        throw SceneError.fromCode('CONFIG_INVALID', 'ref_scene 模式: 无法访问 RED.nodes（运行时未注入）');
      }
      let target = null;
      redApi.nodes.eachNode(function (n) {
        if (target) return;
        if (n && n.type === 'scene-steps' && n.sceneId === refId) target = n;
      });
      if (!target) throw SceneError.fromCode('CONFIG_INVALID', `找不到 sceneId="${refId}" 的 scene-steps 节点`);
      // target.steps 可能是字符串或数组（normalizeSteps 在节点构造时已处理）
      subSteps = Array.isArray(target.steps) ? target.steps : [];
      // 深拷贝避免引用污染
      try { subSteps = JSON.parse(JSON.stringify(subSteps)); } catch (e) { /* 用原引用 */ }
      childSceneId = refId;
    } else if (ctx.config.mode === 'inline_steps') {
      subSteps = ctx.config.inline_steps;
    } else {
      const v = ctx.vars[String(ctx.config.stepsVar)];
      if (!Array.isArray(v)) throw SceneError.fromCode('CONFIG_INVALID', `变量 ${ctx.config.stepsVar} 不是步骤数组`);
      subSteps = v;
    }
    if (!Array.isArray(subSteps) || subSteps.length === 0) {
      return { output: { okCount: 0, skipped: true, reason: 'empty sub steps' } };
    }

    // 可选注入变量
    if (ctx.config.injectVars && typeof ctx.config.injectVars === 'object') {
      Object.assign(ctx.vars, ctx.config.injectVars);
    }

    // 注：递归/深度的防护已经在 executor.runSteps 入口做：
    //   1) fingerprint 祖先链：inline_steps 内容重复检测
    //   2) sceneAncestors 链：ref_scene 间接循环检测 A→B→C→A
    //   3) 链长度 > maxDepth 抛 NEST_TOO_DEEP
    // ref_scene 模式把被调用场景的 sceneId 透传给 runNested，让子 runSteps 入口查重
    const extraAncestor = `scene:${childSceneId}`;
    const result = await ctx.runNested(subSteps, extraAncestor, childSceneId);
    if (result && result.error) throw result.error;
    return {
      output: {
        okCount: result.okCount,
        skipCount: result.skipCount,
        errorCount: result.errorCount,
        totalDurationMs: result.totalDurationMs,
        childHistorySummary: (result.history || []).slice(0, 50) // 只保留前 50 条 summary，防止 msg 过大
      },
      varsMerge: (ctx.config.inheritVars !== false) ? result.vars || {} : undefined
    };
  }
};

module.exports = action;
