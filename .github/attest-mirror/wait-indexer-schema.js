'use strict';
// Venue warm-up: waits until the stack indexer's schema exists (issues table) and its /status answers, so a leg's
// initialCheck ISSUE never races the indexer's first migration. Credentials come from the stack .env via env.
const mariadb = require('module').createRequire(require('path').join(process.env.ATTEST_MIRROR_E2E_DIR, 'package.json'))('mariadb');
const waitMs = Number(process.env.ATTEST_SCHEMA_WAIT_MS || 1200000);
const deadline = Date.now() + waitMs;
(async () => {
    for (;;) {
        let ok = false;
        try {
            const c = await mariadb.createConnection({ host: '127.0.0.1', port: Number(process.env.DB_HOST_PORT), user: 'root', password: process.env.DB_PASSWORD });
            const rows = await c.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'XChain_BTC_Regtest_Indexer' AND table_name = 'issues'");
            await c.end();
            const res = await fetch(`http://127.0.0.1:${process.env.INDEXER_HOST_PORT}/status`).catch(() => null);
            ok = Number(rows[0].n) === 1 && !!res && res.ok;
        } catch (e) { ok = false; }
        if (ok) { console.log('indexer schema ready'); return; }
        if (Date.now() > deadline) { console.log('indexer schema NOT ready after ' + Math.round(waitMs / 1000) + ' s'); process.exit(5); }
        await new Promise((r) => setTimeout(r, 3000));
    }
})();
