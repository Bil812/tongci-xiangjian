/**
 * 公共 MQTT 服务器连通性冒烟测试（Node 端，非浏览器）
 * 用法：npm run test:mqtt
 * 说明：公共免费服务器只用于自测；至少要求两台 EMQX 可用。
 */
import mqtt from 'mqtt';

const BROKERS = [
  { id: 'emqx-global', label: 'EMQX 国际', url: 'wss://broker.emqx.io:8084/mqtt' },
  { id: 'emqx-cn', label: 'EMQX 中国', url: 'wss://broker-cn.emqx.io:8084/mqtt' },
  { id: 'mosquitto', label: 'Mosquitto 测试', url: 'wss://test.mosquitto.org:8081/mqtt' }
];

function roundtrip(broker, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const topic = 'tongci/smoke/' + Math.random().toString(36).slice(2, 10);
    const client = mqtt.connect(broker.url, {
      clientId: 'tcsmoke_' + Math.random().toString(36).slice(2, 10),
      clean: true,
      connectTimeout: 9000,
      reconnectPeriod: 0,
      keepalive: 30
    });
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { client.end(true); } catch (_) {}
      resolve({ ...broker, ok, detail, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    client.on('error', (err) => finish(false, 'error: ' + (err && err.message)));
    client.on('connect', () => {
      client.subscribe(topic, { qos: 1 }, (subErr) => {
        if (subErr) return finish(false, 'subscribe: ' + subErr.message);
        const t0 = Date.now();
        client.publish(topic, JSON.stringify({ hello: 'tongci' }), { qos: 1 }, (pubErr) => {
          if (pubErr) finish(false, 'publish: ' + pubErr.message);
        });
        client.once('message', () => {
          clearTimeout(timer);
          finish(true, 'roundtrip ' + (Date.now() - t0) + 'ms');
        });
      });
    });
  });
}

const results = [];
for (const broker of BROKERS) {
  const result = await roundtrip(broker);
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}  ${result.detail}  (${result.ms}ms)`);
}

const emqxOk = results.filter((r) => r.id.startsWith('emqx') && r.ok).length;
if (emqxOk < 2) {
  console.error('至少需要两台 EMQX 公共服务器可用，请检查网络后重试。');
  process.exit(1);
}
const working = results.filter((r) => r.ok).length;
console.log(`\n可用服务器：${working}/${results.length}，EMQX：${emqxOk}/2`);
