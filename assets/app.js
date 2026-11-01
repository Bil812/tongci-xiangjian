/*!
 * 同词相见 · 应用层
 * 页面状态机 / 房间 / 对局 / 结算 / 历史 / 单人试玩
 */
(function () {
  'use strict';

  var E = window.WordMeetEngine;
  var W = window.WordMeetWords;
  var Net = window.WordMeetNet;
  if (!E || !W || !Net) {
    console.error('[同词相见] 依赖脚本加载失败（words.js / engine.js / net.js）');
    return;
  }

  var CONFIG = window.__TongCiConfig || {};
  var ROUND_MS = Number(CONFIG.roundMs) > 0 ? Number(CONFIG.roundMs) : 45000;
  var PRESENCE_MS = Number(CONFIG.presenceMs) > 0 ? Number(CONFIG.presenceMs) : 5000;
  var PEER_TIMEOUT_MS = Number(CONFIG.peerTimeoutMs) > 0 ? Number(CONFIG.peerTimeoutMs) : 18000;
  var SYNC_THROTTLE_MS = 3500;
  var MAX_ROUNDS = Math.max(2, Math.min(9, Number(CONFIG.maxRounds) || 6));
  var MAX_HISTORY = 50;
  var KEYS = { profile: 'tongci.profile.v1', history: 'tongci.history.v1' };

  var App = {
    mode: null,
    role: null,
    roomCode: '',
    broker: null,
    connected: false,
    firstPrompt: true,
    net: null,
    peer: null,
    me: null,
    game: null,
    saved: false,
    _presence: null,
    _ticker: null,
    _lastPeerSeen: 0,
    _lastSyncSent: 0,
    _lastStateRequest: 0,
    _helloRepliedAt: 0,
    _revealScheduled: false,
    _revealTimer: null,
    _guestFallbackTimer: null,
    _finishFallbackTimer: null,
    _soloTimer: null,
    _lobbyHintTimer: null,
    _demoTimer: null,
    _demoIndex: 0,
    _toastTimer: null,
    _clearTimer: null,
    _clearArmed: false,
    _guestTimeoutHandled: false,
    _leaving: false
  };

  var els = {};
  var profile = { name: '' };

  /* ======================================================================
     基础工具
     ====================================================================== */

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function firstChar(name) {
    var chars = Array.from(String(name || '').trim());
    return chars.length ? chars[0] : '?';
  }

  function storeRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  }

  function storeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  function toast(message, ms) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('is-show');
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(function () { els.toast.classList.remove('is-show'); }, ms || 2400);
  }

  function loadProfile() {
    var saved = storeRead(KEYS.profile, null);
    if (saved && typeof saved === 'object') {
      if (saved.name) profile.name = String(saved.name).slice(0, 12);
      profile.firstPrompt = saved.firstPrompt !== false;
    }
    if (!profile.name) {
      profile.name = E.pickOne(W.DEFAULT_NICKNAMES);
      profile.firstPrompt = true;
      storeWrite(KEYS.profile, profile);
    }
    App.firstPrompt = profile.firstPrompt !== false;
  }

  function getNickname() {
    var name = String(profile.name || '').trim().slice(0, 12);
    if (!name) {
      name = E.pickOne(W.DEFAULT_NICKNAMES);
      profile.name = name;
      storeWrite(KEYS.profile, profile);
    }
    if (els.nickname) els.nickname.value = name;
    return name;
  }

  /* ======================================================================
     界面切换 / 覆盖层
     ====================================================================== */

  function showScreen(name) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.toggle('is-active', screens[i].getAttribute('data-screen') === name);
    }
    try { window.scrollTo(0, 0); } catch (_) {}
  }

  function activeScreen() {
    var el = document.querySelector('.screen.is-active');
    return el ? el.getAttribute('data-screen') : '';
  }

  function openOverlay(id) {
    var el = $(id);
    if (!el) return;
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeOverlay(id) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.overlay.is-open')) document.body.style.overflow = '';
  }

  function closeAllOverlays() {
    var list = document.querySelectorAll('.overlay.is-open');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.remove('is-open');
      list[i].setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
  }

  /* ======================================================================
     首页
     ====================================================================== */

  function renderHomeMeta() {
    var list = storeRead(KEYS.history, []);
    var stats = E.aggregateHistory(Array.isArray(list) ? list : []);
    if (els.homeMeta) {
      if (!stats.games) {
        els.homeMeta.textContent = '公共 MQTT 实时联机 · 最多 ' + MAX_ROUNDS + ' 轮';
      } else {
        els.homeMeta.textContent = '已记录 ' + stats.games + ' 局 · 累计相遇 ' + stats.matches + ' 次';
      }
    }
  }

  function setDemoPair(index) {
    var pair = W.DEMO_PAIRS[index % W.DEMO_PAIRS.length];
    if (!pair) return;
    var a = els.demo.querySelector('[data-demo="a"]');
    var b = els.demo.querySelector('[data-demo="b"]');
    var cText = els.demo.querySelector('[data-demo-text]');
    if (a) a.textContent = pair.a;
    if (b) b.textContent = pair.b;
    if (cText) cText.textContent = pair.target;
  }

  function initDemo() {
    if (!els.demo) return;
    setDemoPair(0);
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    if (reduce) return;
    clearInterval(App._demoTimer);
    App._demoTimer = setInterval(function () {
      if (document.hidden || !els.demo) return;
      els.demo.classList.add('is-swapping');
      setTimeout(function () {
        App._demoIndex = (App._demoIndex + 1) % W.DEMO_PAIRS.length;
        setDemoPair(App._demoIndex);
        els.demo.classList.remove('is-swapping');
        var chips = els.demo.querySelectorAll('.chip');
        for (var i = 0; i < chips.length; i++) {
          (function (chip, idx) {
            chip.style.animationDelay = (idx * 70) + 'ms';
            chip.classList.remove('is-pop');
            void chip.offsetWidth;
            chip.classList.add('is-pop');
            setTimeout(function () { chip.classList.remove('is-pop'); }, 720);
          })(chips[i], i);
        }
      }, 300);
    }, 4600);
  }

  /* ======================================================================
     开始游戏面板
     ====================================================================== */

  function openModeSheet() {
    getNickname();
    els.joinPanel.hidden = true;
    els.inputCode.value = '';
    renderFirstPromptControls();
    openOverlay('overlay-mode');
  }

  function renderFirstPromptControls() {
    var value = App.firstPrompt !== false;
    var buttons = document.querySelectorAll('[data-first-prompt]');
    for (var i = 0; i < buttons.length; i++) {
      var btnValue = buttons[i].getAttribute('data-first-prompt') === '1';
      buttons[i].classList.toggle('is-on', btnValue === value);
    }
    if (els.lobbyFirstPrompt) {
      els.lobbyFirstPrompt.textContent = value ? '系统提示词' : '自由发挥';
    }
    if (els.btnToggleFirst) {
      els.btnToggleFirst.hidden = !(App.mode === 'online' && App.role === 'host');
      els.btnToggleFirst.textContent = value ? '改成自由发挥' : '改成系统提示';
    }
  }

  function setFirstPrompt(value) {
    App.firstPrompt = !!value;
    profile.firstPrompt = App.firstPrompt;
    storeWrite(KEYS.profile, profile);
    renderFirstPromptControls();
    if (App.mode === 'online' && App.role === 'host' && App.net && App.net.isConnected()) {
      App.net.send('setting', { firstPrompt: App.firstPrompt });
    }
  }

  function showJoinPanel(prefill) {
    els.joinPanel.hidden = false;
    if (prefill) els.inputCode.value = E.sanitizeRoomCode(prefill);
    setTimeout(function () { try { els.inputCode.focus(); } catch (_) {} }, 120);
  }

  function createRoom() {
    closeOverlay('overlay-mode');
    startOnline('host');
  }

  function joinRoomFromInput() {
    var code = E.sanitizeRoomCode(els.inputCode.value);
    els.inputCode.value = code;
    if (!E.isValidRoomCode(code) || code.length !== 6) {
      toast('房间号是 6 位字母或数字');
      try { els.inputCode.focus(); } catch (_) {}
      return;
    }
    closeOverlay('overlay-mode');
    startOnline('guest', code);
  }

  /* ======================================================================
     联机：建立房间
     ====================================================================== */

  function startOnline(role, code) {
    teardownNet();
    clearGameTimers();
    App.mode = 'online';
    App.role = role;
    App.roomCode = role === 'host' ? E.generateRoomCode() : code;
    App.me = { name: getNickname(), ready: false };
    App.peer = { name: '', online: false, ready: false, isAi: false };
    App.game = null;
    App.saved = false;
    App.connected = false;
    App.broker = null;
    App.firstPrompt = role === 'host' ? profile.firstPrompt !== false : true;
    App._lastPeerSeen = 0;
    App._lastSyncSent = 0;
    App._lastStateRequest = 0;
    App._guestTimeoutHandled = false;
    App._revealScheduled = false;
    showScreen('lobby');
    renderLobby();
    setConnPill('connecting');
    scheduleLobbyHint();

    var net = new Net({
      code: App.roomCode,
      role: role,
      name: App.me.name,
      onStatus: onNetStatus,
      onMessage: onNetMessage,
      onOpen: onNetOpen
    });
    App.net = net;
    net.start();
    startPresenceLoop();
  }

  function teardownNet() {
    stopPresenceLoop();
    if (App.net) {
      try { App.net.stop(); } catch (_) {}
      App.net = null;
    }
    App.connected = false;
  }

  function retryConnect() {
    if (App.mode !== 'online' || !App.roomCode) return;
    var role = App.role;
    var code = App.roomCode;
    teardownNet();
    App.peer = { name: '', online: false, ready: false, isAi: false };
    App.connected = false;
    App.broker = null;
    setConnPill('connecting');
    els.btnRetry.hidden = true;
    var net = new Net({
      code: code,
      role: role,
      name: App.me.name,
      onStatus: onNetStatus,
      onMessage: onNetMessage,
      onOpen: onNetOpen
    });
    App.net = net;
    net.start();
    startPresenceLoop();
    toast('正在重新连接公共服务器…');
  }

  function brokerLabel(broker) {
    var b = broker || App.broker;
    return b && b.label ? b.label : '公共服务器';
  }

  function setConnPill(state, broker) {
    if (!els.lobbyConn) return;
    els.lobbyConn.setAttribute('data-state', state);
    var text = els.lobbyConn.querySelector('.conn-text');
    if (!text) return;
    if (state === 'connected') {
      text.textContent = '已连接 · ' + brokerLabel(broker);
      els.btnRetry.hidden = true;
    } else if (state === 'connecting' || state === 'loading') {
      text.textContent = '连接中…';
    } else if (state === 'reconnecting') {
      text.textContent = '重连中…';
    } else if (state === 'failed') {
      text.textContent = '连接失败';
      els.btnRetry.hidden = false;
    } else if (state === 'closed') {
      text.textContent = '已断开';
    } else {
      text.textContent = '连接中…';
    }
  }

  function onNetStatus(status) {
    if (!status) return;
    var state = status.state;
    if (status.broker) App.broker = status.broker;
    if (state === 'connected') {
      App.connected = true;
      setConnPill('connected', status.broker);
      if (activeScreen() === 'lobby') renderLobby();
    } else if (state === 'connecting' || state === 'loading') {
      App.connected = false;
      setConnPill('connecting', status.broker);
    } else if (state === 'reconnecting') {
      App.connected = false;
      setConnPill('reconnecting');
      toast('网络有点抖，正在重连…', 2000);
    } else if (state === 'failed') {
      App.connected = false;
      setConnPill('failed');
      toast(status.message || '连不上公共服务器，请检查网络后重试', 2800);
      if (activeScreen() === 'lobby') {
        els.lobbyHint.textContent = '连不上公共服务器。检查网络后点「重新连接」。';
        els.btnRetry.hidden = false;
      }
    } else if (state === 'closed') {
      App.connected = false;
    }
  }

  function onNetOpen() {
    App.connected = true;
    sendHello(false);
    sendPresence();
    if (App.role === 'host' && App.game && App.game.phase !== 'done') sendSync(true);
    if (App.role === 'guest' && App.game && App.game.phase !== 'done') sendHello(true);
    if (activeScreen() === 'lobby') renderLobby();
  }

  function startPresenceLoop() {
    stopPresenceLoop();
    App._lastPeerSeen = Date.now();
    App._presence = setInterval(function () {
      if (!App.net || !App.net.isConnected()) return;
      sendPresence();
      if (App.peer && App.peer.online && Date.now() - App._lastPeerSeen > PEER_TIMEOUT_MS) {
        markPeerOffline('对方好像断线了…');
      }
    }, PRESENCE_MS);
    setTimeout(function () {
      if (App.net && App.net.isConnected()) sendPresence();
    }, 350);
  }

  function stopPresenceLoop() {
    if (App._presence) { clearInterval(App._presence); App._presence = null; }
  }

  function sendHello(needState) {
    if (!App.net || !App.net.isConnected()) return;
    var g = App.game;
    App.net.send('hello', {
      ready: !!(App.me && App.me.ready),
      phase: g ? g.phase : 'lobby',
      round: g ? g.round : -1,
      needState: !!needState
    });
  }

  function sendPresence() {
    if (!App.net || !App.net.isConnected()) return;
    var g = App.game;
    App.net.send('presence', {
      ready: !!(App.me && App.me.ready),
      phase: g ? g.phase : 'lobby',
      round: g ? g.round : -1,
      firstPrompt: App.firstPrompt !== false
    }, { qos: 0 });
  }

  function markPeerOnline(name) {
    if (!App.peer) return;
    var was = App.peer.online;
    App.peer.online = true;
    App._lastPeerSeen = Date.now();
    if (name && typeof name === 'string') App.peer.name = name.slice(0, 24);
    if (!was) {
      if (App.game && App.game.phase !== 'done') toast((App.peer.name || '对方') + ' 回来了');
      if (activeScreen() === 'lobby') {
        renderLobby();
        clearTimeout(App._lobbyHintTimer);
      }
      if (App.game && App.role === 'host') sendSync(true);
      if (activeScreen() === 'game') renderGame();
      if (activeScreen() === 'summary') renderSummary();
    }
  }

  function markPeerOffline(reason) {
    if (!App.peer) return;
    var was = App.peer.online;
    App.peer.online = false;
    App.peer.ready = false;
    if (was) {
      toast(reason || '对方离开了');
      if (App.game && App.game.phase !== 'done') {
        if (App.role === 'guest') scheduleGuestFallback(4000);
        renderGame();
      }
      if (activeScreen() === 'lobby') renderLobby();
      if (activeScreen() === 'summary') renderSummary();
    }
  }

  function scheduleLobbyHint() {
    clearTimeout(App._lobbyHintTimer);
    App._lobbyHintTimer = setTimeout(function () {
      if (activeScreen() !== 'lobby' || !App.peer || App.peer.online) return;
      if (App.role === 'guest') {
        els.lobbyHint.textContent = '还没有等到房主？确认房间号是否正确，并让房主先创建房间。';
      } else {
        els.lobbyHint.textContent = '还没有人进来。把房间号发给朋友，或复制邀请链接给 ta。';
      }
      if (App.connected && App.role === 'host') {
        els.lobbyTip.innerHTML = '朋友输入房间号后会自动出现。<br>两边的公共服务器需要一致，通常无需处理。';
      }
    }, 12000);
  }

  /* ======================================================================
     消息处理
     ====================================================================== */

  function onNetMessage(msg) {
    if (!msg || !App.peer) return;
    markPeerOnline(msg.name);
    switch (msg.type) {
      case 'hello':
        handleHello(msg);
        break;
      case 'welcome':
        handleWelcome(msg);
        break;
      case 'presence':
        handlePresence(msg);
        break;
      case 'ready':
        App.peer.ready = !!msg.ready;
        if (activeScreen() === 'lobby') renderLobby();
        break;
      case 'setting':
        if (App.role === 'guest' && typeof msg.firstPrompt === 'boolean') {
          App.firstPrompt = msg.firstPrompt;
          renderFirstPromptControls();
          if (activeScreen() === 'lobby') renderLobby();
        }
        break;
      case 'start':
        if (App.role === 'guest') handleStart(msg);
        break;
      case 'round':
        if (App.role === 'guest') handleRound(msg);
        break;
      case 'answer':
        handlePeerAnswer(msg);
        break;
      case 'reveal':
        if (App.role === 'guest') handleReveal(msg);
        break;
      case 'sync':
        if (App.role === 'guest') handleSync(msg);
        break;
      case 'restart':
        if (App.role === 'guest') handleRestart(msg);
        break;
      case 'requestRestart':
        if (App.role === 'host') toast('对方想再来一局，点「再来一局」吧');
        break;
      case 'finish':
        if (App.role === 'guest') handleFinish(msg);
        break;
      case 'goodbye':
      case 'leave':
        markPeerOffline('对方离开了房间');
        break;
      default:
        break;
    }
  }

  function handleHello(msg) {
    if (msg.name) App.peer.name = String(msg.name).slice(0, 24);
    if (App.role === 'host') {
      var snap = App.game && App.game.phase !== 'done' ? snapshot() : null;
      var finished = App.game && App.game.phase === 'done'
        ? {
          success: !!App.game.success,
          roundsUsed: App.game.success ? App.game.roundsUsed : App.game.maxRounds,
          results: App.game.results
        }
        : null;
      if (App.net && App.net.isConnected()) {
        App.net.send('welcome', {
          roomCode: App.roomCode,
          broker: brokerLabel(),
          ready: !!(App.me && App.me.ready),
          firstPrompt: App.firstPrompt !== false,
          state: snap,
          finished: finished
        });
        if (snap) sendSync(true, snap);
      }
      renderLobby();
    } else {
      var now = Date.now();
      if (now - App._helloRepliedAt > 2500) {
        App._helloRepliedAt = now;
        sendHello(!App.game || App.game.phase === 'done');
      }
    }
  }

  function handleWelcome(msg) {
    if (msg.ready != null) App.peer.ready = !!msg.ready;
    if (typeof msg.firstPrompt === 'boolean') App.firstPrompt = msg.firstPrompt;
    if (msg.state) applySnapshot(msg.state);
    if (msg.finished && App.game) {
      if (Array.isArray(msg.finished.results)) {
        for (var i = 0; i < msg.finished.results.length; i++) {
          var r = msg.finished.results[i];
          if (!r || typeof r.round !== 'number') continue;
          applyResult(r.round, {
            kind: r.kind,
            prompt: r.prompt,
            answers: r.answers,
            matched: r.matched
          });
        }
      }
      App.game.success = !!msg.finished.success;
      App.game.roundsUsed = Math.max(0, Number(msg.finished.roundsUsed) || App.game.results.length);
      App.game.phase = 'done';
      finishLocally(false);
      return;
    }
    if (activeScreen() === 'lobby') {
      renderLobby();
      renderFirstPromptControls();
    }
  }

  function handlePresence(msg) {
    App.peer.ready = !!msg.ready;
    if (App.role === 'host') {
      if (App.game && App.game.phase !== 'done') sendSync(false);
    } else {
      if (typeof msg.firstPrompt === 'boolean') App.firstPrompt = msg.firstPrompt;
      if (msg.phase && msg.phase !== 'lobby' && msg.phase !== 'done' && (!App.game || App.game.phase === 'done')) {
        var now = Date.now();
        if (now - App._lastStateRequest > 4000) {
          App._lastStateRequest = now;
          sendHello(true);
        }
      }
    }
    if (activeScreen() === 'lobby') renderLobby();
  }

  function handleStart(msg) {
    if (!msg) return;
    var hasPrompt = msg.firstPrompt !== false;
    if (hasPrompt && (!msg.pair || !msg.pair.a || !msg.pair.b)) return;
    App.firstPrompt = hasPrompt;
    initGame({
      firstPrompt: hasPrompt,
      maxRounds: Number(msg.maxRounds) || MAX_ROUNDS,
      seed: msg.seed || E.randomSeed(),
      pair: hasPrompt ? msg.pair : null,
      startedAt: msg.ts || Date.now()
    });
    App.saved = false;
    showScreen('game');
    renderGame();
  }

  function handleRound(msg) {
    if (!App.game) { sendHello(true); return; }
    if (typeof msg.round !== 'number' || msg.round < App.game.round) return;
    var g = App.game;
    g.round = msg.round;
    g.kind = msg.kind === 'bridge' ? 'bridge' : (msg.kind === 'free' ? 'free' : 'cue');
    g.cueA = String(msg.cueA || '');
    g.cueB = String(msg.cueB || '');
    g.bridge = {
      host: msg.bridge && msg.bridge.host ? String(msg.bridge.host) : '',
      guest: msg.bridge && msg.bridge.guest ? String(msg.bridge.guest) : ''
    };
    if (g.kind === 'bridge' && (!g.bridge.host || !g.bridge.guest)) {
      var prev = g.results[g.round - 1];
      if (prev) {
        g.bridge = {
          host: prev.answers.host || prev.prompt.host,
          guest: prev.answers.guest || prev.prompt.guest
        };
      }
    }
    g.answers = { host: '', guest: '' };
    g.phase = 'writing';
    g.deadline = Date.now() + (Number(msg.durationMs) || ROUND_MS);
    App._guestTimeoutHandled = false;
    App._revealScheduled = false;
    clearTimeout(App._guestFallbackTimer);
    showScreen('game');
    renderGame();
    ensureTicker();
  }

  function handlePeerAnswer(msg) {
    if (!App.game || App.game.phase !== 'writing') return;
    if (typeof msg.round !== 'number' || msg.round !== App.game.round) return;
    var role = msg.role === 'host' ? 'host' : 'guest';
    if (role === App.role) return;
    App.game.answers[role] = String(msg.word || '').slice(0, 20);
    renderGame();
    if (App.role === 'host') {
      maybeReveal();
    } else {
      maybeRevealGuest();
    }
  }

  function handleReveal(msg) {
    if (!App.game) return;
    if (typeof msg.round !== 'number' || msg.round !== App.game.round) return;
    var g = App.game;
    var answers = msg.answers && typeof msg.answers === 'object' ? msg.answers : {};
    var prompt = g.kind === 'cue'
      ? { host: g.cueA, guest: g.cueB }
      : (g.kind === 'free' ? { host: '', guest: '' } : { host: g.bridge.host, guest: g.bridge.guest });
    applyResult(g.round, {
      kind: g.kind,
      prompt: prompt,
      answers: { host: String(answers.host || ''), guest: String(answers.guest || '') },
      matched: !!msg.matched
    });
    if (msg.success) {
      g.success = true;
      g.roundsUsed = Math.max(1, Number(msg.roundsUsed) || g.round + 1);
    }
    g.phase = 'revealing';
    g.deadline = 0;
    clearTimeout(App._guestFallbackTimer);
    renderGame();
    scheduleFinishFallback();
  }

  function handleSync(msg) {
    if (!msg || !msg.state) return;
    applySnapshot(msg.state);
  }

  function handleRestart(msg) {
    if (!msg) return;
    var hasPrompt = msg.firstPrompt !== false;
    if (hasPrompt && (!msg.pair || !msg.pair.a || !msg.pair.b)) return;
    App.firstPrompt = hasPrompt;
    initGame({
      firstPrompt: hasPrompt,
      maxRounds: Number(msg.maxRounds) || MAX_ROUNDS,
      seed: msg.seed || E.randomSeed(),
      pair: hasPrompt ? msg.pair : null,
      startedAt: Date.now()
    });
    App.saved = false;
    showScreen('game');
    renderGame();
  }

  function handleFinish(msg) {
    if (!App.game) return;
    var g = App.game;
    if (msg && Array.isArray(msg.results)) {
      for (var i = 0; i < msg.results.length; i++) {
        var r = msg.results[i];
        if (!r || typeof r.round !== 'number') continue;
        applyResult(r.round, {
          kind: r.kind === 'bridge' ? 'bridge' : (r.kind === 'free' ? 'free' : 'cue'),
          prompt: r.prompt || { host: '', guest: '' },
          answers: {
            host: (r.answers && r.answers.host) || '',
            guest: (r.answers && r.answers.guest) || ''
          },
          matched: !!r.matched
        });
      }
    }
    if (msg && msg.success) {
      g.success = true;
      g.roundsUsed = Math.max(1, Number(msg.roundsUsed) || g.results.length);
    }
    finishLocally(false);
  }

  /* ======================================================================
     快照与恢复
     ====================================================================== */

  function snapshot() {
    var g = App.game;
    if (!g) return null;
    return {
      phase: g.phase,
      round: g.round,
      maxRounds: g.maxRounds,
      seed: g.seed,
      firstPrompt: g.firstPrompt !== false,
      startPair: g.startPair && g.startPair.a ? { a: g.startPair.a, b: g.startPair.b } : null,
      kind: g.kind,
      cueA: g.cueA,
      cueB: g.cueB,
      bridge: { host: g.bridge.host, guest: g.bridge.guest },
      answers: { host: g.answers.host, guest: g.answers.guest },
      success: !!g.success,
      roundsUsed: g.roundsUsed,
      results: g.results.slice(0, g.maxRounds),
      startedAt: g.startedAt,
      remainingMs: g.phase === 'writing' ? Math.max(0, g.deadline - Date.now()) : 0
    };
  }

  function sendSync(force, snap) {
    if (App.role !== 'host' || !App.net || !App.net.isConnected()) return;
    if (!App.game || App.game.phase === 'done') return;
    if (!force && Date.now() - App._lastSyncSent < SYNC_THROTTLE_MS) return;
    App._lastSyncSent = Date.now();
    App.net.send('sync', { state: snap || snapshot() });
  }

  function applySnapshot(snap) {
    if (!snap || snap.phase === 'lobby') return;
    if (typeof snap.round !== 'number' || snap.round < 0) return;
    var isNew = !App.game || App.game.phase === 'done';
    if (!isNew && snap.round < App.game.round) return;

    var sameRound = !isNew && App.game.round === snap.round && App.game.phase === 'writing';
    var localAnswers = sameRound
      ? { host: App.game.answers.host, guest: App.game.answers.guest }
      : { host: '', guest: '' };

    if (isNew) {
      initGame({
        firstPrompt: snap.firstPrompt !== false,
        maxRounds: Number(snap.maxRounds) || MAX_ROUNDS,
        seed: snap.seed || E.randomSeed(),
        pair: snap.startPair || null,
        startedAt: snap.startedAt || Date.now()
      });
      showScreen('game');
    }
    var g = App.game;
    g.round = snap.round;
    g.maxRounds = Number(snap.maxRounds) || g.maxRounds;
    g.seed = snap.seed || g.seed;
    g.firstPrompt = snap.firstPrompt !== false;
    if (snap.startPair) g.startPair = { a: snap.startPair.a, b: snap.startPair.b };
    g.kind = snap.kind === 'bridge' ? 'bridge' : (snap.kind === 'free' ? 'free' : 'cue');
    g.cueA = String(snap.cueA || '');
    g.cueB = String(snap.cueB || '');
    g.bridge = {
      host: (snap.bridge && snap.bridge.host) || '',
      guest: (snap.bridge && snap.bridge.guest) || ''
    };
    g.answers = {
      host: (snap.answers && snap.answers.host) || '',
      guest: (snap.answers && snap.answers.guest) || ''
    };
    if (g.answers.host === '' && localAnswers.host) g.answers.host = localAnswers.host;
    if (g.answers.guest === '' && localAnswers.guest) g.answers.guest = localAnswers.guest;
    g.success = !!snap.success;
    g.roundsUsed = Math.max(0, Number(snap.roundsUsed) || 0);
    g.results = Array.isArray(snap.results) ? snap.results : [];
    g.phase = snap.phase || 'writing';
    g.startedAt = snap.startedAt || g.startedAt;
    if (g.phase === 'writing') {
      g.deadline = Date.now() + Math.max(1500, Number(snap.remainingMs) || ROUND_MS);
      App._guestTimeoutHandled = false;
    } else {
      g.deadline = 0;
    }
    clearTimeout(App._guestFallbackTimer);
    App._revealScheduled = false;
    renderGame();
    ensureTicker();
    // 自己提交过的答案如果房主没收到，重发一次
    var myRole = App.role;
    var snapshotHasMine = !!(snap.answers && snap.answers[myRole]);
    if (g.phase === 'writing' && g.answers[myRole] && !snapshotHasMine && App.net && App.net.isConnected()) {
      App.net.send('answer', { round: g.round, word: g.answers[myRole] });
    }
    if (g.phase === 'revealing') scheduleFinishFallback();
  }

  /* ======================================================================
     游戏流程
     ====================================================================== */

  function initGame(opts) {
    App.game = {
      seed: opts.seed || E.randomSeed(),
      maxRounds: Math.max(2, Math.min(9, Number(opts.maxRounds) || MAX_ROUNDS)),
      firstPrompt: opts.firstPrompt !== false,
      startPair: opts.pair
        ? { a: opts.pair.a, b: opts.pair.b, target: opts.pair.target, alts: opts.pair.alts || [] }
        : { a: '', b: '', target: '', alts: [] },
      round: -1,
      kind: 'cue',
      cueA: '',
      cueB: '',
      bridge: { host: '', guest: '' },
      answers: { host: '', guest: '' },
      results: [],
      success: false,
      roundsUsed: 0,
      phase: 'waiting',
      startedAt: opts.startedAt || Date.now(),
      deadline: 0
    };
    App.saved = false;
    App._guestTimeoutHandled = false;
    App._revealScheduled = false;
    clearGameTimers();
  }

  function startRound(index) {
    var g = App.game;
    if (!g) return;
    if (index >= g.maxRounds) { finishLocally(true); return; }
    var pair = g.startPair;
    if (index === 0) {
      if (g.firstPrompt !== false) {
        if (!pair || !pair.a || !pair.b) { finishLocally(true); return; }
        g.kind = 'cue';
        g.cueA = pair.a;
        g.cueB = pair.b;
      } else {
        g.kind = 'free';
        g.cueA = '';
        g.cueB = '';
      }
      g.bridge = { host: '', guest: '' };
    } else {
      var prev = g.results[index - 1];
      if (!prev) { finishLocally(true); return; }
      g.kind = 'bridge';
      g.bridge = {
        host: prev.answers.host || prev.prompt.host,
        guest: prev.answers.guest || prev.prompt.guest
      };
      g.cueA = '';
      g.cueB = '';
    }
    g.round = index;
    g.answers = { host: '', guest: '' };
    g.phase = 'writing';
    g.deadline = Date.now() + ROUND_MS;
    App._guestTimeoutHandled = false;
    App._revealScheduled = false;
    clearRevealTimers();
    if (App.mode === 'online' && App.role === 'host' && App.net && App.net.isConnected()) {
      App.net.send('round', {
        round: index,
        kind: g.kind,
        cueA: g.cueA,
        cueB: g.cueB,
        bridge: g.kind === 'bridge' ? { host: g.bridge.host, guest: g.bridge.guest } : null,
        durationMs: ROUND_MS
      });
    }
    if (App.mode === 'solo') {
      if (index === 0) scheduleSoloAnswer(pair);
      else scheduleSoloBridge(g.bridge);
    }
    showScreen('game');
    renderGame();
    ensureTicker();
  }

  function submitAnswer(raw) {
    var g = App.game;
    if (!g || g.phase !== 'writing') return;
    if (g.answers[App.role]) return;
    if (!E.isValidAnswer(raw)) {
      var input = $('answer-input');
      if (input) {
        input.classList.remove('is-shake');
        void input.offsetWidth;
        input.classList.add('is-shake');
        setTimeout(function () { input.classList.remove('is-shake'); }, 420);
      }
      toast('写一个词吧，最多 10 个字');
      return;
    }
    var word = raw.trim();
    g.answers[App.role] = word;
    if (App.mode === 'online' && App.net && App.net.isConnected()) {
      App.net.send('answer', { round: g.round, word: word });
    }
    if (App.mode === 'solo' && (g.kind === 'cue' || g.kind === 'free')) scheduleSoloAnswerFromPlayer(word);
    renderGame();
    if (App.role === 'host' || App.mode === 'solo') maybeReveal();
    else maybeRevealGuest();
  }

  function submitFromInput() {
    var input = $('answer-input');
    if (!input) return;
    submitAnswer(input.value);
  }

  function maybeReveal() {
    var g = App.game;
    if (!g || g.phase !== 'writing') return;
    var both = !!g.answers.host && !!g.answers.guest;
    var timedOut = Date.now() >= g.deadline;
    if (!both && !timedOut) return;
    if (App._revealScheduled) return;
    App._revealScheduled = true;
    App._revealTimer = setTimeout(function () {
      App._revealScheduled = false;
      if (!App.game || App.game.phase !== 'writing') return;
      doReveal();
    }, both ? 300 : 0);
  }

  function maybeRevealGuest() {
    var g = App.game;
    if (!g || g.phase !== 'writing') return;
    var both = !!g.answers.host && !!g.answers.guest;
    if (!both && Date.now() < g.deadline) return;
    scheduleGuestFallback(both ? 1800 : 2600);
  }

  function scheduleGuestFallback(delay) {
    clearTimeout(App._guestFallbackTimer);
    App._guestFallbackTimer = setTimeout(function () {
      if (!App.game || App.game.phase !== 'writing') return;
      localReveal();
    }, delay || 2600);
  }

  function localReveal() {
    var g = App.game;
    if (!g || g.phase !== 'writing') return;
    var rev = E.computeReveal(g.answers);
    var prompt = g.kind === 'cue'
      ? { host: g.cueA, guest: g.cueB }
      : (g.kind === 'free' ? { host: '', guest: '' } : { host: g.bridge.host, guest: g.bridge.guest });
    g.phase = 'revealing';
    g.deadline = 0;
    applyResult(g.round, { kind: g.kind, prompt: prompt, answers: rev.answers, matched: rev.matched });
    if (rev.matched) { g.success = true; g.roundsUsed = g.round + 1; }
    clearRevealTimers();
    renderGame();
    scheduleFinishFallback();
  }

  function doReveal() {
    var g = App.game;
    if (!g || g.phase !== 'writing') return;
    var rev = E.computeReveal(g.answers);
    var prompt = g.kind === 'cue'
      ? { host: g.cueA, guest: g.cueB }
      : (g.kind === 'free' ? { host: '', guest: '' } : { host: g.bridge.host, guest: g.bridge.guest });
    g.phase = 'revealing';
    g.deadline = 0;
    applyResult(g.round, { kind: g.kind, prompt: prompt, answers: rev.answers, matched: rev.matched });
    if (rev.matched) { g.success = true; g.roundsUsed = g.round + 1; }
    clearRevealTimers();
    if (App.mode === 'online' && App.role === 'host' && App.net && App.net.isConnected()) {
      App.net.send('reveal', {
        round: g.round,
        answers: rev.answers,
        matched: rev.matched,
        success: g.success,
        roundsUsed: g.roundsUsed
      });
    }
    renderGame();
    scheduleFinishFallback();
  }

  function applyResult(round, result) {
    var g = App.game;
    if (!g) return;
    var item = {
      round: round,
      kind: result && result.kind === 'bridge' ? 'bridge' : (result && result.kind === 'free' ? 'free' : 'cue'),
      prompt: {
        host: (result && result.prompt && result.prompt.host) || '',
        guest: (result && result.prompt && result.prompt.guest) || ''
      },
      answers: {
        host: (result && result.answers && result.answers.host) || '',
        guest: (result && result.answers && result.answers.guest) || ''
      },
      matched: !!(result && result.matched)
    };
    var existing = null;
    for (var i = 0; i < g.results.length; i++) {
      if (g.results[i] && g.results[i].round === round) { existing = g.results[i]; break; }
    }
    if (existing) {
      existing.kind = item.kind;
      existing.prompt = item.prompt;
      existing.answers = item.answers;
      existing.matched = item.matched;
    } else {
      g.results.push(item);
    }
  }

  function advanceRound() {
    var g = App.game;
    if (!g || g.phase !== 'revealing') return;
    if (g.success || g.round + 1 >= g.maxRounds) { finishLocally(true); return; }
    startRound(g.round + 1);
  }

  function forceGuestFinish() {
    var g = App.game;
    if (!g) return;
    finishLocally(false);
  }

  function scheduleFinishFallback() {
    clearTimeout(App._finishFallbackTimer);
    if (!App.game || App.role !== 'guest') return;
    if (!App.game.success && App.game.round < App.game.maxRounds - 1) return;
    App._finishFallbackTimer = setTimeout(function () {
      var g = App.game;
      if (g && g.phase === 'revealing' && (g.success || g.round >= g.maxRounds - 1)) {
        finishLocally(false);
      }
    }, 12000);
  }

  function finishLocally(sendMessage) {
    var g = App.game;
    if (!g || g.phase === 'done') return;
    g.phase = 'done';
    g.deadline = 0;
    stopTicker();
    clearRevealTimers();
    clearTimeout(App._soloTimer);
    if (sendMessage && App.mode === 'online' && App.role === 'host' && App.net && App.net.isConnected()) {
      App.net.send('finish', {
        success: !!g.success,
        roundsUsed: g.success ? g.roundsUsed : g.maxRounds,
        results: g.results
      });
    }
    saveHistory();
    renderSummary();
    showScreen('summary');
  }

  function restartGame() {
    if (App.mode === 'solo') { startSolo(); return; }
    if (!App.game || App.role !== 'host') return;
    var seed = E.randomSeed();
    var firstPrompt = App.firstPrompt !== false;
    var pair = firstPrompt ? E.pickStartPair(W.CUE_PAIRS, seed) : null;
    initGame({ firstPrompt: firstPrompt, maxRounds: MAX_ROUNDS, seed: seed, pair: pair, startedAt: Date.now() });
    App.saved = false;
    if (App.net && App.net.isConnected()) {
      App.net.send('restart', {
        seed: seed,
        maxRounds: MAX_ROUNDS,
        firstPrompt: firstPrompt,
        pair: firstPrompt ? { a: pair.a, b: pair.b } : null
      });
    }
    showScreen('game');
    renderGame();
    setTimeout(function () {
      if (App.game && App.game.phase === 'waiting') startRound(0);
    }, 380);
  }

  function requestRestart() {
    if (!App.net || !App.net.isConnected()) { toast('还没连上服务器，稍后再试'); return; }
    App.net.send('requestRestart', {});
    toast('已经把「再来一局」带给房主了');
    var btn = document.querySelector('[data-act="request-restart"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '已邀请房主';
    }
  }

  function leaveRoom() {
    if (App.game && App.game.phase !== 'done' && App.mode === 'online' && !App._leaving) {
      var ok = true;
      try { ok = window.confirm('这一局还没结束，离开会放弃当前进度，确定吗？'); } catch (_) { ok = true; }
      if (!ok) return;
    }
    App._leaving = true;
    clearGameTimers();
    teardownNet();
    App.mode = null;
    App.role = null;
    App.roomCode = '';
    App.game = null;
    App.saved = false;
    App.peer = null;
    App.connected = false;
    App.broker = null;
    App.firstPrompt = profile.firstPrompt !== false;
    closeAllOverlays();
    showScreen('home');
    renderHomeMeta();
    setTimeout(function () { App._leaving = false; }, 350);
  }

  /* ======================================================================
     单人试玩
     ====================================================================== */

  function startSolo() {
    teardownNet();
    clearGameTimers();
    App.mode = 'solo';
    App.role = 'host';
    App.roomCode = '';
    App.me = { name: getNickname(), ready: true };
    App.peer = { name: E.pickOne(W.AI_NAMES), online: true, ready: true, isAi: true };
    var seed = E.randomSeed();
    var firstPrompt = profile.firstPrompt !== false;
    App.firstPrompt = firstPrompt;
    var pair = firstPrompt ? E.pickStartPair(W.CUE_PAIRS, seed) : null;
    initGame({ firstPrompt: firstPrompt, maxRounds: MAX_ROUNDS, seed: seed, pair: pair, startedAt: Date.now() });
    App.saved = false;
    startRound(0);
  }

  function scheduleSoloAnswer(pair) {
    clearTimeout(App._soloTimer);
    App._soloTimer = setTimeout(function () {
      var g = App.game;
      if (!g || g.phase !== 'writing' || g.answers.guest) return;
      g.answers.guest = (g.firstPrompt !== false && pair && pair.target)
        ? E.pickAiAnswer(pair, g.answers.host, Math.random)
        : E.pickFreeWord(Math.random);
      renderGame();
      maybeReveal();
    }, 3200 + Math.random() * 1200);
  }

  function scheduleSoloAnswerFromPlayer(word) {
    clearTimeout(App._soloTimer);
    App._soloTimer = setTimeout(function () {
      var g = App.game;
      if (!g || g.phase !== 'writing' || g.answers.guest) return;
      if (g.kind === 'free') {
        g.answers.guest = Math.random() < 0.12 ? word : E.pickFreeWord(Math.random);
      } else {
        g.answers.guest = E.pickAiAnswer(g.startPair, word, Math.random);
      }
      renderGame();
      maybeReveal();
    }, 900 + Math.random() * 1100);
  }

  function scheduleSoloBridge(bridge) {
    clearTimeout(App._soloTimer);
    App._soloTimer = setTimeout(function () {
      var g = App.game;
      if (!g || g.phase !== 'writing' || g.kind !== 'bridge' || g.answers.guest) return;
      g.answers.guest = E.pickBridge([bridge.host, bridge.guest], Math.random);
      renderGame();
      maybeReveal();
    }, 1200 + Math.random() * 1300);
  }

  /* ======================================================================
     渲染：房间
     ====================================================================== */

  function avatarHTML(name, role, offline) {
    return '<span class="seat-avatar ' + (role === 'host' ? 'host' : 'guest') +
      (offline ? ' is-offline' : '') + '">' + esc(firstChar(name)) + '</span>';
  }

  function renderLobby() {
    if (!App.me) return;
    if (els.lobbyCode) els.lobbyCode.textContent = App.roomCode || '······';
    if (!els.seats) return;

    var meStatus = App.me.ready ? '已准备' : '未准备';
    var meHtml =
      '<div class="seat is-me">' +
        avatarHTML(App.me.name, App.role) +
        '<span class="seat-info">' +
          '<span class="seat-name">' + esc(App.me.name) + '</span>' +
          '<span class="seat-role">' + (App.role === 'host' ? '房主 · 我' : '访客 · 我') + '</span>' +
        '</span>' +
        '<span class="seat-status is-you">' + esc(meStatus) + '</span>' +
      '</div>';

    var peerHtml;
    if (App.peer && App.peer.online) {
      peerHtml =
        '<div class="seat">' +
          avatarHTML(App.peer.name, App.role === 'host' ? 'guest' : 'host') +
          '<span class="seat-info">' +
            '<span class="seat-name">' + esc(App.peer.name || '朋友') + '</span>' +
            '<span class="seat-role">' + (App.role === 'host' ? '被邀请的朋友' : '房主') + '</span>' +
          '</span>' +
          '<span class="seat-status ' + (App.peer.ready ? 'is-ready' : '') + '">' + (App.peer.ready ? '已准备' : '未准备') + '</span>' +
        '</div>';
    } else {
      peerHtml =
        '<div class="seat seat-empty">' +
          '<span class="seat-avatar empty"><svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg></span>' +
          '<span class="seat-info">' +
            '<span class="seat-name">等朋友加入…</span>' +
            '<span class="seat-role">把房间号发给 ta，输入就能会合</span>' +
          '</span>' +
        '</div>';
    }
    els.seats.innerHTML = meHtml + peerHtml;

    var canBegin = App.role === 'host' && App.connected && App.peer && App.peer.online &&
      App.me.ready && App.peer.ready;
    els.btnBegin.disabled = !canBegin;
    els.btnBegin.textContent = App.role === 'host' ? '开始游戏' : '等房主开始';
    els.btnReady.textContent = App.me.ready ? '取消准备' : '准备好了';
    els.btnReady.classList.toggle('is-ready', !!App.me.ready);

    var hint = '';
    if (!App.connected) hint = '正在连接公共服务器…';
    else if (!App.peer || !App.peer.online) hint = '把房间号发给朋友，等 ta 来碰个面。';
    else if (!App.me.ready || !App.peer.ready) hint = '两个人都点「准备好了」，房主就可以开始。';
    else hint = App.role === 'host' ? '都准备好了，点击下方开始游戏。' : '都准备好了，等房主开始。';
    if (els.lobbyHint) els.lobbyHint.textContent = hint;
    if (els.lobbyTip) {
      if (App.role === 'guest') {
        els.lobbyTip.innerHTML = '房间号不区分大小写；两人需要连上同一个公共服务器。';
      } else {
        els.lobbyTip.innerHTML = '小提示：公共服务器上请不要填写真实姓名等敏感信息。';
      }
    }
    renderFirstPromptControls();
    if (els.lobbyFirstPrompt && App.role === 'guest') {
      els.lobbyFirstPrompt.textContent = (App.firstPrompt ? '系统提示词' : '自由发挥') + '（房主设置）';
    }
  }

  function toggleReady() {
    if (!App.me) return;
    App.me.ready = !App.me.ready;
    if (App.net && App.net.isConnected()) {
      App.net.send('ready', { ready: App.me.ready });
    }
    renderLobby();
  }

  function hostBegin() {
    if (!App.game && App.mode === 'online') {
      if (!App.peer || !App.peer.online) { toast('等朋友进来再开始'); return; }
      if (!App.me.ready || !App.peer.ready) { toast('两个人都准备好才能开始'); return; }
      var seed = E.randomSeed();
      var firstPrompt = App.firstPrompt !== false;
      var pair = firstPrompt ? E.pickStartPair(W.CUE_PAIRS, seed) : null;
      initGame({ firstPrompt: firstPrompt, maxRounds: MAX_ROUNDS, seed: seed, pair: pair, startedAt: Date.now() });
      App.saved = false;
      if (App.net && App.net.isConnected()) {
        App.net.send('start', {
          maxRounds: MAX_ROUNDS,
          seed: seed,
          firstPrompt: firstPrompt,
          pair: firstPrompt ? { a: pair.a, b: pair.b } : null
        });
      }
      showScreen('game');
      renderGame();
      setTimeout(function () {
        if (App.game && App.game.phase === 'waiting') startRound(0);
      }, 420);
    }
  }

  /* ======================================================================
     渲染：对局
     ====================================================================== */

  function updateRoundHeader() {
    var g = App.game;
    if (!g || !els.gameRound) return;
    els.gameRound.textContent = '第 ' + Math.max(1, g.round + 1) + ' / ' + g.maxRounds + ' 轮';
    var dots = '';
    for (var i = 0; i < g.maxRounds; i++) {
      var cls = i < g.round ? 'done' : (i === g.round ? 'current' : '');
      if (g.phase === 'revealing' && i === g.round) cls = g.success ? 'hit' : 'done';
      dots += '<span class="round-dot ' + cls + '"></span>';
    }
    if (els.gameDots) els.gameDots.innerHTML = dots;
    if (els.gameMatches) els.gameMatches.textContent = g.success ? '1' : '0';
    var showTimer = g.phase === 'writing';
    if (els.timerWrap) els.timerWrap.style.visibility = showTimer ? 'visible' : 'hidden';
  }

  function updateTimerUI(remain) {
    if (!els.timerProgress) return;
    var ratio = Math.max(0, Math.min(1, remain / ROUND_MS));
    els.timerProgress.style.strokeDashoffset = String(106.81 * (1 - ratio));
    if (els.gameSeconds) els.gameSeconds.textContent = String(Math.max(0, Math.ceil(remain / 1000)));
    if (els.timerWrap) els.timerWrap.classList.toggle('is-urgent', remain > 0 && remain <= 10000);
  }

  function captureInput() {
    var input = $('answer-input');
    if (!input) return null;
    return { value: input.value, focused: document.activeElement === input };
  }

  function restoreInput(snap) {
    if (!snap) return;
    var input = $('answer-input');
    if (!input) return;
    input.value = snap.value || '';
    if (snap.focused) {
      try {
        input.focus();
        var len = input.value.length;
        input.setSelectionRange(len, len);
      } catch (_) {}
    }
  }

  function peerStatusHTML(myRole) {
    var g = App.game;
    var peerRole = myRole === 'host' ? 'guest' : 'host';
    var peerName = (App.peer && App.peer.name) || '对方';
    if (!App.peer || !App.peer.online) {
      return '<div class="peer-status"><i class="conn-dot"></i><span>' + esc(peerName) + ' 掉线了，正在等 ta 回来…</span></div>';
    }
    var done = !!g.answers[peerRole];
    var peerLabel = esc(peerName);
    if (App.mode === 'solo' && peerName.indexOf('影子玩家') === -1) peerLabel += '（影子玩家）';
    return '<div class="peer-status is-online"><i class="conn-dot"></i><span>' +
      peerLabel +
      (done ? ' 已经写好了' : ' 还在想…') + '</span></div>';
  }

  function renderWaitingStart() {
    if (!els.gameBody) return;
    els.gameBody.innerHTML =
      '<div class="game-inner">' +
        '<div class="waiting-card">' +
          '<p class="waiting-title">正在准备这一局…</p>' +
          '<p class="waiting-sub">房主马上就出题。</p>' +
          '<div class="waiting-dots"><i></i><i></i><i></i></div>' +
        '</div>' +
      '</div>';
  }

  function renderWriting() {
    var g = App.game;
    if (!g || !els.gameBody) return;
    var myRole = App.role;
    var peerRole = myRole === 'host' ? 'guest' : 'host';
    var submitted = !!g.answers[myRole];
    var expired = Date.now() >= g.deadline;
    var peerName = (App.peer && App.peer.name) || '对方';
    var snap = captureInput();
    var html = '';

    if (g.kind === 'cue') {
      var myCue = myRole === 'host' ? g.cueA : g.cueB;
      html += '<div class="cue-block">' +
        '<p class="cue-label">' + (submitted ? '你的答案' : '你的词') + '</p>' +
        '<div class="cue-word">' + esc(submitted ? g.answers[myRole] : myCue) + '</div>' +
        '<p class="cue-sub">' + (submitted ?
          '等对方也写一个词，看看你们会不会想到一起。' :
          (expired ? '时间到，正在等对方揭晓。' : '看着它，写下第一个跳出来的词。')) + '</p>' +
      '</div>';

      var peerRoleName = myRole === 'host' ? 'guest' : 'host';
      html += '<div class="duel">' +
        '<div class="duel-person">' + avatarHTML(App.me.name, App.role) + '<span class="duel-name">我</span></div>' +
        '<span class="duel-line"></span><span class="duel-q">?</span><span class="duel-line"></span>' +
        '<div class="duel-person">' + avatarHTML(peerName, peerRoleName, !(App.peer && App.peer.online)) +
          '<span class="duel-name">' + esc(peerName) + '</span></div>' +
      '</div>';
    } else if (g.kind === 'free') {
      html += '<div class="cue-block">' +
        '<p class="cue-label">' + (submitted ? '你的答案' : '第一轮 · 自由发挥') + '</p>' +
        '<div class="cue-word cue-word-free">' + esc(submitted ? g.answers[myRole] : '自由发挥') + '</div>' +
        '<p class="cue-sub">' + (submitted ?
          '等对方也写一个词，看看你们会不会想到一起。' :
          (expired ? '时间到，正在等对方揭晓。' : '没有提示词，写下一个你此刻想到的词。')) + '</p>' +
      '</div>';
      var freePeerRole = myRole === 'host' ? 'guest' : 'host';
      html += '<div class="duel">' +
        '<div class="duel-person">' + avatarHTML(App.me.name, App.role) + '<span class="duel-name">我</span></div>' +
        '<span class="duel-line"></span><span class="duel-q">?</span><span class="duel-line"></span>' +
        '<div class="duel-person">' + avatarHTML(peerName, freePeerRole, !(App.peer && App.peer.online)) +
          '<span class="duel-name">' + esc(peerName) + '</span></div>' +
      '</div>';
    } else {
      var myPrev = myRole === 'host' ? g.bridge.host : g.bridge.guest;
      var theirPrev = myRole === 'host' ? g.bridge.guest : g.bridge.host;
      html += '<div class="bridge-block">' +
        '<p class="cue-label">你们俩的词</p>' +
        '<div class="bridge-words">' +
          '<span class="bridge-chip bridge-mine"><span class="bridge-who">我</span>' + esc(myPrev || '没作答') + '</span>' +
          '<span class="bridge-plus">+</span>' +
          '<span class="bridge-chip bridge-peer"><span class="bridge-who">' + esc(peerName) + '</span>' + esc(theirPrev || '没作答') + '</span>' +
        '</div>' +
        '<p class="bridge-arrow">↓</p>' +
        (submitted
          ? '<p class="cue-label">你的答案</p><div class="cue-word bridge-answer">' + esc(g.answers[myRole]) + '</div>'
          : '<p class="cue-sub">找到它们的共同点，写下你想到的词。</p>') +
      '</div>';
    }

    if (!submitted && !expired) {
      var placeholder = g.kind === 'bridge' ? '它们的共同点…' : '写一个词…';
      html += '<div class="answer-panel">' +
        '<input class="answer-input" id="answer-input" type="text" maxlength="' + E.MAX_ANSWER_LENGTH + '" ' +
          'placeholder="' + placeholder + '" autocomplete="off" autocapitalize="off" enterkeyhint="done" aria-label="你的答案">' +
        '<div class="answer-actions"><button class="btn btn-primary" type="button" data-act="submit">就是它</button></div>' +
        '<p class="answer-hint">最多 10 个字；双方都提交后才会揭晓。</p>' +
      '</div>';
    } else {
      var peerDone = !!g.answers[peerRole];
      var waitTitle = !submitted ? '时间到，正在等揭晓…' : (peerDone ? '答案对上了，正在揭晓…' : '等对方也写一个词…');
      var waitSub = !submitted
        ? '这一轮没有提交答案，下一轮记得快一点。'
        : (peerDone ? '马上就能看到结果。' : esc(peerName) + ' 正在想。答案会在双方都提交后揭晓。');
      html += '<div class="waiting-card">' +
        '<p class="waiting-title">' + waitTitle + '</p>' +
        '<p class="waiting-sub">' + waitSub + '</p>' +
        '<div class="waiting-dots"><i></i><i></i><i></i></div>' +
      '</div>';
    }

    html += peerStatusHTML(myRole);
    els.gameBody.innerHTML = '<div class="game-inner">' + html + '</div>';
    restoreInput(snap);
  }

  function renderRevealing() {
    var g = App.game;
    if (!g || !els.gameBody) return;
    var result = null;
    for (var i = g.results.length - 1; i >= 0; i--) {
      if (g.results[i].round === g.round) { result = g.results[i]; break; }
    }
    if (!result) { renderWriting(); return; }
    var myRole = App.role;
    var peerRole = myRole === 'host' ? 'guest' : 'host';
    var mine = result.answers[myRole] || '';
    var theirs = result.answers[peerRole] || '';
    var peerName = (App.peer && App.peer.name) || '对方';
    var matched = !!result.matched;
    var success = matched;
    var isLast = g.round >= g.maxRounds - 1;
    var prompt = result.prompt || { host: '', guest: '' };
    var checkIcon = '<svg class="icon-sm" aria-hidden="true"><use href="#i-check"></use></svg>';

    var promptLine = '';
    if (result.kind === 'bridge') {
      promptLine = '<p class="reveal-prompt">本轮题目 · <b>' + esc(prompt.host) + '</b> + <b>' + esc(prompt.guest) + '</b></p>';
    } else if (result.kind === 'free') {
      promptLine = '<p class="reveal-prompt">第一轮 · 自由发挥</p>';
    }

    var myCue = result.kind === 'cue' ? (myRole === 'host' ? prompt.host : prompt.guest) : '';
    var theirCue = result.kind === 'cue' ? (myRole === 'host' ? prompt.guest : prompt.host) : '';

    var actions = '';
    if (App.role === 'host' || App.mode === 'solo') {
      actions = '<button class="btn btn-primary" type="button" data-act="next">' +
        (success || isLast ? '查看脑回路报告' : '下一轮') + '</button>';
    } else {
      actions = '<p class="reveal-wait">' +
        (success ? '等房主看报告…' : (isLast ? '等房主结算…' : '等房主开始下一轮…')) + '</p>';
      if (!App.peer || !App.peer.online) {
        actions += '<button class="btn btn-soft" type="button" data-act="force-finish">对方离线，先看结果</button>';
      }
    }

    var note = matched
      ? '你们在同一个词上碰面了，这就是同词相见。'
      : (isLast
        ? '这一局没有找到同一个词，不过你们已经交换了很多念头。'
        : '还没撞上。下一轮，就用刚刚这两个词继续找共同点。');

    els.gameBody.innerHTML =
      '<div class="game-inner">' +
        '<div class="reveal' + (matched ? ' is-matched' : '') + '">' +
        '<div class="reveal-head">' +
          '<span class="reveal-badge' + (matched ? '' : ' is-missed') + '">' +
            (matched ? checkIcon + '同词相见 · 第 ' + (g.round + 1) + ' 轮' : '差一点点') +
          '</span>' +
          promptLine +
        '</div>' +
        '<div class="reveal-words">' +
          '<div class="reveal-side">' +
            '<span class="reveal-name">我</span>' +
            '<div class="reveal-word' + (mine ? '' : ' is-empty') + '">' + esc(mine || '没作答') + '</div>' +
            (myCue ? '<span class="reveal-cue">提示 · ' + esc(myCue) + '</span>' : '') +
          '</div>' +
          '<span class="reveal-connector">' + (matched ? '=' : '≠') + '</span>' +
          '<div class="reveal-side">' +
            '<span class="reveal-name">' + esc(peerName) + '</span>' +
            '<div class="reveal-word' + (theirs ? '' : ' is-empty') + '">' + esc(theirs || '没作答') + '</div>' +
            (theirCue ? '<span class="reveal-cue">提示 · ' + esc(theirCue) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<p class="reveal-note">' + note + '</p>' +
        '<div class="reveal-actions">' + actions + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderGame() {
    var g = App.game;
    if (!g) return;
    updateRoundHeader();
    if (g.phase === 'writing') renderWriting();
    else if (g.phase === 'revealing') renderRevealing();
    else if (g.phase === 'waiting') renderWaitingStart();
  }

  function ensureTicker() {
    if (App._ticker) return;
    App._ticker = setInterval(tick, 200);
  }

  function stopTicker() {
    if (App._ticker) { clearInterval(App._ticker); App._ticker = null; }
  }

  function tick() {
    var g = App.game;
    if (!g) { stopTicker(); return; }
    if (g.phase !== 'writing') return;
    var remain = Math.max(0, g.deadline - Date.now());
    updateTimerUI(remain);
    if (remain > 0) return;
    if (App.role === 'host' || App.mode === 'solo') {
      if (!App._revealScheduled) {
        App._revealScheduled = true;
        App._revealTimer = setTimeout(function () {
          App._revealScheduled = false;
          if (App.game && App.game.phase === 'writing') doReveal();
        }, 650);
      }
    } else if (!App._guestTimeoutHandled) {
      App._guestTimeoutHandled = true;
      renderGame();
      scheduleGuestFallback(2600);
    }
  }

  /* ======================================================================
     渲染：结算
     ====================================================================== */

  function summaryPeerName() {
    if (App.mode === 'solo') return (App.peer && App.peer.name) || '影子玩家';
    return (App.peer && App.peer.name) || '朋友';
  }

  function renderSummary() {
    var g = App.game;
    if (!g || !els.summaryBody) return;
    var playedRounds = g.success ? g.roundsUsed : g.maxRounds;
    var tier = E.resultTier(g.success, playedRounds, g.maxRounds);
    var peerName = summaryPeerName();
    var myRole = App.role;
    var peerRole = myRole === 'host' ? 'guest' : 'host';
    var checkIcon = '<svg class="icon-xs" aria-hidden="true"><use href="#i-check"></use></svg>';

    var dots = '';
    for (var i = 0; i < g.maxRounds; i++) {
      var hit = false;
      for (var k = 0; k < g.results.length; k++) {
        if (g.results[k].round === i && g.results[k].matched) { hit = true; break; }
      }
      dots += '<span class="summary-dot' + (hit ? ' hit' : '') + '"></span>';
    }

    var items = '';
    for (var r = 0; r < playedRounds; r++) {
      var result = null;
      for (var m = 0; m < g.results.length; m++) if (g.results[m].round === r) { result = g.results[m]; break; }
      if (!result) continue;
      var myWord = result.answers[myRole] || '';
      var peerWord = result.answers[peerRole] || '';
      var prompt = result.prompt || { host: '', guest: '' };
      var promptText;
      if (result.kind === 'bridge') promptText = '上一轮 · ' + esc(prompt.host) + ' + ' + esc(prompt.guest);
      else if (result.kind === 'free') promptText = '第一轮 · 自由发挥';
      else promptText = '提示 · ' + esc(prompt.host) + ' + ' + esc(prompt.guest);
      var hitRound = !!result.matched;
      items += '<div class="summary-item">' +
        '<span class="summary-item-index">' + (r + 1) + '</span>' +
        '<div class="summary-item-main">' +
          '<div class="summary-item-line summary-item-prompt">' +
            '<span class="summary-item-cue">' + promptText + '</span>' +
          '</div>' +
          '<div class="summary-item-line">' +
            '<span class="summary-item-name">我</span>' +
            '<span class="summary-item-word' + (myWord ? '' : ' is-empty') + '">' + esc(myWord || '没作答') + '</span>' +
          '</div>' +
          '<div class="summary-item-line">' +
            '<span class="summary-item-name">' + esc(peerName) + '</span>' +
            '<span class="summary-item-word' + (peerWord ? '' : ' is-empty') + '">' + esc(peerWord || '没作答') + '</span>' +
          '</div>' +
        '</div>' +
        '<span class="summary-item-result' + (hitRound ? ' is-hit' : '') + '">' +
          (hitRound ? checkIcon + '同词' : '错过') +
        '</span>' +
      '</div>';
    }

    var actions = '';
    if (App.mode === 'solo') {
      actions = '<button class="btn btn-primary" type="button" data-act="restart">再来一局</button>' +
        '<button class="btn btn-soft" type="button" data-act="home">回到首页</button>';
    } else if (App.role === 'host') {
      actions = '<button class="btn btn-primary" type="button" data-act="restart">再来一局</button>' +
        '<button class="btn btn-soft" type="button" data-act="home">回到首页</button>';
    } else {
      var peerOnline = !!(App.peer && App.peer.online);
      actions = '<button class="btn btn-primary" type="button" data-act="request-restart"' + (peerOnline ? '' : ' disabled') + '>再来一局</button>' +
        '<button class="btn btn-soft" type="button" data-act="home">回到首页</button>';
    }

    var foot = App.mode === 'solo'
      ? '单人试玩 · 影子玩家 · 本局已保存到本地'
      : '房间 ' + App.roomCode + ' · ' + brokerLabel() + ' · 公共 MQTT 联机';

    els.summaryBody.innerHTML =
      '<div class="summary-hero">' +
        '<p class="summary-kicker">' + (App.mode === 'solo' ? '单人试玩 · 影子玩家' : '和 ' + esc(peerName) + ' 的这一局') + '</p>' +
        '<p class="summary-score">' + playedRounds + '<small> 轮 · ' + (g.success ? '同词相见' : '未相遇') + '</small></p>' +
        '<h2 class="summary-tier">' + esc(tier.title) + '</h2>' +
        '<p class="summary-tier-desc">' + esc(tier.desc) + '</p>' +
        '<div class="summary-dots">' + dots + '</div>' +
      '</div>' +
      '<div class="summary-list">' + items + '</div>' +
      '<div class="summary-actions">' + actions + '</div>' +
      '<p class="summary-footnote">' + esc(foot) + '</p>';
  }

  function saveHistory() {
    var g = App.game;
    if (!g || App.saved) return;
    App.saved = true;
    var entry = {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      ts: Date.now(),
      mode: App.mode === 'solo' ? 'solo' : 'online',
      code: App.mode === 'solo' ? null : App.roomCode,
      rounds: g.maxRounds,
      roundsUsed: g.success ? g.roundsUsed : g.maxRounds,
      success: !!g.success,
      matches: g.success ? 1 : 0,
      me: { name: App.me ? App.me.name : '', role: App.role },
      peer: { name: summaryPeerName(), isAi: App.mode === 'solo' },
      items: g.results.map(function (r) {
        return {
          round: r.round,
          kind: r.kind,
          prompt: { host: r.prompt.host, guest: r.prompt.guest },
          answers: { host: r.answers.host, guest: r.answers.guest },
          matched: !!r.matched
        };
      }),
      durationMs: Math.max(0, Date.now() - g.startedAt)
    };
    var list = storeRead(KEYS.history, []);
    if (!Array.isArray(list)) list = [];
    list.unshift(entry);
    storeWrite(KEYS.history, list.slice(0, MAX_HISTORY));
    renderHomeMeta();
  }

  /* ======================================================================
     历史记录
     ====================================================================== */

  function renderHistory() {
    if (!els.historyBody) return;
    var list = storeRead(KEYS.history, []);
    if (!Array.isArray(list)) list = [];
    if (!list.length) {
      els.historyBody.innerHTML =
        '<div class="history-empty">' +
          '<div class="history-empty-icon"><svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg></div>' +
          '<p class="history-empty-title">还没有记录</p>' +
          '<p class="history-empty-desc">和朋友玩一局，或者先和影子玩家练练默契。<br>每一局都会保存在这台设备上。</p>' +
        '</div>';
      els.btnClearHistory.hidden = true;
      return;
    }
    els.btnClearHistory.hidden = false;
    els.btnClearHistory.textContent = '清空记录';
    var html = '<div class="history-list">';
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || typeof entry !== 'object') continue;
      var modeSolo = entry.mode === 'solo';
      var success = !!entry.success;
      var used = Math.max(0, Number(entry.roundsUsed) || Number(entry.rounds) || 0);
      var peerName = (entry.peer && entry.peer.name) || (modeSolo ? '影子玩家' : '朋友');
      var role = entry.me && entry.me.role === 'guest' ? 'guest' : 'host';
      var matchedItem = null;
      (entry.items || []).forEach(function (it) { if (it && it.matched) matchedItem = it; });
      var wordsHtml;
      if (success && matchedItem) {
        var word = (matchedItem.answers && (matchedItem.answers[role] || matchedItem.answers.host)) || '';
        wordsHtml = '相遇词：<span class="hit">' + esc(word) + '</span>';
      } else {
        var list2 = entry.items || [];
        var last = list2.length ? list2[list2.length - 1] : null;
        if (last) {
          var p = last.prompt || { host: '', guest: '' };
          var a = last.answers || { host: '', guest: '' };
          var promptText = (p.host || p.guest) ? (esc(p.host) + ' + ' + esc(p.guest)) : '自由发挥';
          wordsHtml = '最后一轮：' + promptText +
            ' → ' + esc(a[role] || '—') + ' / ' + esc(a[role === 'host' ? 'guest' : 'host'] || '—');
        } else {
          wordsHtml = '没有留下记录。';
        }
      }
      html += '<div class="history-item">' +
        '<div class="history-item-head">' +
          '<span>' + (modeSolo ? '单人试玩' : '联机') + ' · ' + esc(peerName) + '</span>' +
          '<span class="history-item-time">' + esc(E.formatRelativeTime(entry.ts)) + '</span>' +
        '</div>' +
        '<div class="history-item-meta">' +
          '<span class="history-badge' + (modeSolo ? ' solo' : '') + '">' + (modeSolo ? '影子玩家' : '房间 ' + esc(entry.code || '------')) + '</span>' +
          '<span>最多 ' + (entry.rounds || 0) + ' 轮</span>' +
          '<span class="history-item-score' + (success ? '' : ' is-missed') + '">' +
            (success ? '同词相见 · 第 ' + used + ' 轮' : '未相遇') +
          '</span>' +
        '</div>' +
        '<div class="history-words">' + wordsHtml + '</div>' +
      '</div>';
    }
    html += '</div>';
    els.historyBody.innerHTML = html;
  }

  function openHistory() {
    App._clearArmed = false;
    clearTimeout(App._clearTimer);
    renderHistory();
    openOverlay('overlay-history');
  }

  function clearHistory() {
    if (!App._clearArmed) {
      App._clearArmed = true;
      els.btnClearHistory.textContent = '再点一次清空';
      clearTimeout(App._clearTimer);
      App._clearTimer = setTimeout(function () {
        App._clearArmed = false;
        if (els.btnClearHistory) els.btnClearHistory.textContent = '清空记录';
      }, 3200);
      return;
    }
    storeWrite(KEYS.history, []);
    App._clearArmed = false;
    renderHistory();
    renderHomeMeta();
    toast('历史记录已清空');
  }

  /* ======================================================================
     复制邀请
     ====================================================================== */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function copyInvite() {
    if (!App.roomCode) return;
    var pathname = location.pathname || '/';
    if (/\/index\.html?$/i.test(pathname)) pathname = pathname.replace(/index\.html?$/i, '');
    var base = location.origin && location.origin !== 'null'
      ? location.origin + pathname
      : location.href.split('?')[0];
    var link = base + '?room=' + App.roomCode;
    var text = '我在「同词相见」开了一个房间，房间号 ' + App.roomCode + '。\n打开 ' + link + ' 来和我的脑回路碰个面。';
    copyText(text).then(function (ok) {
      if (ok) { toast('邀请已复制，发给朋友吧'); return; }
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (_) { done = false; }
      document.body.removeChild(area);
      toast(done ? '邀请已复制，发给朋友吧' : '复制失败，请手动复制房间号 ' + App.roomCode);
    });
  }

  /* ======================================================================
     计时器清理
     ====================================================================== */

  function clearRevealTimers() {
    clearTimeout(App._revealTimer);
    clearTimeout(App._guestFallbackTimer);
    clearTimeout(App._finishFallbackTimer);
    App._revealTimer = null;
    App._guestFallbackTimer = null;
    App._finishFallbackTimer = null;
    App._revealScheduled = false;
  }

  function clearGameTimers() {
    stopTicker();
    clearRevealTimers();
    clearTimeout(App._soloTimer);
    clearTimeout(App._lobbyHintTimer);
    App._soloTimer = null;
    App._lobbyHintTimer = null;
  }

  /* ======================================================================
     事件绑定
     ====================================================================== */

  function cacheEls() {
    els.app = $('app');
    els.toast = $('toast');
    els.demo = $('demo');
    els.homeMeta = $('home-meta');
    els.nickname = $('input-nickname');
    els.joinPanel = $('join-panel');
    els.inputCode = $('input-room-code');
    els.lobbyCode = $('lobby-code');
    els.lobbyHint = $('lobby-hint');
    els.lobbyTip = $('lobby-tip');
    els.lobbyConn = $('lobby-conn');
    els.seats = $('lobby-seats');
    els.lobbyFirstPrompt = $('lobby-first-prompt');
    els.btnToggleFirst = $('btn-toggle-first-prompt');
    els.btnRetry = $('btn-retry-connect');
    els.btnReady = $('btn-ready');
    els.btnBegin = $('btn-begin');
    els.gameRound = $('game-round');
    els.gameDots = $('game-dots');
    els.gameMatches = $('game-matches');
    els.gameSeconds = $('game-seconds');
    els.timerWrap = $('timer-wrap');
    els.timerProgress = $('timer-progress');
    els.gameBody = $('game-body');
    els.summaryBody = $('summary-body');
    els.historyBody = $('history-body');
    els.btnClearHistory = $('btn-clear-history');
  }

  function bindEvents() {
    $('btn-start').addEventListener('click', openModeSheet);
    $('btn-history').addEventListener('click', openHistory);
    $('btn-announce').addEventListener('click', function () { openOverlay('overlay-announce'); });
    $('btn-create').addEventListener('click', createRoom);
    $('btn-join').addEventListener('click', function () { showJoinPanel(els.inputCode.value); });
    $('btn-solo').addEventListener('click', function () { closeOverlay('overlay-mode'); startSolo(); });
    $('btn-join-go').addEventListener('click', joinRoomFromInput);
    $('btn-copy-code').addEventListener('click', copyInvite);
    $('btn-retry-connect').addEventListener('click', retryConnect);
    $('btn-ready').addEventListener('click', toggleReady);
    $('btn-begin').addEventListener('click', hostBegin);
    $('btn-clear-history').addEventListener('click', clearHistory);

    var promptButtons = document.querySelectorAll('[data-first-prompt]');
    for (var p = 0; p < promptButtons.length; p++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          setFirstPrompt(btn.getAttribute('data-first-prompt') === '1');
        });
      })(promptButtons[p]);
    }
    els.btnToggleFirst.addEventListener('click', function () {
      setFirstPrompt(!App.firstPrompt);
    });

    els.inputCode.addEventListener('input', function () {
      this.value = E.sanitizeRoomCode(this.value);
    });
    els.inputCode.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); joinRoomFromInput(); }
    });
    els.nickname.addEventListener('input', function () {
      var value = String(this.value || '').trim().slice(0, 12);
      profile.name = value;
      if (value) storeWrite(KEYS.profile, profile);
    });

    var closers = document.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { closeOverlay(btn.getAttribute('data-close')); });
      })(closers[i]);
    }

    var overlays = document.querySelectorAll('.overlay');
    for (var j = 0; j < overlays.length; j++) {
      (function (ov) {
        ov.addEventListener('click', function (e) {
          if (e.target === ov) closeOverlay(ov.id);
        });
      })(overlays[j]);
    }

    els.app.addEventListener('click', onAppClick);
    els.gameBody.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'answer-input') {
        e.preventDefault();
        submitFromInput();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = document.querySelector('.overlay.is-open');
      if (open) closeOverlay(open.id);
    });

    window.addEventListener('pagehide', function () {
      if (App.net) { try { App.net.stop(); } catch (_) {} }
      clearGameTimers();
      stopPresenceLoop();
    });
    window.addEventListener('offline', function () {
      if (App.mode === 'online') toast('网络已断开，恢复后会自动重连');
    });
    window.addEventListener('online', function () {
      if (App.mode === 'online') toast('网络恢复了');
    });
  }

  function onAppClick(e) {
    var target = e.target;
    var trigger = null;
    while (target && target !== document) {
      if (target.getAttribute && (target.getAttribute('data-action') || target.getAttribute('data-act'))) {
        trigger = target;
        break;
      }
      target = target.parentNode;
    }
    if (!trigger) return;
    var action = trigger.getAttribute('data-action');
    var act = trigger.getAttribute('data-act');
    if (action) {
      if (action === 'leave-room' || action === 'leave-game' || action === 'summary-home') leaveRoom();
      return;
    }
    if (act === 'submit') submitFromInput();
    else if (act === 'next') advanceRound();
    else if (act === 'restart') restartGame();
    else if (act === 'request-restart') requestRestart();
    else if (act === 'force-finish') forceGuestFinish();
    else if (act === 'home') leaveRoom();
    else if (act === 'open-room') {
      if (App.roomCode) {
        copyInvite();
      }
    }
  }

  /* ======================================================================
     初始化
     ====================================================================== */

  function handleUrlRoom() {
    var params = null;
    try { params = new URLSearchParams(location.search); } catch (_) { params = null; }
    if (!params) return;
    var room = E.sanitizeRoomCode(params.get('room') || '');
    if (!E.isValidRoomCode(room)) return;
    getNickname();
    openOverlay('overlay-mode');
    showJoinPanel(room);
    toast('朋友邀请你加入房间 ' + room, 3000);
  }

  function exposeDebug() {
    window.__TongCi = {
      version: '1.1.0',
      App: App,
      engine: E,
      words: W,
      net: Net,
      screens: activeScreen,
      state: function () {
        return {
          mode: App.mode,
          role: App.role,
          roomCode: App.roomCode,
          connected: App.connected,
          broker: App.broker,
          peer: App.peer ? { name: App.peer.name, online: App.peer.online, ready: App.peer.ready } : null,
          game: App.game ? {
            round: App.game.round,
            maxRounds: App.game.maxRounds,
            kind: App.game.kind,
            firstPrompt: App.game.firstPrompt !== false,
            phase: App.game.phase,
            success: !!App.game.success,
            roundsUsed: App.game.roundsUsed,
            answers: App.game.answers
          } : null,
          screen: activeScreen()
        };
      }
    };
  }

  function init() {
    cacheEls();
    loadProfile();
    bindEvents();
    getNickname();
    renderHomeMeta();
    initDemo();
    handleUrlRoom();
    exposeDebug();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
