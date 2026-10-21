// SPDX-License-Identifier: Apache-2.0
const assert = require("node:assert/strict")
const policy = require("@cline/qbrain-governance/cloud-policy")
assert.equal(policy.isClineCloudProvider(" CLINE "), true)
assert.equal(policy.isClineCloudProvider("anthropic"), false)
assert.throws(() => policy.assertDirectProvider("cline"), (error) => error.code === "cline_cloud_disabled")
assert.doesNotThrow(() => policy.assertDirectProvider("anthropic"))
console.log("QB_CLOUD_POLICY_CONSUMER_PASS")
