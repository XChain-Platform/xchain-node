//  doctrine test-coverage program: unit coverage for
// src/TelemetryConnector.js. Telemetry is best-effort and must never throw or
// block a CLI command; this pins the URL-resolution precedence and the
// fail-silent contract of report().

const assert = require('assert');
const TelemetryConnector = require('../../src/TelemetryConnector.js');

describe('TelemetryConnector', function () {
    const savedEnv = process.env.XCHAIN_NODE_TELEMETRY_URL;
    afterEach(function () {
        if (savedEnv === undefined) delete process.env.XCHAIN_NODE_TELEMETRY_URL;
        else process.env.XCHAIN_NODE_TELEMETRY_URL = savedEnv;
    });

    it('defaults to the central hub telemetry URL', function () {
        delete process.env.XCHAIN_NODE_TELEMETRY_URL;
        const t = new TelemetryConnector();
        assert.strictEqual(t.url, TelemetryConnector.DEFAULT_TELEMETRY_URL);
        assert.ok(/^https:\/\//.test(t.url), 'default must be https');
    });

    it('honors the XCHAIN_NODE_TELEMETRY_URL override', function () {
        process.env.XCHAIN_NODE_TELEMETRY_URL = 'http://collector.example/telemetry';
        const t = new TelemetryConnector();
        assert.strictEqual(t.url, 'http://collector.example/telemetry');
    });

    it('an explicit url argument wins over the env override', function () {
        process.env.XCHAIN_NODE_TELEMETRY_URL = 'http://env.example/telemetry';
        const t = new TelemetryConnector('http://explicit.example/telemetry');
        assert.strictEqual(t.url, 'http://explicit.example/telemetry');
    });

    it('report() resolves false (never throws) when the endpoint is unreachable', async function () {
        // 127.0.0.1:1 refuses immediately; a short timeout keeps the test fast.
        const t = new TelemetryConnector('http://127.0.0.1:1/telemetry');
        const ok = await t.report({ event: 'test' }, 500);
        assert.strictEqual(ok, false);
    });
});
