/* eslint-disable */
/**
 * scene-steps — actions/stop.js
 * 主动终止当前场景运行。
 * flow="stop" 会被 executor 拦截并跳出主循环。
 */

'use strict';

const action = {
  type: 'stop',
  category: 'flow',
  icon: 'fa-stop-circle',
  label: '停止场景',
  configSchema: {
    type: 'object',
    properties: {
      reason:      { type: 'string',  title: '停止原因', default: '', description: '显示在 Audit/Error 日志中' },
      emitAsDone:  { type: 'boolean', title: '作为 Done 而非 Error 输出', default: true }
    }
  },
  defaults: { reason: '', emitAsDone: true },
  validate() { return true; },
  async execute(ctx) {
    return {
      flow: 'stop',
      output: {
        reason: ctx.config.reason || '用户停止',
        emitAsDone: !!ctx.config.emitAsDone
      }
    };
  }
};

module.exports = action;
