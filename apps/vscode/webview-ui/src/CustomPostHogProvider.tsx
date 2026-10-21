import type { ReactNode } from "react"

/** Compatibility wrapper: cline-qb never loads a browser telemetry client. */
export function CustomPostHogProvider({ children }: { children: ReactNode }) {
	return <>{children}</>
}
