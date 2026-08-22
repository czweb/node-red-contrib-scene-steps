/* eslint-disable */
/**
 * scene-steps — actions/jump.js
 * 跳转动作：flow="jump" 指令交由 executor 主循环处理。
 */

'use strict';

const { evalExpression } = require('../nodes/lib/template');
const { SceneError } = require('../nodes/lib/errors');

const action = {
  type: 'jump',
  category: 'flow',
  icon: 'fa-share',
  label: '跳转标签',
  configSchema: {
    type: 'object',
    required: ['target'],
    properties: {
      target:   { type: 'string',  title: '目标标签名', default: '', minLength: 1 },
      max:      { type: 'number',  title: '最大跳转次数', default: 1000, minimum: 1, maximum: 1000000 },
      whenExpr: { type: 'string',  title: '条件表达式(可选)', default: '', description: '例如 vars.code != 200；留空表示无条件跳转' }
    }
  },
  defaults: { target: '', max: 1000, whenExpr: '' },
  validate(cfg) {
    if (!cfg.target) throw new Error('jump 必须指定目标标签(target)');
    const n = Number(cfg.max);
    if (!Number.isFinite(n) || n < 1) throw SceneError.fromCode('CONFIG_INVALID', 'jump.max 必须为 ≥1 的数字');
    return true;
  },
  async execute(ctx) {
    const expr = (ctx.config.whenExpr || '').trim();
    if (expr) {
      const ok = evalExpression(expr, { vars: ctx.vars, outputs: ctx.outputs || [] });
      if (!ok) return { output: { skipped: true, reason: 'whenExpr=false' } };
    }
    return {
      flow: 'jump',
      target: String(ctx.config.target),
      max: Number(ctx.config.max) || 1000,
      output: { target: ctx.config.target }
    };
  }
};

module.exports = action;
