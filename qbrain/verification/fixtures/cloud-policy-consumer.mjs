// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import * as policy from "@cline/qbrain-governance/cloud-policy"
assert.equal(policy.isClineCloudProvider(" CLINE "), true)
assert.equal(policy.isClineCloudProvider("anthropic"), false)
assert.throws(() => policy.assertDirectProvider("cline"), (error) => error.code === "cline_cloud_disabled")
assert.doesNotThrow(() => policy.assertDirectProvider("anthropic"))
console.log("QB_CLOUD_POLICY_CONSUMER_PASS")
