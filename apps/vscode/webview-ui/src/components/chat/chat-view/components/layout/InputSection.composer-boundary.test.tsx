// SPDX-License-Identifier: Apache-2.0
// FR-QB-003 AC-QB-069 TEST-QB-069: actual InputSection callback only.
// Native host, later recovery/RPC/audit delivery and AC-QB-005/007/013 remain open.
import { cleanup, render as renderComponent } from "@testing-library/react"
import React from "react"
import { afterAll, afterEach, describe, it, vi } from "vitest"
import { assertComposer, cases, type Factory } from "../../../../../../../src/sdk/vscode-composer-boundary.contract.test-support"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { InputSection } from "./InputSection"

const capture = vi.hoisted(() => ({ onSend: undefined as (() => Promise<void>) | undefined }))
vi.mock("@/context/ExtensionStateContext", () => ({
  useExtensionState: () => ({ turnState: undefined }),
}))
vi.mock("@/components/chat/QuotedMessagePreview", () => ({
  default: () => <div data-testid="synthetic-quote-preview" />,
}))
vi.mock("@/components/chat/ChatTextArea", () => ({
  default: React.forwardRef<HTMLTextAreaElement, { onSend: () => Promise<void> }>((props, ref) => {
    capture.onSend = props.onSend
    return <textarea aria-label="synthetic-composer-child" ref={ref} />
  }),
}))

const actualFactory: Factory = callback => {
  let mounted: ReturnType<typeof renderComponent> | undefined
  return {
    render(input) {
      const chatState = {
        activeQuote: input.quote, setActiveQuote: vi.fn(), isTextAreaFocused: false,
        inputValue: input.text, setInputValue: vi.fn(), sendingDisabled: false,
        selectedImages: input.images, setSelectedImages: vi.fn(),
        selectedFiles: input.files, setSelectedFiles: vi.fn(),
        textAreaRef: { current: null }, handleFocusChange: vi.fn(),
        lastMessage: undefined, pendingResponse: undefined,
      } as unknown as ChatState
      const view = <InputSection
        chatState={chatState}
        messageHandlers={{ handleSendMessage: callback } as unknown as MessageHandlers}
        scrollBehavior={{ isAtBottom: true, scrollToBottomAuto: vi.fn() } as unknown as ScrollBehavior}
        placeholderText="Synthetic task-owned composer"
        selectFilesAndImages={async () => {}}
        shouldDisableFilesAndImages={false}
      />
      if (mounted) mounted.rerender(view)
      else mounted = renderComponent(view)
    },
    submit() {
      if (!capture.onSend) throw new Error("Actual InputSection did not supply its child onSend callback")
      return capture.onSend()
    },
  }
}

const actualHistories: { evidence: Awaited<ReturnType<typeof assertComposer>> }[] = []
afterEach(() => { cleanup(); capture.onSend = undefined })
afterAll(() => console.log("C_COMPOSER_ACTUAL_INTERACTIONS=" + JSON.stringify({
  actualHistories, evidenceLevel: "actual-isolated-InputSection-React-callback",
  childChatTextAreaAndQuotePreviewStubbed: true, extensionStateStubbed: true,
  actualKeyboardOrNativeHost: false, laterRecoveryRpcOrAuditProof: false,
})))

describe("InputSection raw composer callback: SAME independently proven contract", () => {
  for (const scenario of cases) {
    it(scenario.name, async () => {
      try {
        actualHistories.push({ evidence: await assertComposer(scenario, actualFactory) })
      } catch (error) {
        console.log("C_COMPOSER_ACTUAL_FAILURE=" + JSON.stringify({
          name: scenario.name,
          interactionEvidence: (error as { interactionEvidence?: unknown }).interactionEvidence,
        }))
        throw error
      }
    })
  }
})
