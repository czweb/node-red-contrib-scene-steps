/**
 * actions/condition_wait.js
 *  每 intervalMs 毫秒执行一次表达式 evalExpression(expression)，结果为 true 即通过；
 *  超过 maxMs 抛 STEP_TIMEOUT（由 failBehavior 决定后续行为）。
 *  表达式上下文：vars / input / outputs / env，和模板一致。
 */
'use strict';

const { SceneError } = require('../nodes/lib/errors');
const { evalExpression, deepInterpolate } = require('../nodes/lib/template');
const { cancellableDelay } = require('../nodes/lib/cancel');

module.exports = {
  type: 'condition_wait',
  category: 'flow',
  icon: 'fa-clock-o',
  label: '等待条件',
  configSchema: {
    expression: { type: 'string', template: true, required: true, label: '条件表达式', format: 'textarea',
      hint: '如 vars.cnt >= 5 / outputs[-1].result==="ok" / vars.status === "online" ' },
    intervalMs: { type: 'number', min: 1, max: 60000, default: 200, label: '轮询间隔(ms)' },
    maxMs: { type: 'number', min: 1, default: 30000, label: '最长等待(ms)' },
    ignoreStepTimeout: { type: 'boolean', default: true, label: '等待不触发步骤超时（maxMs 为准）' }
  },
  defaults: { expression: '', intervalMs: 200, maxMs: 30000, ignoreStepTimeout: true },
  validate(config) {
    const expr = String(config.expression || '').trim();
    if (!expr) throw SceneError.fromCode('BAD_CONFIG', 'condition_wait: expression 不能为空');
    if (!(Number(config.maxMs) >= 1)) throw SceneError.fromCode('BAD_CONFIG', 'condition_wait: maxMs 必须 >= 1');
  },
  async execute(ctx) {
    const c = ctx.config;
    const interval = Math.max(1, Number(c.intervalMs) || 200);
    const maxMs = Math.max(1, Number(c.maxMs) || 30000);
    const start = Date.now();
    let ticks = 0;
    let last = false;
    while (Date.now() - start < maxMs) {
      if (ctx.signal && ctx.signal.aborted) throw SceneError.fromCode('CANCELLED');
      // 暂停：等
      if (ctx.signal && ctx.signal.paused) await ctx.signal.ifPausedWait();
      // 表达式上下文：和 executor 中 interpolate/evalExpression 一致
      const tmplCtx = { vars: ctx.vars, input: (ctx.step && ctx.config), outputs: ctx.outputs || [] };
      // expression 本身可能含模板（用户写 vars.{{step}}），先插值再 eval
      const expr = deepInterpolate(String(c.expression || ''), tmplCtx);
      try {
        last = !!evalExpression(expr, {
          vars: ctx.vars,
          outputs: ctx.outputs || [],
          env: process.env,
          flow: {}
        });
      } catch (e) {
        // 解析失败按 false 继续轮询（直到超时或 expr 合法）
        last = false;
      }
      ticks++;
      if (last) {
        return { output: { expression: String(c.expression), elapsedMs: Date.now() - start, ticks } };
      }
      // 下一次轮询
      try { await cancellableDelay(interval, ctx.signal); } catch (e) { throw SceneError.fromCode('CANCELLED'); }
    }
    throw SceneError.fromCode('STEP_TIMEOUT', `condition_wait 超 ${maxMs}ms，表达式仍 false。最后一次=${last}`);
  }
};
