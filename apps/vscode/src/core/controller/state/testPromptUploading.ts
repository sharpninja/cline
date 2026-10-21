import type { EmptyRequest } from "@shared/proto/cline/common"
import { TestConnectionResult } from "@shared/proto/cline/state"
import { UPLOADS_DISABLED_MESSAGE } from "@/shared/storage/ClineBlobStorage"
import type { Controller } from ".."

/** Report the product policy without attempting to upload a test artifact. */
export async function testPromptUploading(_controller: Controller, _: EmptyRequest): Promise<TestConnectionResult> {
	return TestConnectionResult.create({ success: false, error: UPLOADS_DISABLED_MESSAGE })
}
