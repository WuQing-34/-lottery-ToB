'use strict';

const { EventEmitter } = require('events');

// 进程内事件总线：业务层发生变化时通知 SSE 推送
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
