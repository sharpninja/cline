// @jsxImportSource @opentui/react
import { describeOutdatedHubSessions } from "@cline/shared";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useDialogPalette } from "../../hooks/use-theme";
import { resolveHubUpdateRequiredKeyAction } from "./hub-update-required-helpers";

export interface HubUpdateRequiredDetails {
	hubCoreVersion?: string;
}

/** An incompatible hub requires a matching reviewed product build. */
export function HubUpdateRequiredContent(
	props: ChoiceContext<boolean> & HubUpdateRequiredDetails,
) {
	const { dialogId, dismiss, hubCoreVersion } = props;
	const palette = useDialogPalette();
	useDialogKeyboard((key) => {
		if (resolveHubUpdateRequiredKeyAction(key) !== "ignore") dismiss();
	}, dialogId);
	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text fg="yellow">Incompatible hub protocol</text>
			<text selectable>
				This CLI cannot connect to the running hub
				{hubCoreVersion ? " (core " + hubCoreVersion + ")" : ""}.
			</text>
			<text selectable>
				Install a matching reviewed cline-qb build and restart. Upstream Cline
				updates are disabled.
			</text>
			<text fg={palette.muted}>Press Enter or Esc to dismiss</text>
		</box>
	);
}
export interface HubOutdatedDetails {
	hubCoreVersion?: string;
	activeSessionCount?: number;
	participantClientCount?: number;
}

/**
 * Shown when this CLI is the newer build and the shared Hub was left running
 * an older one because it is still serving other clients' sessions. Enter
 * replaces the Hub now (interrupting that work); Esc keeps it running.
 */
export function HubOutdatedContent(
	props: ChoiceContext<boolean> & HubOutdatedDetails,
) {
	const {
		activeSessionCount,
		dialogId,
		dismiss,
		participantClientCount,
		resolve,
	} = props;
	const palette = useDialogPalette();

	useDialogKeyboard((key) => {
		const action = resolveHubUpdateRequiredKeyAction(key);
		if (action === "ignore") return;
		if (action === "update") {
			resolve(true);
			return;
		}
		dismiss();
	}, dialogId);

	return (
		<box flexDirection="column" paddingX={1} gap={1}>
			<text fg="yellow">Cline Hub update required</text>
			<box flexDirection="column">
				<text selectable>
					This CLI needs a newer Cline Hub, but the running one is still serving{" "}
					{describeOutdatedHubSessions({
						activeSessionCount,
						participantClientCount,
					})}
					.
				</text>
				<text selectable>
					Updating stops that Hub and interrupts its sessions.
				</text>
			</box>
			<box flexDirection="row">
				<box paddingX={1} backgroundColor={palette.act}>
					<text fg={palette.textOnSelection}>Update Now</text>
				</box>
			</box>
			<text fg={palette.muted}>
				Press Enter to update now, Esc to keep the Hub running
			</text>
		</box>
	);
}
