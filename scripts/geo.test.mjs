// 坐标转换的测试：npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outOfChina, wgs84ToGcj02 } from '../src/lib/geo.js';

const close = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

test('国内坐标会偏移到 GCJ-02（对照公开实现 eviltransform 的示例）', () => {
  // eviltransform: wgs2gcj(39.915, 116.404) = (39.91640428150164, 116.41024449916938)
  const [lat, lng] = wgs84ToGcj02(39.915, 116.404);
  assert.ok(close(lat, 39.91640428150164, 1e-9), `lat ${lat}`);
  assert.ok(close(lng, 116.41024449916938, 1e-9), `lng ${lng}`);
});

test('偏移量在几百米量级', () => {
  for (const [lat, lng] of [[47.8666, 88.1166], [29.7147, 118.3376], [29.4167, 114.65]]) {
    const [glat, glng] = wgs84ToGcj02(lat, lng);
    const meters = Math.hypot((glat - lat) * 111_000, (glng - lng) * 111_000 * Math.cos((lat * Math.PI) / 180));
    assert.ok(meters > 50 && meters < 1000, `${lat},${lng} 偏移 ${meters.toFixed(0)} 米`);
  }
});

test('境外坐标原样返回', () => {
  assert.ok(outOfChina(64.1814, -51.6941)); // 努克
  assert.deepEqual(wgs84ToGcj02(64.1814, -51.6941), [64.1814, -51.6941]);
  assert.ok(!outOfChina(29.7147, 118.3376)); // 徽州
});
