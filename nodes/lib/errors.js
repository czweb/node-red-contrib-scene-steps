/* eslint-disable */
/**
 * scene-steps — nodes/lib/errors.js
 * SceneError 自定义错误类 + 错误码枚举。
 * 所有动作抛出的错误请使用 throw SceneError.fromCode(code, detail)
 * 或 throw new SceneError(message, { code, recoverable, detail })
 */

'use strict';

const ERROR_CODES = Object.freeze({
  // 通用
  CONFIG_INVALID:         { code: 'CONFIG_INVALID',         recoverable: false, level: 'error'    },
  ACTION_ERROR:           { code: 'ACTION_ERROR',           recoverable: true,  level: 'error'    },
  ACTION_TIMEOUT:         { code: 'ACTION_TIMEOUT',         recoverable: true,  level: 'warn'     },
  CANCELLED:              { code: 'CANCELLED',              recoverable: false, level: 'info'     },
  PAUSED:                 { code: 'PAUSED',                 recoverable: false, level: 'info'     },

  // 流控 / 执行器
  LOOP_LIMIT:             { code: 'LOOP_LIMIT',             recoverable: false, level: 'error'    },
  LABEL_NOT_FOUND:        { code: 'LABEL_NOT_FOUND',        recoverable: false, level: 'error'    },
  NESTED_RECURSION:       { code: 'NESTED_RECURSION',       recoverable: false, level: 'critical' },
  NEST_TOO_DEEP:          { code: 'NEST_TOO_DEEP',          recoverable: false, level: 'error'    },
  CONDITION_TIMEOUT:      { code: 'CONDITION_TIMEOUT',      recoverable: true,  level: 'warn'     },

  // 网络
  TCP_CONN_REFUSED:       { code: 'TCP_CONN_REFUSED',       recoverable: true,  level: 'warn'     },
  TCP_CONN_TIMEOUT:       { code: 'TCP_CONN_TIMEOUT',       recoverable: true,  level: 'warn'     },
  TCP_SEND_ERROR:         { code: 'TCP_SEND_ERROR',         recoverable: true,  level: 'warn'     },
  TCP_RECV_TIMEOUT:       { code: 'TCP_RECV_TIMEOUT',       recoverable: true,  level: 'warn'     },
  UDP_SEND_ERROR:         { code: 'UDP_SEND_ERROR',         recoverable: true,  level: 'warn'     },
  HTTP_STATUS:            { code: 'HTTP_STATUS',            recoverable: true,  level: 'warn'     },
  HTTP_TIMEOUT:           { code: 'HTTP_TIMEOUT',           recoverable: true,  level: 'warn'     },
  HTTP_REQUEST_ERR:       { code: 'HTTP_REQUEST_ERR',       recoverable: true,  level: 'warn'     },
  MQTT_NOT_CONNECTED:     { code: 'MQTT_NOT_CONNECTED',     recoverable: true,  level: 'warn'     },
  MQTT_CONFIG_MISSING:    { code: 'MQTT_CONFIG_MISSING',    recoverable: false, level: 'error'    },
  MQTT_PUBLISH_ERROR:     { code: 'MQTT_PUBLISH_ERROR',     recoverable: true,  level: 'warn'     },

  // 安全
  SCENE_TAMPERED:         { code: 'SCENE_TAMPERED',         recoverable: false, level: 'critical' },
  TEMPLATE_UNSAFE:        { code: 'TEMPLATE_UNSAFE',        recoverable: false, level: 'error'    },
  PERMISSION_DENIED:      { code: 'PERMISSION_DENIED',      recoverable: false, level: 'error'    }
});

class SceneError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SceneError';
    this.code = opts.code || ERROR_CODES.ACTION_ERROR.code;
    this.recoverable = typeof opts.recoverable === 'boolean' ? opts.recoverable : true;
    this.level = opts.level || ERROR_CODES.ACTION_ERROR.level;
    this.detail = opts.detail || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SceneError);
  }

  static fromCode(code, detail) {
    const def = ERROR_CODES[code] || ERROR_CODES.ACTION_ERROR;
    const msg = (detail && typeof detail === 'string') ? `${code}: ${detail}` : code;
    return new SceneError(msg, {
      code: def.code,
      recoverable: def.recoverable,
      level: def.level,
      detail: detail && typeof detail !== 'string' ? detail : undefined
    });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      level: this.level,
      detail: this.detail
    };
  }
}

module.exports = { SceneError, ERROR_CODES };
