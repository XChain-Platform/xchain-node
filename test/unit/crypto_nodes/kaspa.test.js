/*********************************************************************
 * Unit tests for crypto_nodes/kaspa (mocha; xchain-node globs every .test.js under test/unit)
 **********************************************************************/
'use strict';
const { expect } = require('chai');
const k = require('../../../crypto_nodes/kaspa/kaspa_node.js');

describe('crypto_nodes/kaspa node module', function () {

    describe('release assets', function () {
        it('every platform has an asset name, with a URL on the official release', function () {
            for (const p of ['linux-amd64', 'win64', 'osx']) {
                const a = k.assetFor(p);
                expect(a.file).to.match(/^rusty-kaspa-v\d+\.\d+\.\d+-/);
                expect(k.downloadUrl(p)).to.equal(
                    'https://github.com/kaspanet/rusty-kaspa/releases/download/' + k.VERSION + '/' + a.file);
            }
        });

        it('an unknown platform throws immediately (never returns undefined)', function () {
            expect(() => k.assetFor('solaris')).to.throw(/unknown platform/);
        });

        it('the win64 sha256 is 64 hex characters (computed locally, then registered)', function () {
            const h = k.assertHashKnown('win64');
            expect(h).to.have.length(64);
            expect(h).to.match(/^[0-9a-f]{64}$/);
        });

        it('fail-closed: a platform with no registered hash is REFUSED for download', function () {
            expect(() => k.assertHashKnown('linux-amd64')).to.throw(/refusing to download/);
        });

        it('verifySha256: case-insensitive, and anything not 64 long throws', function () {
            const h = k.assertHashKnown('win64');
            expect(k.verifySha256(h.toUpperCase(), h)).to.equal(true);
            expect(k.verifySha256('0'.repeat(64), h)).to.equal(false);
            expect(() => k.verifySha256('ab', h)).to.throw(/64 hex/);
            expect(() => k.verifySha256(h, '')).to.throw(/64 hex/);
        });
    });

    describe('port table (only the two sets verified in args.rs)', function () {
        it('mainnet:16110 / 16111 / 17110 / 18110', function () {
            expect(k.portsFor('mainnet')).to.deep.equal({ grpc: 16110, p2p: 16111, wrpcBorsh: 17110, wrpcJson: 18110 });
        });

        it('testnet: 16210 / 16211 / 17210 / 18210 (both wRPC ports shifted by +1000)', function () {
            expect(k.portsFor('testnet')).to.deep.equal({ grpc: 16210, p2p: 16211, wrpcBorsh: 17210, wrpcJson: 18210 });
        });

        it('simnet defaults are UNVERIFIED, so ports must be passed explicitly', function () {
            expect(() => k.portsFor('simnet')).to.throw(/unverified/);
            expect(k.portsFor('simnet', { grpc: 16510, p2p: 16511, wrpcBorsh: 17510, wrpcJson: 18510 }))
                .to.deep.equal({ grpc: 16510, p2p: 16511, wrpcBorsh: 17510, wrpcJson: 18510 });
        });
    });

    describe('startup arguments', function () {
        it('mainnet: no network flag, and appdir/utxoindex/listen/--yes/--disable-upnp', function () {
            const a = k.buildRunArgs({ network: 'mainnet', appdir: '/data/kaspa' });
            expect(a).to.include('--appdir=/data/kaspa');
            expect(a).to.include('--utxoindex');
            expect(a).to.include('--rpclisten=127.0.0.1:16110');
            expect(a).to.include('--rpclisten-borsh=127.0.0.1:17110');
            expect(a).to.include('--rpclisten-json=127.0.0.1:18110');
            expect(a).to.include('--listen=127.0.0.1:16111');
            expect(a).to.include('--yes');
            expect(a).to.include('--disable-upnp');
            expect(a).to.not.include('--testnet');
            expect(a).to.not.include('--archival');       // archival stays off by default (disk)
        });

        it('testnet: adds --testnet and uses the 16210/17210/18210 set', function () {
            const a = k.buildRunArgs({ network: 'testnet', appdir: '/d' });
            expect(a).to.include('--testnet');
            expect(a).to.include('--rpclisten=127.0.0.1:16210');
            expect(a).to.include('--rpclisten-borsh=127.0.0.1:17210');
        });

        it('indexer mode: archival on (KIP-15 keeps only ~30 hours of history)', function () {
            const a = k.buildRunArgs({ network: 'mainnet', appdir: '/d', archival: true });
            expect(a).to.include('--archival');
        });

        it('simnet bootstrap: mining unsynced is allowed, ports must be explicit', function () {
            const a = k.buildRunArgs({
                network: 'simnet', appdir: '/d', allowUnsyncedMining: true,
                ports: { grpc: 16510, p2p: 16511, wrpcBorsh: 17510, wrpcJson: 18510 }
            });
            expect(a).to.include('--simnet');
            expect(a).to.include('--enable-unsynced-mining');
            expect(a).to.include('--rpclisten-borsh=127.0.0.1:17510');
            expect(() => k.buildRunArgs({ network: 'simnet', appdir: '/d' })).to.throw(/unverified/);
        });

        it('argument checks: a missing appdir or a bad network name both throw', function () {
            expect(() => k.buildRunArgs({ network: 'mainnet' })).to.throw(/appdir/);
            expect(() => k.buildRunArgs({ network: 'mainet', appdir: '/d' })).to.throw(/unknown network/);
        });
    });

    describe('what replaces <coin>-cli', function () {
        it('tip guard: wRPC-JSON getBlockDagInfo instead, with the tip taken from sink', function () {
            const p = k.tipGuardPlan({ wrpcJsonPort: 18110, network: 'mainnet' });
            expect(p.url).to.equal('ws://127.0.0.1:18110/json');
            expect(p.method).to.equal('getBlockDagInfo');
            expect(p.pick).to.include('sink');
            expect(() => k.tipGuardPlan({})).to.throw(/wrpcJsonPort/);
        });

        it('version probe: getServerInfo serverVersion instead', function () {
            const p = k.remoteVersionProbe({ wrpcJsonPort: 16210 });
            expect(p.method).to.equal('getServerInfo');
            expect(p.pick).to.deep.equal(['serverVersion']);
        });

        it('IBD: progress is the judge (isSynced alone is not trustworthy - idle nodes measured false)', function () {
            const j = k.judgeInitialBlockDownload;
            // still growing: still catching up
            expect(j({ first: { headerCount: 100, blockCount: 100 }, second: { headerCount: 900, blockCount: 900 } }).initialblockdownload)
                .to.equal(true);
            // unchanged: caught up (even with isSynced=false - the exact case that was measured wrong)
            expect(j({ first: { headerCount: 1504, blockCount: 1504 }, second: { headerCount: 1504, blockCount: 1504 }, isSynced: false }).initialblockdownload)
                .to.equal(false);
            // too few samples: wait conservatively (do not let it through)
            expect(j({ first: null, second: { headerCount: 1, blockCount: 1 } }).initialblockdownload).to.equal(true);
            expect(j({}).initialblockdownload).to.equal(true);
            // contradictory numbers: wait conservatively
            expect(j({ first: { headerCount: 5, blockCount: 9 }, second: { headerCount: 5, blockCount: 8 } }).initialblockdownload)
                .to.equal(true);
            // with isSynced=true as a backstop, treat it as caught up
            expect(j({ first: { headerCount: 5, blockCount: 9 }, second: { headerCount: 5, blockCount: 8 }, isSynced: true }).initialblockdownload)
                .to.equal(false);
        });

        it('health start period: first sync is hours (RPC is unusable throughout IBD)', function () {
            expect(k.healthStartPeriodSeconds({ network: 'mainnet', firstSync: true })).to.equal(6 * 3600);
            expect(k.healthStartPeriodSeconds({ network: 'mainnet', archival: true, firstSync: true })).to.equal(12 * 3600);
            expect(k.healthStartPeriodSeconds({ network: 'simnet', firstSync: true })).to.equal(120);
            expect(k.healthStartPeriodSeconds({ network: 'mainnet', firstSync: false })).to.equal(600);
        });
    });

    describe('liveness', function () {
        it('the probe checks both the wRPC port and log freshness (a port alone misses a wedge)', function () {
            const p = k.buildHealthProbe({ wrpcBorshPort: 17110, logDir: '/data/kaspa/logs', freshMinutes: 5 });
            expect(p[0]).to.equal('sh');
            expect(p[1]).to.equal('-c');
            expect(p[2]).to.include('nc -z 127.0.0.1 17110');
            expect(p[2]).to.include('find /data/kaspa/logs -type f -mmin -5');
        });

        it('a missing port throws', function () {
            expect(() => k.buildHealthProbe({})).to.throw(/wrpcBorshPort/);
        });
    });
});

describe('crypto_nodes/kaspa: the Dockerfile agrees with the module', function () {
    it('start-period equals healthStartPeriodSeconds(mainnet, archival, firstSync)', function () {
        const fs = require('fs');
        const path = require('path');
        const dockerfile = fs.readFileSync(path.join(__dirname, '../../../crypto_nodes/kaspa/Dockerfile'), 'utf8');
        const m = dockerfile.match(/--start-period=(\d+)s/);
        expect(m, 'Dockerfile must declare a start-period').to.not.equal(null);
        const expected = k.healthStartPeriodSeconds({ network: 'mainnet', archival: true, firstSync: true });
        expect(Number(m[1])).to.equal(expected);   // if either magic number drifts, this goes red
    });
});
