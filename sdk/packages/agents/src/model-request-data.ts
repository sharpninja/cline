// SPDX-License-Identifier: Apache-2.0
import type { AgentModelRequest } from "@cline/shared";

/** Detached request data; cancellation is runtime-owned and is never projected by the gate. */
export function cloneModelRequestData(
	request: Omit<AgentModelRequest, "signal">,
): Omit<AgentModelRequest, "signal"> {
	const seen = new Map<object, unknown>();
	function clone(value: unknown): unknown {
		if (value === null || typeof value !== "object") {
			if (typeof value === "function" || typeof value === "symbol")
				throw new Error("Request contains executable data.");
			return value;
		}
		if (seen.has(value)) return seen.get(value);
		if (value instanceof URL) return new URL(value.href);
		if (value instanceof Uint8Array) return new Uint8Array(value);
		if (value instanceof ArrayBuffer) return value.slice(0);
		if (value instanceof Date) return new Date(value.getTime());
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null &&
			!Array.isArray(value)
		)
			throw new Error("Unsupported model request data.");
		const result: Record<string, unknown> | unknown[] = Array.isArray(value)
			? []
			: Object.create(Object.getPrototypeOf(value));
		seen.set(value, result);
		for (const key of Object.keys(value))
			Object.defineProperty(result, key, {
				value: clone((value as Record<string, unknown>)[key]),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		return result;
	}
	if (
		!request ||
		(request.toolExecutionPolicy !== undefined &&
			request.toolExecutionPolicy !== "host-only") ||
		!Array.isArray(request.messages) ||
		!Array.isArray(request.tools) ||
		(request.systemPrompt !== undefined &&
			typeof request.systemPrompt !== "string") ||
		(request.modelTools !== undefined && !Array.isArray(request.modelTools)) ||
		(request.options !== undefined &&
			(!request.options ||
				typeof request.options !== "object" ||
				Array.isArray(request.options)))
	)
		throw new Error("Invalid model request.");
	return clone({
		toolExecutionPolicy: request.toolExecutionPolicy,
		systemPrompt: request.systemPrompt,
		messages: request.messages,
		tools: request.tools,
		modelTools: request.modelTools,
		options: request.options,
	}) as Omit<AgentModelRequest, "signal">;
}
