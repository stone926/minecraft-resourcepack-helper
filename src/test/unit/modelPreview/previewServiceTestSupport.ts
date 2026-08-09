import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewService } from "../../../modelPreview/service/ModelPreviewService";
import { nodeModelPreviewFileSystem } from "../../../modelPreview/service/NodeModelPreviewFileSystem";

export function createService(configuration = {}, fileSystem?: ModelPreviewFileSystem): ModelPreviewService {
  return new ModelPreviewService({
    configuration: () => configuration,
    fileSystem: fileSystem ?? nodeModelPreviewFileSystem
  });
}
