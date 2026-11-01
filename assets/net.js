/*!
 * 同词相见 · MQTT 联机层
 * - 公共 broker 多服务器保底（与化学棋 Chemiss 同款思路：多个免费 broker + 超时切换）
 * - 房间号哈希决定首选服务器，双方按同一顺序尝试，避免两人连到不同集群
 * - 浏览器 WebSocket(WSS) 直连，无需后端；断线由 mqtt.js 自动重连
 */
(function (root) {
  'use strict';

  var BROKERS = [
    { id: 'emqx-global', label: 'EMQX 国际', url: 'wss://broker.emqx.io:8084/mqtt' },
    { id: 'emqx-cn', label: 'EMQX 中国', url: 'wss://broker-cn.emqx.io:8084/mqtt' },
    { id: 'mosquitto', label: 'Mosquitto 测试', url: 'wss://test.mosquitto.org:8081/mqtt' }
  ];

  var CDN_SOURCES = [
    'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js',
    'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
    'https://fastly.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js'
  ];

  var TOPIC_PREFIX = 'tongci/v1/';
  var PROTOCOL_VERSION = 1;
  var MAX_PAYLOAD_BYTES = 4096;
  var CONNECT_TIMEOUT_MS = 9000;
  var BROKER_RETRY_DELAY_MS = 250;

  var libPromise = null;
  var libSourcesTried = [];

  function scriptSources() {
    // 本地 vendor 优先（离线可用），其次公共 CDN
    return ['vendor/mqtt.min.js'].concat(CDN_SOURCES);
  }

  function loadScript(src, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('加载超时: ' + src));
      }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        tag.onload = null;
        tag.onerror = null;
      }
      tag.async = true;
      tag.src = src;
      tag.onload = function () { cleanup(); resolve(src); };
      tag.onerror = function () { cleanup(); reject(new Error('加载失败: ' + src)); };
      document.head.appendChild(tag);
    });
  }

  function loadMqttLibrary(force) {
    if (root.mqtt && typeof root.mqtt.connect === 'function') return Promise.resolve(root.mqtt);
    if (libPromise && !force) return libPromise;
    libSourcesTried = [];
    libPromise = new Promise(function (resolve, reject) {
      var sources = scriptSources();
      var index = 0;
      function next() {
        if (index >= sources.length) {
          reject(new Error('MQTT 库全部加载失败'));
          return;
        }
        var src = sources[index++];
        libSourcesTried.push(src);
        loadScript(src, 9000)
          .then(function () {
            if (root.mqtt && typeof root.mqtt.connect === 'function') resolve(root.mqtt);
            else next();
          })
          .catch(function () { next(); });
      }
      next();
    });
    libPromise.catch(function () { libPromise = null; });
    return libPromise;
  }

  function createClientId() {
    return 'tc' + Math.random().toString(36).slice(2, 10);
  }

  function WordMeetNet(options) {
    options = options || {};
    this.code = options.code || '';
    this.role = options.role || 'host';
    this.name = options.name || '';
    this.onStatus = options.onStatus || function () {};
    this.onMessage = options.onMessage || function () {};
    this.onOpen = options.onOpen || function () {};

    this.id = 'p' + Math.random().toString(36).slice(2, 10);
    this.topic = TOPIC_PREFIX + this.code;
    this.client = null;
    this.connected = false;
    this.broker = null;
    this.status = 'idle';
    this._started = false;
    this._closed = false;
    this._mqtt = null;
    this._order = [];
    this._attempt = 0;
    this._libLoaded = false;
  }

  WordMeetNet.prototype.start = function () {
    if (this._started || this._closed) return;
    this._started = true;
    var self = this;
    self._emit('loading');
    loadMqttLibrary(false)
      .then(function (mqtt) {
        if (self._closed) return;
        self._mqtt = mqtt;
        self._libLoaded = true;
        var count = BROKERS.length;
        var preferred = Math.max(1, count - 1); // 最后一台（Mosquitto）仅作保底，不参与首选分配
        var base = 0;
        try {
          base = root.WordMeetEngine ? root.WordMeetEngine.brokerIndexForRoom(self.code, preferred) : 0;
        } catch (_) { base = 0; }
        self._order = [base];
        for (var i = 1; i < preferred; i++) self._order.push((base + i) % preferred);
        for (var j = 0; j < count; j++) {
          if (self._order.indexOf(j) === -1) self._order.push(j);
        }
        self._connectAt(0);
      })
      .catch(function (err) {
        self._emit('failed', { reason: 'lib', message: (err && err.message) || 'MQTT 库加载失败' });
      });
  };

  WordMeetNet.prototype._connectAt = function (index) {
    if (this._closed) return;
    var self = this;
    if (index >= this._order.length) {
      self._emit('failed', { reason: 'brokers', message: '所有公共 MQTT 服务器连接失败' });
      return;
    }
    var broker = BROKERS[this._order[index]];
    this._attempt = index;
    this.broker = broker;
    this._emit('connecting', { broker: broker, attempt: index + 1, total: this._order.length });

    var client;
    try {
      client = this._mqtt.connect(broker.url, {
        clientId: createClientId(),
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 4000,
        keepalive: 30,
        protocolVersion: 4
      });
    } catch (err) {
      setTimeout(function () { self._connectAt(index + 1); }, BROKER_RETRY_DELAY_MS);
      return;
    }
    this.client = client;

    var settled = false;
    var connectedOnce = false;

    function clearFailTimer() {
      if (failTimer) { clearTimeout(failTimer); failTimer = null; }
    }

    var failTimer = setTimeout(function () { fail('timeout'); }, CONNECT_TIMEOUT_MS);

    function fail(reason) {
      if (settled || connectedOnce || self._closed) return;
      settled = true;
      clearFailTimer();
      try { client.end(true); } catch (_) {}
      if (self.client === client) self.client = null;
      self._emit('broker-failed', {
        broker: broker,
        reason: reason,
        attempt: index + 1,
        total: self._order.length
      });
      setTimeout(function () {
        if (!self._closed) self._connectAt(index + 1);
      }, BROKER_RETRY_DELAY_MS);
    }

    client.on('connect', function () {
      if (self._closed) {
        try { client.end(true); } catch (_) {}
        return;
      }
      connectedOnce = true;
      settled = true;
      clearFailTimer();

      client.subscribe(self.topic, { qos: 1 }, function (err) {
        if (err) {
          self._emit('failed', { reason: 'subscribe', message: '订阅房间失败' });
          try { client.end(true); } catch (_) {}
          return;
        }
        self.connected = true;
        self.status = 'connected';
        self._emit('connected', { broker: broker, attempt: self._attempt + 1 });
        try { self.onOpen(); } catch (_) {}
      });
    });

    client.on('message', function (topic, payload) {
      if (topic !== self.topic) return;
      if (!payload || payload.length > MAX_PAYLOAD_BYTES) return;
      var msg;
      try { msg = JSON.parse(payload.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') return;
      if (msg.sid === self.id) return;
      if (msg.role === self.role) return; // 同一角色（例如两个房主）直接忽略
      try { self.onMessage(msg); } catch (err) { console.warn('[tongci] message handler error', err); }
    });

    client.on('error', function (err) {
      console.warn('[tongci][mqtt] error', err && err.message);
      if (!connectedOnce) fail('error');
    });

    client.on('close', function () {
      if (self._closed) return;
      if (connectedOnce) {
        if (self.connected) {
          self.connected = false;
          self.status = 'reconnecting';
          self._emit('reconnecting', { broker: broker });
        }
      } else {
        fail('close');
      }
    });

    client.on('reconnect', function () {
      if (self._closed) return;
      if (self.connected) {
        self.connected = false;
        self.status = 'reconnecting';
        self._emit('reconnecting', { broker: broker });
      }
    });
  };

  WordMeetNet.prototype.send = function (type, data, options) {
    if (!this.connected || !this.client) return false;
    var msg = {
      v: PROTOCOL_VERSION,
      sid: this.id,
      role: this.role,
      name: this.name,
      type: type,
      ts: Date.now()
    };
    if (data && typeof data === 'object') {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key) && key !== 'v' && key !== 'sid' && key !== 'role' && key !== 'type') {
          msg[key] = data[key];
        }
      }
    }
    var qos = options && options.qos != null ? options.qos : 1;
    try {
      this.client.publish(this.topic, JSON.stringify(msg), { qos: qos });
      return true;
    } catch (err) {
      console.warn('[tongci] publish failed', err);
      return false;
    }
  };

  WordMeetNet.prototype.stop = function () {
    if (this._closed) return;
    if (this.connected) {
      try { this.send('goodbye', {}, { qos: 0 }); } catch (_) {}
    }
    this._closed = true;
    this.connected = false;
    this.status = 'closed';
    if (this.client) {
      try { this.client.end(true); } catch (_) {}
      this.client = null;
    }
    this._emit('closed');
  };

  WordMeetNet.prototype.isConnected = function () {
    return !!(this.connected && this.client);
  };

  WordMeetNet.prototype._emit = function (state, extra) {
    this.status = state;
    var payload = { state: state, broker: this.broker || null };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    try { this.onStatus(payload); } catch (err) { console.warn('[tongci] status handler error', err); }
  };

  root.WordMeetNet = WordMeetNet;
  root.WordMeetNet.BROKERS = BROKERS;
  root.WordMeetNet.CDN_SOURCES = CDN_SOURCES;
  root.WordMeetNet.loadMqttLibrary = loadMqttLibrary;
})(typeof globalThis !== 'undefined' ? globalThis : this);
