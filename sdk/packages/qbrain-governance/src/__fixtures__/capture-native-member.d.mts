import type { Emission, Member } from "./p1-native-member-contract";
/** Test-only fixture declaration; no product export. */
export function captureNativeMember(original: Member, wrapped: Member, emit: (event: Emission) => void): Member;
