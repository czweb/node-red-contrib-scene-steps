/* eslint-disable */
/**
 * scene-steps — actions/label.js
 * 标签动作：自身不做事，但 executor 预处理阶段会把所有 label 的 stepIndex 记录到 labelMap。
 */

'use strict';

const { SceneError } = require('../nodes/lib/errors');

const action = {
  type: 'label',
  category: 'flow',
  icon: 'fa-bookmark',
  label: '标签',
  configSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string', title: '标签名称', default: 'my_label', minLength: 1, maxLength: 64,
        pattern: '^[A-Za-z_][A-Za-z0-9_\\-]*$',
        description: '仅允许字母数字下划线短横线；开头必须字母或下划线'
      }
    }
  },
  defaults: { name: 'my_label' },
  validate(cfg) {
    if (!cfg.name || typeof cfg.name !== 'string') throw new Error('标签名必填');
    if (!/^[A-Za-z_][A-Za-z0-9_\-]{0,63}$/.test(cfg.name)) throw SceneError.fromCode('CONFIG_INVALID', '标签名不符合格式');
    return true;
  },
  async execute(ctx) {
    return { output: { name: ctx.config.name } };
  }
};

module.exports = action;
