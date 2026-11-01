import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Words = require('../assets/words.js');
const E = require('../assets/engine.js');

/* ------------------------------------------------------------------ */
/* 词库                                                                */
/* ------------------------------------------------------------------ */

test('词库结构合理：词对数量、字段、答案不等于提示词', () => {
  assert.ok(Array.isArray(Words.CUE_PAIRS));
  assert.ok(Words.CUE_PAIRS.length >= 40, '至少提供 40 组词对');
  for (const pair of Words.CUE_PAIRS) {
    assert.ok(pair.a && pair.b && pair.target, JSON.stringify(pair));
    assert.notEqual(pair.a, pair.b);
    assert.notEqual(pair.target, pair.a);
    assert.notEqual(pair.target, pair.b);
    assert.ok(Array.isArray(pair.alts) && pair.alts.length >= 2);
  }
  assert.ok(Words.DEMO_PAIRS.length >= 3);
  assert.ok(Words.DEFAULT_NICKNAMES.length >= 5);
  assert.ok(Words.AI_NAMES.length >= 2);
  assert.ok(Array.isArray(Words.BRIDGE_FALLBACK) && Words.BRIDGE_FALLBACK.length >= 5);
});

test('演示词对与首页截图一致', () => {
  const first = Words.DEMO_PAIRS[0];
  assert.deepEqual({ a: first.a, b: first.b, target: first.target }, { a: '大海', b: '天空', target: '蓝色' });
});

/* ------------------------------------------------------------------ */
/* 词语归一化                                                          */
/* ------------------------------------------------------------------ */

test('normalizeWord 去掉空白和标点、统一大小写与全角', () => {
  assert.equal(E.normalizeWord('  Blue  '), 'blue');
  assert.equal(E.normalizeWord('蓝，色！'), '蓝色');
  assert.equal(E.normalizeWord('ＡＢＣ'), 'abc');
  assert.equal(E.normalizeWord('“大海”'), '大海');
  assert.equal(E.normalizeWord('---'), '');
  assert.equal(E.normalizeWord(''), '');
  assert.equal(E.normalizeWord(null), '');
  assert.equal(E.normalizeWord('一 个 词'), '一个词');
});

test('isValidAnswer：空、纯符号、超长都不合法', () => {
  assert.equal(E.isValidAnswer('蓝色'), true);
  assert.equal(E.isValidAnswer('  '), false);
  assert.equal(E.isValidAnswer('！！！'), false);
  assert.equal(E.isValidAnswer('一二三四五六七八九十'), true);
  assert.equal(E.isValidAnswer('一二三四五六七八九十一'), false);
  assert.equal(E.isValidAnswer('a'.repeat(11)), false);
});

test('isMatch：归一化后相同即相遇', () => {
  assert.equal(E.isMatch('蓝色', ' 蓝色。'), true);
  assert.equal(E.isMatch('Blue', 'blue'), true);
  assert.equal(E.isMatch('蓝', '蓝色'), false);
  assert.equal(E.isMatch('', ''), false);
  assert.equal(E.isMatch('，', '。'), false);
});

/* ------------------------------------------------------------------ */
/* 房间号与服务器选路                                                  */
/* ------------------------------------------------------------------ */

test('generateRoomCode 长度与字符集合规，且可由种子复现', () => {
  const rng1 = E.createRng('seed-1');
  const rng2 = E.createRng('seed-1');
  const code1 = E.generateRoomCode(rng1);
  const code2 = E.generateRoomCode(rng2);
  assert.equal(code1, code2);
  assert.equal(code1.length, 6);
  assert.match(code1, /^[A-Z0-9]{6}$/);
  for (const ch of code1) assert.ok(E.ROOM_CHARSET.includes(ch));
  assert.ok(!/[IO01]/.test(code1));
});

test('sanitizeRoomCode / isValidRoomCode', () => {
  assert.equal(E.sanitizeRoomCode('ab-cd 12'), 'ABCD12');
  assert.equal(E.sanitizeRoomCode('你好ab12'), 'AB12');
  assert.equal(E.sanitizeRoomCode('abcdefg'), 'ABCDEF');
  assert.equal(E.isValidRoomCode('ABCDEF'), true);
  assert.equal(E.isValidRoomCode('ABC'), false);
  assert.equal(E.isValidRoomCode(''), false);
});

test('brokerIndexForRoom 稳定且落在 [0, count)', () => {
  for (const code of ['ABCDEF', 'WGBXQA', 'ZZZZZZ', '234567']) {
    const first = E.brokerIndexForRoom(code, 2);
    assert.equal(first, E.brokerIndexForRoom(code, 2));
    assert.ok(first >= 0 && first < 2);
    assert.ok(E.brokerIndexForRoom(code, 3) >= 0 && E.brokerIndexForRoom(code, 3) < 3);
  }
});

/* ------------------------------------------------------------------ */
/* 第一轮：起始提示词                                                  */
/* ------------------------------------------------------------------ */

test('pickStartPair：确定性、提示词来自同一组词对且互不相同', () => {
  const p1 = E.pickStartPair(Words.CUE_PAIRS, 'pair-seed');
  const p2 = E.pickStartPair(Words.CUE_PAIRS, 'pair-seed');
  assert.deepEqual(p1, p2);
  assert.ok(p1.a && p1.b);
  assert.notEqual(p1.a, p1.b);
  assert.ok(p1.target);
  assert.ok(Array.isArray(p1.alts));
  const found = E.findCuratedPair(p1.a, p1.b);
  assert.ok(found);
  assert.ok([found.a, found.b].includes(p1.a));
  assert.ok([found.a, found.b].includes(p1.b));
});

test('pickStartPair：不同种子能抽到不同词对', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const pair = E.pickStartPair(Words.CUE_PAIRS, 'seed-' + i);
    seen.add([pair.a, pair.b].sort().join('/'));
  }
  assert.ok(seen.size >= 5, '30 个种子只抽到 ' + seen.size + ' 组词对');
});

test('findCuratedPair 不区分顺序', () => {
  const p = E.findCuratedPair('大海', '天空');
  assert.ok(p);
  assert.equal(p.target, '蓝色');
  assert.equal(E.findCuratedPair('天空', '大海'), p);
  assert.equal(E.findCuratedPair('大海', '完全无关'), null);
});

/* ------------------------------------------------------------------ */
/* 找共同点（桥接词）                                                  */
/* ------------------------------------------------------------------ */

test('pickBridge：词库里的词对直接给出共同联想', () => {
  assert.equal(E.pickBridge(['大海', '天空'], () => 0), '蓝色');
  assert.equal(E.pickBridge(['天空', '大海'], () => 0), '蓝色');
});

test('pickBridge：候选词不是题目里的词', () => {
  const word = E.pickBridge(['大海', '天空'], () => 0.99);
  assert.ok(word);
  assert.notEqual(E.normalizeWord(word), '大海');
  assert.notEqual(E.normalizeWord(word), '天空');
});

test('pickBridge：用关联词交集找共同点', () => {
  // 「蓝色」和「浪花」都关联到「大海」
  const word = E.pickBridge(['蓝色', '浪花'], () => 0);
  assert.equal(word, '大海');
});

test('pickBridge：没有交集时退到并集/兜底词', () => {
  const word = E.pickBridge(['完全未知甲', '完全未知乙'], () => 0);
  assert.ok(Words.BRIDGE_FALLBACK.includes(word));
  const one = E.pickBridge(['大海', '完全未知乙'], () => 0);
  assert.ok(one);
  assert.notEqual(E.normalizeWord(one), '完全未知乙');
});

test('pickBridge：空输入返回兜底词', () => {
  const word = E.pickBridge([], () => 0);
  assert.ok(Words.BRIDGE_FALLBACK.includes(word));
  assert.ok(E.pickBridge([''], () => 0));
});

/* ------------------------------------------------------------------ */
/* 揭晓                                                                */
/* ------------------------------------------------------------------ */

test('computeReveal：同词、不同词、缺答案', () => {
  const r1 = E.computeReveal({ host: '蓝色', guest: ' 蓝色。' });
  assert.equal(r1.matched, true);
  assert.equal(r1.answers.host, '蓝色');
  const r2 = E.computeReveal({ host: '蓝色', guest: '红色' });
  assert.equal(r2.matched, false);
  const r3 = E.computeReveal({ host: '', guest: '' });
  assert.equal(r3.matched, false);
  assert.equal(r3.answers.host, '');
});

/* ------------------------------------------------------------------ */
/* 影子玩家                                                            */
/* ------------------------------------------------------------------ */

test('pickAiAnswer：常见联想有概率撞上，冷门词偶发巧合', () => {
  const pair = { target: '蓝色', alts: ['大海', '天空', '海风'] };
  // 玩家写的词在联想池里：随机数足够小 → 撞上
  assert.equal(E.pickAiAnswer(pair, '蓝色', () => 0), '蓝色');
  // 随机数大 → 换一个常见联想，但仍来自词池
  const alt = E.pickAiAnswer(pair, '天空', () => 0.99);
  assert.ok([pair.target, ...pair.alts].includes(alt));
  assert.notEqual(alt, '天空');
  // 冷门词：10% 内会巧合撞上
  assert.equal(E.pickAiAnswer(pair, '海平线', () => 0.05), '海平线');
  const miss = E.pickAiAnswer(pair, '海平线', () => 0.5);
  assert.ok([pair.target, ...pair.alts].includes(miss));
  // 玩家还没作答
  const noPlayer = E.pickAiAnswer(pair, '', () => 0.5);
  assert.ok([pair.target, ...pair.alts].includes(noPlayer));
});

test('pickFreeWord：自由发挥时给出词库里的常见联想词', () => {
  const word = E.pickFreeWord(() => 0);
  assert.ok(word && typeof word === 'string');
  const words = new Set();
  for (let i = 0; i < 40; i++) words.add(E.pickFreeWord(() => i / 40));
  assert.ok(words.size >= 5, '应能取到多个不同的词，实际 ' + words.size);
});

/* ------------------------------------------------------------------ */
/* 结算                                                                */
/* ------------------------------------------------------------------ */

test('resultTier：按相遇轮数分档，未相遇为 zero', () => {
  assert.equal(E.resultTier(true, 1, 6).key, 'perfect');
  assert.equal(E.resultTier(true, 2, 6).key, 'high');
  assert.equal(E.resultTier(true, 3, 6).key, 'high');
  assert.equal(E.resultTier(true, 4, 6).key, 'high');
  assert.equal(E.resultTier(true, 5, 6).key, 'low');
  assert.equal(E.resultTier(true, 6, 6).key, 'low');
  assert.equal(E.resultTier(false, 6, 6).key, 'zero');
  assert.equal(E.resultTier(false, 0, 6).key, 'zero');
});

test('aggregateHistory 统计局数、相遇、平均轮数、对手', () => {
  const list = [
    { mode: 'online', matches: 1, success: true, roundsUsed: 2, peer: { name: '山月' } },
    { mode: 'online', matches: 0, success: false, roundsUsed: 6, peer: { name: '山月' } },
    { mode: 'solo', matches: 1, success: true, roundsUsed: 3, peer: { name: '影子玩家' } },
    { mode: 'online', matches: 1, success: true, roundsUsed: 1, peer: { name: '晚风' } }
  ];
  const stats = E.aggregateHistory(list);
  assert.equal(stats.games, 4);
  assert.equal(stats.matches, 3);
  assert.equal(stats.successes, 3);
  assert.equal(stats.rounds, 12);
  assert.equal(stats.onlineGames, 3);
  assert.equal(stats.soloGames, 1);
  assert.deepEqual(stats.peers.sort(), ['山月', '晚风']);
  assert.equal(E.aggregateHistory([]).games, 0);
  assert.equal(E.aggregateHistory(null).games, 0);
});

test('formatRelativeTime 的今天/昨天/同年/跨年', () => {
  const now = new Date(2026, 2, 15, 15, 0, 0).getTime();
  const today = new Date(2026, 2, 15, 9, 5, 0).getTime();
  const yesterday = new Date(2026, 2, 14, 22, 40, 0).getTime();
  const sameYear = new Date(2026, 0, 5, 10, 0, 0).getTime();
  const lastYear = new Date(2025, 11, 31, 23, 0, 0).getTime();
  assert.equal(E.formatRelativeTime(today, now), '今天 09:05');
  assert.equal(E.formatRelativeTime(yesterday, now), '昨天 22:40');
  assert.equal(E.formatRelativeTime(sameYear, now), '1月5日 10:00');
  assert.equal(E.formatRelativeTime(lastYear, now), '2025年12月31日');
});

test('randomSeed 每次不同', () => {
  const seeds = new Set();
  for (let i = 0; i < 20; i++) seeds.add(E.randomSeed());
  assert.equal(seeds.size, 20);
});
