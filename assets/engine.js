/*!
 * 同词相见 · 纯逻辑引擎（无 DOM、无网络，可单独在 Node 中测试）
 *
 * 玩法模型：
 *   第 1 轮：双方各拿到一个不同的提示词，各自写下第一个联想。
 *   第 2 轮起：双方都看到上一轮彼此写下的两个词，各自写下它们的「共同点」。
 *   任何一轮双方写出同一个词 → 同词相见，本局结束。
 *   最多 6 轮仍未同词 → 本局未相遇。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WordMeetEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.1.0';
  var ROOM_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
  var ROOM_LENGTH = 6;
  var MAX_ANSWER_LENGTH = 10;
  var DEFAULT_MAX_ROUNDS = 6;

  var WORDS = (root && root.WordMeetWords) || null;
  var FALLBACK_TIERS = {
    perfect: { title: '一眼同频', desc: '第一轮就想到同一个词，你们的脑回路大概是同一款。' },
    high: { title: '默契正在升温', desc: '绕了几下，你们还是走到了同一个词。' },
    low: { title: '绕了一圈才相遇', desc: '过程有点曲折，但该撞上的总会撞上。' },
    zero: { title: '这次没有撞上', desc: '几轮下来没找到同一个词，但你们已经交换了很多念头。' }
  };
  var FALLBACK_BRIDGE_WORDS = ['故事', '回忆', '时间', '快乐', '温暖', '生活', '声音', '颜色', '朋友', '想象'];

  var associationCache = null;
  var curatedPairCache = null;

  /* ---------------- 随机与哈希 ---------------- */

  // FNV-1a（32 位），用于把房间号稳定映射到服务器
  function hashString(str) {
    var h = 0x811c9dc5;
    var s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32：给定种子后输出稳定伪随机序列
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createRng(seed) {
    if (typeof seed === 'string') return mulberry32(hashString(seed));
    if (typeof seed === 'number' && isFinite(seed)) return mulberry32(seed);
    return Math.random;
  }

  function randomSeed() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function pickOne(list, rand) {
    if (!list || !list.length) return '';
    var r = typeof rand === 'function' ? rand() : Math.random();
    return list[Math.floor(r * list.length) % list.length];
  }

  function generateRoomCode(rand) {
    var code = '';
    for (var i = 0; i < ROOM_LENGTH; i++) code += ROOM_CHARSET[Math.floor((rand || Math.random)() * ROOM_CHARSET.length)];
    return code;
  }

  function sanitizeRoomCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_LENGTH);
  }

  function isValidRoomCode(code) {
    return typeof code === 'string' && code.length === ROOM_LENGTH && /^[A-Z0-9]+$/.test(code);
  }

  function brokerIndexForRoom(code, count) {
    if (!count || count < 1) return 0;
    return hashString('tongci:broker:' + code) % count;
  }

  /* ---------------- 词语处理 ---------------- */

  function normalizeWord(input) {
    if (typeof input !== 'string') return '';
    var s;
    try {
      s = input.normalize('NFKC');
    } catch (_) {
      s = input;
    }
    // 去掉空白、标点与符号（保留文字与数字），拉丁字母统一小写
    s = s.replace(/[\s\u3000]+/g, '').replace(/[\p{P}\p{S}]/gu, '');
    return s.toLowerCase();
  }

  function isValidAnswer(raw) {
    if (typeof raw !== 'string') return false;
    var trimmed = raw.trim();
    if (!trimmed) return false;
    if (Array.from(trimmed).length > MAX_ANSWER_LENGTH) return false;
    return normalizeWord(trimmed).length > 0;
  }

  function isMatch(a, b) {
    var x = normalizeWord(a);
    var y = normalizeWord(b);
    return !!x && x === y;
  }

  /* ---------------- 第一轮的提示词 ---------------- */

  /**
   * 从词库里随机抽一组提示词，并随机决定哪张给房主、哪张给访客。
   * 返回值里的 target / alts 只给单人试玩（影子玩家）用，联机时只发送 a / b。
   */
  function pickStartPair(pairs, seed) {
    var source = (pairs || (WORDS && WORDS.CUE_PAIRS) || []).slice();
    if (!source.length) return { a: '', b: '', target: '', alts: [] };
    var rand = createRng(seed);
    var pair = source[Math.floor(rand() * source.length) % source.length];
    var swap = rand() < 0.5;
    return {
      a: swap ? pair.b : pair.a,
      b: swap ? pair.a : pair.b,
      target: pair.target,
      alts: Array.isArray(pair.alts) ? pair.alts.slice() : []
    };
  }

  /* ---------------- 共同点（桥接词） ---------------- */

  function buildAssociationIndex() {
    var index = Object.create(null);
    var pairs = (WORDS && WORDS.CUE_PAIRS) || [];
    pairs.forEach(function (pair) {
      var members = [pair.a, pair.b, pair.target].concat(pair.alts || []);
      var seen = Object.create(null);
      var clean = [];
      members.forEach(function (word) {
        var key = normalizeWord(word);
        if (!key || seen[key]) return;
        seen[key] = true;
        clean.push({ key: key, display: word });
      });
      clean.forEach(function (source) {
        if (!index[source.key]) index[source.key] = Object.create(null);
        clean.forEach(function (other) {
          if (other.key !== source.key) index[source.key][other.key] = other.display;
        });
      });
    });
    return index;
  }

  function associationIndex() {
    if (!associationCache) associationCache = buildAssociationIndex();
    return associationCache;
  }

  function associationList(key) {
    var map = associationIndex()[normalizeWord(key)];
    if (!map) return [];
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function curatedPairMap() {
    if (curatedPairCache) return curatedPairCache;
    var map = Object.create(null);
    ((WORDS && WORDS.CUE_PAIRS) || []).forEach(function (pair) {
      var x = normalizeWord(pair.a);
      var y = normalizeWord(pair.b);
      if (!x || !y) return;
      var key = x < y ? x + '\u0001' + y : y + '\u0001' + x;
      if (!map[key]) map[key] = pair;
    });
    curatedPairCache = map;
    return map;
  }

  function findCuratedPair(a, b) {
    var x = normalizeWord(a);
    var y = normalizeWord(b);
    if (!x || !y) return null;
    var key = x < y ? x + '\u0001' + y : y + '\u0001' + x;
    return curatedPairMap()[key] || null;
  }

  function bridgeFallbackWords() {
    if (WORDS && Array.isArray(WORDS.BRIDGE_FALLBACK) && WORDS.BRIDGE_FALLBACK.length) return WORDS.BRIDGE_FALLBACK;
    return FALLBACK_BRIDGE_WORDS;
  }

  /**
   * 给「上一轮的两个词」找一个共同点（影子玩家用，也可作为提示参考）。
   * 优先取词库里这对词的共同联想，其次取两个词关联词的交集，再退到并集或通用词。
   */
  function pickBridge(pairWords, rand) {
    var rng = typeof rand === 'function' ? rand : Math.random;
    var cleaned = (Array.isArray(pairWords) ? pairWords : [])
      .map(function (word) { return { raw: word, key: normalizeWord(word) }; })
      .filter(function (item) { return item.key; });
    if (!cleaned.length) return pickOne(bridgeFallbackWords(), rng);

    if (cleaned.length === 1) {
      var rel = associationList(cleaned[0].key);
      return rel.length ? pickOne(rel, rng) : pickOne(bridgeFallbackWords(), rng);
    }

    var first = cleaned[0];
    var second = cleaned[1];
    var pair = findCuratedPair(first.key, second.key);
    if (pair) {
      if (rng() < 0.88) return pair.target;
      var options = [pair.a, pair.b].concat(pair.alts || []).filter(function (word) {
        var key = normalizeWord(word);
        return key !== first.key && key !== second.key;
      });
      return options.length ? pickOne(options, rng) : pair.target;
    }

    var index = associationIndex();
    var relA = index[first.key] || {};
    var relB = index[second.key] || {};
    var common = [];
    Object.keys(relA).forEach(function (key) {
      if (key === first.key || key === second.key) return;
      if (relB[key]) common.push(relA[key]);
    });
    if (common.length) return pickOne(common, rng);

    var union = [];
    var added = Object.create(null);
    Object.keys(relA).forEach(function (key) {
      if (key === first.key || key === second.key || added[key]) return;
      added[key] = true;
      union.push(relA[key]);
    });
    Object.keys(relB).forEach(function (key) {
      if (key === first.key || key === second.key || added[key]) return;
      added[key] = true;
      union.push(relB[key]);
    });
    if (union.length) return pickOne(union, rng);
    return pickOne(bridgeFallbackWords(), rng);
  }

  /* ---------------- 对局 ---------------- */

  function computeReveal(answers) {
    var a = answers && answers.host ? String(answers.host) : '';
    var b = answers && answers.guest ? String(answers.guest) : '';
    return {
      answers: { host: a, guest: b },
      matched: isMatch(a, b)
    };
  }

  /* ---------------- 影子玩家 ---------------- */

  /**
   * 第 1 轮影子玩家的作答：
   * - 玩家的词在常见联想池里：55% 想到同一个词，否则换一个常见联想；
   * - 玩家的词很特别：仅有 10% 的巧合概率撞上；
   * - 玩家还没作答时：从 target / alts 中随机。
   */
  function pickAiAnswer(pair, playerWord, rand) {
    var rng = typeof rand === 'function' ? rand : Math.random;
    if (!pair) return '';
    var pool = [pair.target].concat(pair.alts || []).filter(Boolean);
    var pWord = normalizeWord(playerWord);
    if (pWord) {
      var hit = null;
      for (var i = 0; i < pool.length; i++) {
        if (normalizeWord(pool[i]) === pWord) { hit = pool[i]; break; }
      }
      if (hit) {
        if (rng() < 0.55) return hit;
        var others = pool.filter(function (w) { return normalizeWord(w) !== pWord; });
        return others.length ? pickOne(others, rng) : hit;
      }
      if (rng() < 0.1) return playerWord;
    }
    return pickOne(pool, rng) || '';
  }

  /**
   * 自由发挥时给影子玩家随机一个常见联想词（没有提示词可用）。
   */
  function pickFreeWord(rand) {
    var rng = typeof rand === 'function' ? rand : Math.random;
    var pool = [];
    ((WORDS && WORDS.CUE_PAIRS) || []).forEach(function (pair) {
      if (pair && pair.target) pool.push(pair.target);
    });
    if (!pool.length) pool = bridgeFallbackWords();
    return pickOne(pool, rng);
  }

  /* ---------------- 结算 ---------------- */

  function resultTier(success, roundsUsed, maxRounds) {
    var tiers = (WORDS && WORDS.TIERS) || FALLBACK_TIERS;
    if (!success) return Object.assign({ key: 'zero' }, tiers.zero);
    var used = Math.max(1, Number(roundsUsed) || 1);
    if (used <= 1) return Object.assign({ key: 'perfect' }, tiers.perfect);
    if (used <= 4) return Object.assign({ key: 'high' }, tiers.high);
    return Object.assign({ key: 'low' }, tiers.low);
  }

  function aggregateHistory(list) {
    var out = { games: 0, matches: 0, successes: 0, rounds: 0, onlineGames: 0, soloGames: 0, peers: [] };
    var peers = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      out.games++;
      out.matches += Math.max(0, Number(entry.matches) || 0);
      if (entry.success) out.successes++;
      out.rounds += Math.max(0, Number(entry.roundsUsed) || 0);
      if (entry.mode === 'online') {
        out.onlineGames++;
        var peerName = entry.peer && entry.peer.name;
        if (peerName) peers[peerName] = true;
      } else {
        out.soloGames++;
      }
    });
    out.peers = Object.keys(peers);
    return out;
  }

  function formatRelativeTime(ts, now) {
    var t = Number(ts) || 0;
    var n = Number(now) || Date.now();
    var d = new Date(t);
    var today = new Date(n);
    var pad = function (v) { return (v < 10 ? '0' : '') + v; };
    var hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (t >= startOfToday) return '今天 ' + hhmm;
    if (t >= startOfToday - 86400000) return '昨天 ' + hhmm;
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hhmm;
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  return {
    VERSION: VERSION,
    ROOM_CHARSET: ROOM_CHARSET,
    ROOM_LENGTH: ROOM_LENGTH,
    MAX_ANSWER_LENGTH: MAX_ANSWER_LENGTH,
    DEFAULT_MAX_ROUNDS: DEFAULT_MAX_ROUNDS,
    hashString: hashString,
    createRng: createRng,
    randomSeed: randomSeed,
    pickOne: pickOne,
    generateRoomCode: generateRoomCode,
    sanitizeRoomCode: sanitizeRoomCode,
    isValidRoomCode: isValidRoomCode,
    brokerIndexForRoom: brokerIndexForRoom,
    normalizeWord: normalizeWord,
    isValidAnswer: isValidAnswer,
    isMatch: isMatch,
    pickStartPair: pickStartPair,
    findCuratedPair: findCuratedPair,
    pickBridge: pickBridge,
    computeReveal: computeReveal,
    pickAiAnswer: pickAiAnswer,
    pickFreeWord: pickFreeWord,
    resultTier: resultTier,
    aggregateHistory: aggregateHistory,
    formatRelativeTime: formatRelativeTime
  };
});
