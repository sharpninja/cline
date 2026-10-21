// SPDX-License-Identifier: Apache-2.0
import type { AgentRuntimeConfig, AgentToolDefinition } from "@cline/shared";

/** Implemented by the verified bundled V2 host; never sourced from optional settings. */
export interface RequiredModelContextSource {
	getRequiredModelContext(): Promise<{
		guidance: string;
		tools: AgentToolDefinition[];
	}>;
}

/** Restore required context and require host-only adapter execution after optional
 * rewriting. Durable lifecycle obligations still belong to the product host. */
export function createRequiredModelGate(
	source: RequiredModelContextSource,
): NonNullable<AgentRuntimeConfig["modelRequestGate"]> {
	const read = source.getRequiredModelContext.bind(source);
	return async ({ request }) => {
		try {
			const context = await read();
			if (
				!context ||
				typeof context.guidance !== "string" ||
				!context.guidance.trim() ||
				!Array.isArray(context.tools) ||
				!context.tools.length
			)
				throw new Error("Invalid context");
			const names = new Set<string>();
			const tools = context.tools.map((tool) => {
				if (
					!tool ||
					typeof tool.name !== "string" ||
					!tool.name.trim() ||
					tool.name !== tool.name.trim() ||
					names.has(tool.name) ||
					typeof tool.description !== "string" ||
					!tool.description.trim() ||
					!tool.inputSchema ||
					typeof tool.inputSchema !== "object" ||
					Array.isArray(tool.inputSchema)
				)
					throw new Error("Invalid tool definition");
				names.add(tool.name);
				return {
					name: tool.name,
					description: tool.description,
					inputSchema: structuredClone(tool.inputSchema),
				};
			});
			return {
				outcome: "allow",
				request: {
					...request,
					toolExecutionPolicy: "host-only",
					systemPrompt: request.systemPrompt
						? `${request.systemPrompt}\n\n${context.guidance}`
						: context.guidance,
					tools: [
						...request.tools.filter((tool) => !names.has(tool.name)),
						...tools,
					],
				},
			};
		} catch {
			// Do not expose bridge responses, credentials, or paths through model diagnostics.
			return {
				outcome: "blocked",
				diagnostic:
					"Required governed model context is unavailable or invalid.",
			};
		}
	};
}
