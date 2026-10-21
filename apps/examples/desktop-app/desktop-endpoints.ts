// SPDX-License-Identifier: Apache-2.0
/** Desktop defaults are independent of upstream Cline's 3125/3126 listeners. */
export const DESKTOP_WEB_PORT = 32125;
export const DESKTOP_SIDECAR_PORT = 32126;
export const DESKTOP_WS_ENDPOINT = `ws://127.0.0.1:${DESKTOP_SIDECAR_PORT}/transport`;
