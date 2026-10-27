# P1 host interaction test candidate

These files are test-only. No shipped application imports the model. They do not consume candidate S, P or K implementation code.

`host-contract.ts` defines the common operation input, observer contract and assertions for Mock and later Production adapters. `host-model.ts` receives only operation inputs and scripted dependency replies. It never receives a scenario, expected result or test name. Its own storage namespace, provider calls, persisted request/result records, open turns and deliveries are checked separately from the ordered interaction trace.

`host-contract.test.ts` declares host routes and requirement-derived expected interactions. Correct dependency responses execute through the same runner as altered responses. Missing, wrong and reordered callbacks, substituted provider results, foreign audit identities, denied completion and incorrectly accepted alternative flows must be rejected. Every planned control is required to reject. The original passing proof and later strengthened proof remain in C's private receipt directory.

The standalone small proof runs with Bun and `--mock-proof`; the normal CLI Vitest discovery includes this `.test.ts` file. Full package checks use the existing package scripts after O prepares dependencies. The observer boundary names are test instrumentation, not approved plugin wire APIs.

The 29 host route labels specify intended production adapter entrypoints. They do not establish that those application sources currently call the adapter. Model effect records are synthetic, not evidence of a real provider request, HTTP interception, filesystem crash durability, daemon handshake or installed application launch. The full P1 coverage report explicitly lists remaining assertions and source binding work; no AC is claimed satisfied.

Production binding is held until C/acceptance-release.json pins exact accepted merged S/P/K commits and artifacts and O releases the specific independent mock deficiency. Reuse these inputs, assertions and interaction/state observations when adding that adapter. Do not implement another lifecycle, transport or read service. Full suites, real Windows task evidence, exact server fidelity, scope review and cumulative P1 gates remain required.
