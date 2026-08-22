/* eslint-disable */
/**
 * scene-steps — actions/index.js
 * 按 require 顺序聚合所有内置动作，自动注册到 registry。
 * 新增动作：写一个 .js 文件，然后在下面加 require 即可。
 */

'use strict';

const registry = require('../nodes/lib/registry');

// === Flow control ===
registry.register(require('./delay'));
registry.register(require('./stop'));
registry.register(require('./label'));
registry.register(require('./jump'));
registry.register(require('./call_scene'));
registry.register(require('./condition_wait'));

// === Network ===
registry.register(require('./tcp_send'));
registry.register(require('./udp_send'));
registry.register(require('./http_request'));
registry.register(require('./mqtt_publish'));

module.exports = registry;
