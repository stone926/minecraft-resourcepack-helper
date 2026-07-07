import type { ModelPreviewFileSystem } from "../../../modelPreview/model/ModelDocument";
import { ModelPreviewService } from "../../../modelPreview/service/ModelPreviewService";

export function createService(configuration = {}, fileSystem?: ModelPreviewFileSystem): ModelPreviewService {
  return new ModelPreviewService({
    configuration: () => configuration,
    fileSystem
  });
}
