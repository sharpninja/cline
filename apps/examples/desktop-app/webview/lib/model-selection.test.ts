// @vitest-environment jsdom

import { beforeEach, expect, it } from "vitest";
import {
	EXECUTION_TARGET_STORAGE_KEY,
	readExecutionTargetFromWindow,
	readModelSelectionStorageFromWindow,
	writeExecutionTargetToWindow,
	writeModelSelectionStorageToWindow,
} from "./model-selection";

beforeEach(() => window.localStorage.clear());

it.each([
	"null",
	"[]",
	"{invalid",
	'{"target":"ssh"}',
])("defaults to Local for %s", (raw) => {
	window.localStorage.setItem(EXECUTION_TARGET_STORAGE_KEY, raw);
	expect(readExecutionTargetFromWindow()).toBe("local");
});

it("refuses cloud preferences without replacing the explicit direct selection", () => {
	const local = {
		lastProvider: "openrouter",
		lastModelByProvider: { openrouter: "local-model" },
	};
	const cloud = {
		lastProvider: "cline",
		lastModelByProvider: { cline: "cloud-model" },
	};
	writeModelSelectionStorageToWindow(local);
	expect(() => writeExecutionTargetToWindow("cloud")).toThrow(
		/unavailable in cline-qb/,
	);
	expect(() => writeModelSelectionStorageToWindow(cloud, "cloud")).toThrow(
		/unavailable in cline-qb/,
	);
	expect(readExecutionTargetFromWindow()).toBe("local");
	expect(readModelSelectionStorageFromWindow()).toEqual(local);
	expect(readModelSelectionStorageFromWindow("cloud")).toEqual({
		lastProvider: "",
		lastModelByProvider: {},
	});
	writeExecutionTargetToWindow("local");
	expect(readModelSelectionStorageFromWindow()).toEqual(local);
});
