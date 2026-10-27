// SPDX-License-Identifier: Apache-2.0
// This must be evaluated before storage-bootstrap's static import.
import { isMainThread } from 'node:worker_threads';
import { runUpdaterPreflight } from './updater-preflight';
runUpdaterPreflight({args:process.argv.slice(2),mainThread:isMainThread,env:process.env},{
 write:(message)=>console.error(`\x1b[31merror:\x1b[0m ${message}`),
 terminate:(code)=>process.exit(code),
 continueStartup:()=>{},
});