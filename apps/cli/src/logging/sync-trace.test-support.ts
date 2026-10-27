// Test-only synchronous boundary tracing. No function outcomes are substituted.
export type TraceEvent = { operation: string; phase: "before" | "after" | "error"; errorCode?: string };
export function createSynchronousTrace(emit: (event: TraceEvent) => void) {
 const failures: unknown[] = [];
 const record = (event: TraceEvent) => { try { emit(event); } catch (error) { failures.push(error); } };
 function wrap<T extends (...args: never[]) => unknown>(operation: string, original: T): T {
  return function(this: unknown, ...args: Parameters<T>) {
   record({ operation, phase: "before" });
   try {
    const result = Reflect.apply(original, this, args) as ReturnType<T>;
    record({ operation, phase: "after" });
    return result;
   } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    record({ operation, phase: "error", ...(typeof code === "string" ? { errorCode: code } : {}) });
    throw error;
   }
  } as T;
 }
 return { wrap, failures };
}
