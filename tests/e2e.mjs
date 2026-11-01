/**
 * 浏览器端 E2E（Playwright-core + 本机 Edge）
 * 覆盖：首页 / 开始面板 / 单人第 1 轮 / 真实 MQTT 双人「先各写一个词 → 再一起找共同点」/
 *       同词即结束 / 再来一局 / 多轮未相遇 / 超时揭晓 / 历史记录 / 公告
 *
 * 运行：npm run test:e2e
 * 找不到浏览器时：设置环境变量 EDGE_PATH 指向 msedge.exe / chrome.exe
 * 需要联网（公共 MQTT 服务器）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(ROOT, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

function findBrowser() {
  const env = process.env.EDGE_PATH;
  const candidates = [
    env,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到可用的 Edge/Chrome，请设置 EDGE_PATH 环境变量');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('PASS  ' + name))
    .catch((err) => {
      failures.push({ name, err });
      console.error('FAIL  ' + name + '\n      ' + (err && err.message));
      throw err;
    });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const consoleErrors = [];
  const pageErrors = [];

  const attach = (page, tag) => {
    page.setDefaultTimeout(15000);
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/test\.mosquitto\.org/.test(text)) return; // 备用服务器失败属于预期噪音
      consoleErrors.push(`[${tag}] ${text}`);
    });
    page.on('pageerror', (err) => pageErrors.push(`[${tag}] ${err.message}`));
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  };

  async function openApp(contextOptions, initConfig) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, contextOptions || {}));
    if (initConfig) {
      await ctx.addInitScript((cfg) => { window.__TongCiConfig = cfg; }, initConfig);
    }
    const page = await ctx.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    return { ctx, page };
  }

  const primary = await openApp();
  const page = primary.page;
  attach(page, 'host');

  let roomCode = '';
  let guestPage = null;

  async function createRoom(hostPage, firstPrompt) {
    await hostPage.click('#btn-start');
    await sleep(300);
    await hostPage.click(firstPrompt === false ? '[data-first-prompt="0"]' : '[data-first-prompt="1"]');
    await hostPage.click('#btn-create');
    await hostPage.waitForFunction(() => /^[A-Z0-9]{6}$/.test((document.querySelector('#lobby-code') || {}).textContent || ''));
    await hostPage.waitForFunction(() => document.querySelector('#lobby-conn').dataset.state === 'connected', { timeout: 20000 });
    return (await hostPage.textContent('#lobby-code')).trim();
  }

  async function joinRoom(guestPage, code) {
    await guestPage.waitForSelector('#overlay-mode.is-open');
    assert.equal(await guestPage.inputValue('#input-room-code'), code);
    await guestPage.click('#btn-join-go');
    await guestPage.waitForFunction(() => /^[A-Z0-9]{6}$/.test((document.querySelector('#lobby-code') || {}).textContent || ''));
    await guestPage.waitForFunction(() => document.querySelector('#lobby-conn').dataset.state === 'connected', { timeout: 20000 });
    await guestPage.waitForFunction(() => document.querySelectorAll('#lobby-seats .seat').length === 2 && !document.querySelector('#lobby-seats .seat-empty'), { timeout: 15000 });
  }

  async function startGame(hostPage, otherPage) {
    await hostPage.click('#btn-ready');
    await otherPage.click('#btn-ready');
    await hostPage.waitForFunction(() => !document.querySelector('#btn-begin').disabled);
    await hostPage.click('#btn-begin');
    await hostPage.waitForSelector('#answer-input');
    await otherPage.waitForSelector('#answer-input');
  }

  async function answerBoth(hostPage, otherPage, hostWord, otherWord) {
    await hostPage.waitForSelector('#answer-input');
    await otherPage.waitForSelector('#answer-input');
    await hostPage.fill('#answer-input', hostWord);
    await otherPage.fill('#answer-input', otherWord);
    await hostPage.click('[data-act="submit"]');
    await otherPage.click('[data-act="submit"]');
    await hostPage.waitForSelector('.reveal-badge');
    await otherPage.waitForSelector('.reveal-badge');
    await sleep(350);
    return {
      hostBadge: (await hostPage.textContent('.reveal-badge')).trim(),
      guestBadge: (await otherPage.textContent('.reveal-badge')).trim()
    };
  }

  try {
    /* ---------------- 首页 ---------------- */
    await check('首页渲染与参考图文案一致', async () => {
      assert.match(await page.textContent('.home-title'), /同词相见·和朋友的脑回路碰个面/);
      assert.equal(await page.textContent('.announce-text'), '公告 · 必看！公告！');
      assert.match(await page.textContent('.hero-title'), /你的脑回路/);
      assert.equal(await page.textContent('#home-meta'), '公共 MQTT 实时联机 · 最多 6 轮');
      const chips = await page.$$eval('.demo .chip', (nodes) => nodes.map((n) => n.textContent.trim()));
      assert.deepEqual(chips, ['大海', '天空', '蓝色']);
      await shot(page, '01-home.png');
    });

    await check('开始游戏面板与昵称', async () => {
      await page.click('#btn-start');
      await page.waitForSelector('#overlay-mode.is-open');
      await sleep(500);
      assert.ok((await page.inputValue('#input-nickname')).trim().length > 0);
      await shot(page, '02-mode-sheet.png');
    });

    await check('无效房间号被拒绝', async () => {
      await page.click('#btn-join');
      await page.fill('#input-room-code', 'ABC');
      await page.click('#btn-join-go');
      await sleep(300);
      assert.match(await page.textContent('#toast'), /房间号|6 位/);
      assert.ok(await page.locator('#overlay-mode.is-open').count());
    });
    await page.click('#overlay-mode [data-close]');

    /* ---------------- 单人：第 1 轮 ---------------- */
    await check('单人试玩第 1 轮：提示词 → 写一个词 → 揭晓', async () => {
      await page.click('#btn-start');
      await sleep(300);
      await page.click('#btn-solo');
      await page.waitForSelector('#answer-input');
      assert.match(await page.textContent('#game-body .cue-label'), /你的词/);
      const cue = (await page.textContent('#game-body .cue-word')).trim();
      assert.ok(cue.length > 0);
      await shot(page, '03-solo-writing.png');
      await page.fill('#answer-input', '蓝色');
      await page.click('[data-act="submit"]');
      await page.waitForSelector('.reveal-badge');
      await sleep(400);
      const badge = (await page.textContent('.reveal-badge')).trim();
      assert.ok(badge === '差一点点' || badge.includes('同词相见'), badge);
      const words = await page.$$eval('.reveal-word', (nodes) => nodes.map((n) => n.textContent.trim()));
      assert.equal(words.length, 2);
      assert.ok(words[0].length > 0);
      await shot(page, '04-solo-reveal.png');
      const state = await page.evaluate(() => window.__TongCi.state());
      assert.equal(state.game.kind, 'cue');
      assert.ok(state.game.maxRounds >= 2);
    });

    await check('第一轮可切换为自由发挥（单人试玩）', async () => {
      await page.click('[data-action="leave-game"]');
      await page.waitForSelector('.screen[data-screen="home"].is-active');
      await page.click('#btn-start');
      await sleep(300);
      await page.click('[data-first-prompt="0"]');
      await page.click('#btn-solo');
      await page.waitForSelector('#answer-input');
      assert.match(await page.textContent('#game-body .cue-label'), /自由发挥/);
      const state = await page.evaluate(() => window.__TongCi.state());
      assert.equal(state.game.firstPrompt, false);
      await page.fill('#answer-input', '蓝色');
      await page.click('[data-act="submit"]');
      await page.waitForSelector('.reveal-badge');
      await sleep(300);
      const words = await page.$$eval('.reveal-word', (nodes) => nodes.map((n) => n.textContent.trim()));
      assert.equal(words.length, 2);
      assert.ok(words.every((word) => word && word !== '没作答'), '影子玩家在自由发挥时也应该作答: ' + words.join(' / '));
      await shot(page, '04b-free-first-round.png');
      await page.click('[data-action="leave-game"]');
      await page.waitForSelector('.screen[data-screen="home"].is-active');
    });

    /* ---------------- 真实 MQTT 联机：共同点链路 ---------------- */
    await check('房主创建房间并连上公共 MQTT', async () => {
      roomCode = await createRoom(page);
      assert.match(await page.textContent('#lobby-conn .conn-text'), /已连接/);
      assert.equal(await page.isVisible('#btn-retry-connect'), false);
      await shot(page, '05-lobby-host.png');
    });

    await check('访客通过邀请链接加入房间', async () => {
      const guest = await openApp();
      guestPage = guest.page;
      attach(guestPage, 'guest');
      // openApp 清空 localStorage 后重新打开首页；这里补一次带 room 参数的访问
      await guestPage.goto(server.url + '?room=' + roomCode, { waitUntil: 'networkidle' });
      await joinRoom(guestPage, roomCode);
      await page.waitForFunction(() => document.querySelectorAll('#lobby-seats .seat').length === 2 && !document.querySelector('#lobby-seats .seat-empty'), { timeout: 15000 });
      assert.equal(await guestPage.isVisible('#btn-toggle-first-prompt'), false);
      await shot(guestPage, '06-lobby-guest.png');
    });

    await check('双方准备后开始游戏，第 1 轮拿到不同提示词', async () => {
      await startGame(page, guestPage);
      await sleep(500);
      const hostCue = (await page.textContent('#game-body .cue-word')).trim();
      const guestCue = (await guestPage.textContent('#game-body .cue-word')).trim();
      assert.ok(hostCue.length > 0 && guestCue.length > 0);
      await shot(page, '07-game-round1.png');
    });

    await check('第 1 轮不同词：揭晓后进入「找共同点」的下一轮', async () => {
      const badges = await answerBoth(page, guestPage, '蓝色', '红色');
      assert.equal(badges.hostBadge, '差一点点');
      assert.equal(badges.guestBadge, '差一点点');
      await shot(page, '08-reveal-miss.png');
      const hostState = await page.evaluate(() => window.__TongCi.state());
      assert.equal(hostState.game.success, false);
      await page.click('[data-act="next"]');
      await page.waitForSelector('#answer-input');
      await guestPage.waitForSelector('#answer-input');
      await sleep(400);
      assert.ok(await page.locator('.bridge-block').count());
      assert.ok(await guestPage.locator('.bridge-block').count());
      const chips = await page.$$eval('.bridge-chip', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
      assert.equal(chips.length, 2);
      assert.ok(chips[0].includes('蓝色'), chips.join(' | '));
      assert.ok(chips[1].includes('红色'), chips.join(' | '));
      assert.match(await page.textContent('.bridge-block .cue-sub'), /共同点/);
      await shot(page, '09-bridge-writing.png');
      await guestPage.screenshot({ path: path.join(SHOTS, '10-bridge-writing-guest.png') });
      const state2 = await page.evaluate(() => window.__TongCi.state());
      assert.equal(state2.game.kind, 'bridge');
      assert.equal(state2.game.round, 1);
    });

    await check('第 2 轮写下同一个共同点：同词相见，本局结束', async () => {
      const badges = await answerBoth(page, guestPage, '冷', '冷');
      await shot(page, '11-reveal-hit.png');
      assert.match(badges.hostBadge, /同词相见 · 第 2 轮/);
      assert.match(badges.guestBadge, /同词相见 · 第 2 轮/);
      const hostState = await page.evaluate(() => window.__TongCi.state());
      const guestState = await guestPage.evaluate(() => window.__TongCi.state());
      assert.equal(hostState.game.success, true);
      assert.equal(hostState.game.roundsUsed, 2);
      assert.equal(guestState.game.success, true);
      assert.equal(guestState.game.roundsUsed, 2);
      await page.click('[data-act="next"]');
      await page.waitForSelector('.summary-score');
      await guestPage.waitForSelector('.summary-score');
      await sleep(500);
      assert.match((await page.textContent('.summary-score')).replace(/\s+/g, ' '), /2 轮 · 同词相见/);
      assert.match((await guestPage.textContent('.summary-score')).replace(/\s+/g, ' '), /2 轮 · 同词相见/);
      assert.equal((await page.textContent('.summary-tier')).trim(), '默契正在升温');
      const items = await page.$$eval('.summary-item', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ')));
      assert.equal(items.length, 2);
      assert.match(items[0], /提示 · /);
      assert.match(items[0], /蓝色/);
      assert.match(items[1], /上一轮 · 蓝色 \+ 红色/);
      assert.match(items[1], /冷/);
      const history = await page.evaluate(() => JSON.parse(localStorage.getItem('tongci.history.v1') || '[]'));
      assert.equal(history.length, 1);
      assert.equal(history[0].mode, 'online');
      assert.equal(history[0].success, true);
      assert.equal(history[0].roundsUsed, 2);
      await shot(page, '12-summary-hit.png');
      await guestPage.screenshot({ path: path.join(SHOTS, '13-summary-hit-guest.png') });
    });

    await check('再来一局：第 1 轮直接同词就结束', async () => {
      await page.click('[data-act="restart"]');
      await page.waitForSelector('#answer-input');
      await guestPage.waitForSelector('#answer-input');
      assert.match(await page.textContent('#game-round'), /第 1 \/ 6 轮/);
      const before = await page.evaluate(() => window.__TongCi.state());
      assert.equal(before.game.success, false);
      const badges = await answerBoth(page, guestPage, '蓝色', '蓝色');
      await shot(page, '14-restart-hit.png');
      assert.match(badges.hostBadge, /同词相见 · 第 1 轮/);
      await page.click('[data-act="next"]');
      await page.waitForSelector('.summary-score');
      await guestPage.waitForSelector('.summary-score');
      await sleep(400);
      assert.match((await page.textContent('.summary-score')).replace(/\s+/g, ' '), /1 轮 · 同词相见/);
    });

    await check('离开房间回到首页，历史记录可查看可清空', async () => {
      await page.click('[data-action="summary-home"]');
      await page.waitForSelector('.screen[data-screen="home"].is-active');
      await guestPage.click('[data-action="summary-home"]');
      await guestPage.waitForSelector('.screen[data-screen="home"].is-active');
      await page.click('#btn-history');
      await page.waitForSelector('#overlay-history.is-open');
      const count = await page.locator('.history-item').count();
      assert.ok(count >= 2, '至少 2 局记录，实际 ' + count);
      assert.match(await page.textContent('.history-item-score'), /同词相见/);
      await shot(page, '15-history.png');
      await page.click('#btn-clear-history');
      await page.click('#btn-clear-history');
      await sleep(300);
      assert.equal(await page.locator('.history-item').count(), 0);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tongci.history.v1') || '[]').length), 0);
      await page.click('#overlay-history [data-close]');
    });

    await check('公告弹窗可打开', async () => {
      await page.click('#btn-announce');
      await page.waitForSelector('#overlay-announce.is-open');
      assert.match(await page.textContent('#overlay-announce .modal-body'), /共同点/);
      await shot(page, '16-announce.png');
      await page.click('#overlay-announce [data-close]');
      await sleep(300);
    });

    /* ---------------- 失败路径：2 轮内没同词 ---------------- */
    await check('达到轮数上限仍未同词：双方都看到「未相遇」结算', async () => {
      const host = await openApp({}, { maxRounds: 2 });
      const guest = await openApp({}, { maxRounds: 2 });
      attach(host.page, 'fail-host');
      attach(guest.page, 'fail-guest');
      const code = await createRoom(host.page, false);
      await guest.page.goto(server.url + '?room=' + code, { waitUntil: 'networkidle' });
      await joinRoom(guest.page, code);
      assert.match(await host.page.textContent('#lobby-first-prompt'), /自由发挥/);
      await startGame(host.page, guest.page);
      await sleep(400);
      assert.match(await host.page.textContent('#game-body .cue-label'), /自由发挥/);
      assert.match(await guest.page.textContent('#game-body .cue-label'), /自由发挥/);
      const r1 = await answerBoth(host.page, guest.page, '甲', '乙');
      assert.equal(r1.hostBadge, '差一点点');
      await host.page.click('[data-act="next"]');
      await host.page.waitForSelector('#answer-input');
      await guest.page.waitForSelector('#answer-input');
      const r2 = await answerBoth(host.page, guest.page, '丙', '丁');
      assert.equal(r2.hostBadge, '差一点点');
      await host.page.click('[data-act="next"]');
      await host.page.waitForSelector('.summary-score');
      await guest.page.waitForSelector('.summary-score');
      await sleep(400);
      assert.match((await host.page.textContent('.summary-score')).replace(/\s+/g, ' '), /2 轮 · 未相遇/);
      assert.equal((await host.page.textContent('.summary-tier')).trim(), '这次没有撞上');
      assert.match((await guest.page.textContent('.summary-score')).replace(/\s+/g, ' '), /2 轮 · 未相遇/);
      const history = await host.page.evaluate(() => JSON.parse(localStorage.getItem('tongci.history.v1') || '[]'));
      assert.equal(history[0].success, false);
      assert.equal(history[0].roundsUsed, 2);
      await host.page.screenshot({ path: path.join(SHOTS, '17-summary-miss.png') });
      await host.ctx.close();
      await guest.ctx.close();
    });

    /* ---------------- 超时 ---------------- */
    await check('倒计时结束自动揭晓，并能带着提示词进入下一轮', async () => {
      const timeout = await openApp({}, { roundMs: 2200 });
      attach(timeout.page, 'timeout');
      await timeout.page.click('#btn-start');
      await sleep(300);
      await timeout.page.click('#btn-solo');
      await timeout.page.waitForSelector('.reveal-badge', { timeout: 12000 });
      assert.ok((await timeout.page.locator('.reveal-word.is-empty').count()) >= 1);
      await shot(timeout.page, '18-timeout-reveal.png');
      await timeout.page.click('[data-act="next"]');
      await timeout.page.waitForSelector('.bridge-block');
      await shot(timeout.page, '19-timeout-next-round.png');
      await timeout.ctx.close();
    });
  } finally {
    await primary.ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  assert.deepEqual(pageErrors, [], '页面 JS 错误: ' + JSON.stringify(pageErrors));
  assert.deepEqual(consoleErrors, [], '控制台错误: ' + JSON.stringify(consoleErrors));
}

main()
  .then(() => {
    console.log('\n全部 E2E 通过。截图目录: ' + SHOTS);
  })
  .catch((err) => {
    console.error('\nE2E 失败：' + (err && err.stack || err));
    if (failures.length) console.error('失败用例: ' + failures.map((f) => f.name).join(' / '));
    process.exit(1);
  });
