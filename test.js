import assert from 'assert';
import { config } from './config.js';
import { getRealtimeStats, recordUser, incrementStat } from './statsManager.js';
import app from './server.js';

console.log('🧪 Starting NOVA XMD Automated Diagnostics & Tests...\n');

// 1. Test Config Integrity
assert.ok(config.botName, 'Config must have botName');
assert.ok(config.port, 'Config must have port');
assert.ok(config.sessionDir, 'Config must have sessionDir');
console.log('✅ Test 1: Configuration is valid.');

// 2. Test Stats Manager Resilience
recordUser('252615555555');
incrementStat('messagesHandled');
const stats = getRealtimeStats(false, null);
assert.strictEqual(stats.status, 'success', 'Stats response should be successful');
assert.ok(typeof stats.totalUsers.count === 'number', 'totalUsers count should be a number');
assert.ok(typeof stats.freeSlots.count === 'number', 'freeSlots count should be a number');
console.log('✅ Test 2: Stats Manager resilient execution passed.');

// 3. Test Express App API Endpoints
const server = app.listen(0, async () => {
  const port = server.address().port;
  try {
    const resStats = await fetch(`http://localhost:${port}/api/stats`);
    assert.strictEqual(resStats.status, 200, '/api/stats should return HTTP 200');
    const jsonStats = await resStats.json();
    assert.strictEqual(jsonStats.status, 'success');

    const resStatus = await fetch(`http://localhost:${port}/api/status`);
    assert.strictEqual(resStatus.status, 200, '/api/status should return HTTP 200');
    const jsonStatus = await resStatus.json();
    assert.strictEqual(jsonStatus.botName, config.botName);

    server.close();
    console.log('✅ Test 3: Express /api/stats and /api/status endpoints responded with HTTP 200.');
    console.log('\n🎉 ALL DIAGNOSTIC TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } catch (err) {
    server.close();
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
});
