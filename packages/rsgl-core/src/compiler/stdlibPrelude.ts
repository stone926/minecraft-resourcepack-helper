import { bindRsglProgram } from "../semantic";
import { createRsglStdlibPreludeSourceFiles } from "../stdlib";
import { rsglPathKey } from "../pathIdentity";
import {
  resolveRsglCompileConfiguration,
  type ResolvedRsglCompileConfiguration
} from "./compileConfiguration";
import {
  createProgramCompileEnvironments,
  type RsglTemplateDefinition
} from "./environment";

/** Builds the compiler-facing template prelude from internal stdlib sources. */
export function createRsglStdlibPreludeTemplates(
  stdlibRoot?: string,
  configuration: ResolvedRsglCompileConfiguration = resolveRsglCompileConfiguration()
): RsglTemplateDefinition[] {
  const files = createRsglStdlibPreludeSourceFiles({ stdlibRoot });
  if (files.length === 0) {
    return [];
  }

  const program = bindRsglProgram(files, { stdlibRoot });
  const environments = createProgramCompileEnvironments(program, configuration);
  return program.models.flatMap(model =>
    Array.from(environments.get(rsglPathKey(model.fileName))?.exportedTemplates.values() ?? [])
  );
}
