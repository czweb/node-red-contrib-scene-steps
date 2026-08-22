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
      mode:          { type: 'string',  title: '模式', enum: ['inline_steps', 'steps_from_var'], default: 'inline_steps' },
      inline_steps:  { type: 'array',   title: '内嵌步骤数组', default: [], items: { type: 'object' } },
      stepsVar:      { type: 'string',  title: '变量名(mode=steps_from_var 时)', default: '' },
      inheritVars:   { type: 'boolean', title: '继承父场景变量', default: true },
      injectVars:    { type: 'object',  title: '注入额外变量(JSON)', default: {} }
    }
  },
  defaults: { mode: 'inline_steps', inline_steps: [], stepsVar: '', inheritVars: true, injectVars: {} },
  validate(cfg) {
    if (cfg.mode === 'inline_steps') {
      if (!Array.isArray(cfg.inline_steps)) throw new Error('inline_steps 必须是数组');
    } else if (cfg.mode === 'steps_from_var') {
      if (!cfg.stepsVar) throw new Error('stepsVar 不能为空');
    } else {
      throw new Error('mode 必须为 inline_steps 或 steps_from_var');
    }
    return true;
  },
  async execute(ctx) {
    let subSteps;
    if (ctx.config.mode === 'inline_steps') subSteps = ctx.config.inline_steps;
    else {
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
    //   1) runSteps 入口把 steps 的 fingerprint 入 ancestors 链，与历史重复即抛 NESTED_RECURSION
    //   2) 链长度 > maxDepth 抛 NEST_TOO_DEEP
    // 这里不再重复入链，避免指纹在链上 double。
    const result = await ctx.runNested(subSteps /* 不传 extraAncestor，executor 自己负责 fingerprint 查重 */);
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
