import qbrainBuildDefines from "../../../qbrain-build-defines.json" with {
	type: "json",
};

/** cline-qb builds erase prohibited configuration regardless of build environment. */
export function telemetryDefineArgs(
	_env?: Record<string, string | undefined>,
): string[] {
	return Object.entries(qbrainBuildDefines).flatMap(([name, value]) => [
		"--define",
		`${name}=${value}`,
	]);
}
