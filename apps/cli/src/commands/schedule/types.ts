export interface CommandIo {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
}

export type ScheduleActionWrapper = <T extends unknown[]>(
	fn: (...args: T) => Promise<void>,
) => (...args: T) => Promise<void>;

// Internal app-host seam. Omitted by generic callers; no SDK protocol change.
export interface ScheduleAdmission {
  resolve(raw: unknown): Promise<{ provider: string; model: string }>;
}
