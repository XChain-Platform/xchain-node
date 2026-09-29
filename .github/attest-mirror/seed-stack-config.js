'use strict';
// Seeds the stack hub's chain config for BTC, LTC and DOGE so chainRail.createRail can resolve each coin.
const port = Number(process.argv[2]);
const pass = process.env.DB_PASSWORD;
if (!port || !pass) process.exit(2);
const ixHost = { BTC: 'indexer', LTC: 'ltc-indexer', DOGE: 'doge-indexer' };
function services(code) {
    return {
        'xchain-decoder': { host: 'db', port: '3306', name: `XChain_${code}_Regtest_Decoder`, user: 'root', pass },
        'xchain-indexer': { host: ixHost[code], port: '3004', name: `XChain_${code}_Regtest_Indexer`, user: 'root', pass }
    };
}
const config = {
    bitcoin: { regtest: services('BTC') },
    litecoin: { regtest: services('LTC') },
    dogecoin: { regtest: services('DOGE') }
};
fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'updateconfig', params: { config } })
}).then(async (response) => {
    const body = await response.json();
    if (!response.ok || !body.result || body.result.status !== 'success') process.exit(3);
    process.stdout.write('stack config seeded (bitcoin, litecoin, dogecoin)\n');
}).catch(() => process.exit(4));
