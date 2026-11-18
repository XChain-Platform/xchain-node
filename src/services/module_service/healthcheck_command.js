/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Healthcheck Command
 ********************************************************************/

'use strict'

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// authEnv names an environment variable of the container the probe runs in. When it is set
// there, the probe sends it as x-api-key. The name is expanded by the container's own shell
// and reaches the diagnostic fallback on its stdin, so the key never appears in the command,
// docker argv or `docker inspect`.
function healthcheckCommand({ url, postData, timeoutSeconds, authEnv }) {
    if (authEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(authEnv)) throw new Error('invalid healthcheck auth env name: ' + authEnv)
    const postOptions = postData === undefined
        ? ''
        : ` --post-data=${shellQuote(postData)} --header='Content-Type: application/json'`
    const authOption = authEnv === undefined ? '' : ` \${${authEnv}:+--header="x-api-key: $${authEnv}"}`
    const authHeader = authEnv === undefined ? '' : 'const key=require("fs").readFileSync(0,"utf8");if(key)options.headers["x-api-key"]=key;'
    const authPipe = authEnv === undefined ? '' : `printf %s "$${authEnv}" | `
    const diagnostic = `const url=process.argv[1],body=process.argv[2],options={signal:AbortSignal.timeout(${timeoutSeconds * 1000}),headers:{}};if(body!==undefined){options.method="POST";options.headers["Content-Type"]="application/json";options.body=body}${authHeader}fetch(url,options).then(async response=>{const text=(await response.text()).slice(0,1500);process.stdout.write("health probe failed: HTTP "+response.status+" "+text+"\\n")}).catch(error=>process.stdout.write("health probe failed: "+error.message+"\\n"))`
    const diagnosticArgs = ` ${shellQuote(url)}`
        + (postData === undefined ? '' : ` ${shellQuote(postData)}`)
    return `wget -T ${timeoutSeconds} -qO-${postOptions}${authOption} ${url} || { ${authPipe}node -e ${shellQuote(diagnostic)}${diagnosticArgs}; exit 1; }`
}

module.exports = { healthcheckCommand }
