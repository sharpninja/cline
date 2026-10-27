// SPDX-License-Identifier: Apache-2.0
/** Test-only descriptor-preserving instrumentation of an existing native member. */
export function captureNativeMember(original, wrapped, emit) {
  const descriptor = Object.getOwnPropertyDescriptor(original, "native");
  if (!descriptor || typeof descriptor.value !== "function") return wrapped;
  const dependency = descriptor.value;
  Object.defineProperty(wrapped, "native", { ...descriptor, value: function (...args) {
    emit({ phase: "call", args });
    let result;
    try { result = Reflect.apply(dependency, this === wrapped ? original : this, args); }
    catch (error) { emit({ phase: "throw", value: error }); throw error; }
    emit({ phase: "return", value: result });
    return result;
  } });
  return wrapped;
}
