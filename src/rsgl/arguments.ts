import {
  ArgumentNode,
  RsglDiagnostic,
  RsglNode,
  TextRange
} from "./parser";

export interface RsglCallableParameter {
  name: string;
  optional?: boolean;
  node?: RsglNode;
}

export interface RsglArgumentAssignment<TParameter extends RsglCallableParameter> {
  parameter: TParameter;
  parameterIndex: number;
  arg: ArgumentNode;
  duplicate: boolean;
}

export interface RsglArgumentBinding<TParameter extends RsglCallableParameter> {
  assignments: Array<RsglArgumentAssignment<TParameter>>;
  primaryAssignments: Array<RsglArgumentAssignment<TParameter>>;
  unmatchedArgs: ArgumentNode[];
  missingParameters: TParameter[];
  diagnostics: RsglDiagnostic[];
}

export interface RsglArgumentBindingOptions<TParameter extends RsglCallableParameter> {
  callRange?: TextRange;
  codes?: Partial<Record<"duplicate" | "missing" | "tooMany" | "unknown", string>>;
  messages?: Partial<{
    duplicate: (name: string) => string;
    missing: (parameter: TParameter) => string;
    tooMany: () => string;
    unknown: (name: string) => string;
  }>;
  missingRange?: (parameter: TParameter, index: number) => TextRange;
}

export function bindRsglArguments<TParameter extends RsglCallableParameter>(
  parameters: TParameter[],
  args: ArgumentNode[],
  options: RsglArgumentBindingOptions<TParameter> = {}
): RsglArgumentBinding<TParameter> {
  const diagnostics: RsglDiagnostic[] = [];
  const assignments: Array<RsglArgumentAssignment<TParameter>> = [];
  const unmatchedArgs: ArgumentNode[] = [];
  const parameterByName = new Map(parameters.map((parameter, index) => [parameter.name, { parameter, index }]));
  const primaryByName = new Map<string, RsglArgumentAssignment<TParameter>>();

  args
    .filter(arg => !arg.name)
    .forEach((arg, index) => {
      const parameter = parameters[index];
      if (!parameter) {
        unmatchedArgs.push(arg);
        diagnostics.push(diagnostic(
          options.codes?.tooMany ?? "rsgl.tooManyArguments",
          options.messages?.tooMany?.() ?? "Too many positional arguments.",
          arg.range
        ));
        return;
      }

      const assignment: RsglArgumentAssignment<TParameter> = {
        parameter,
        parameterIndex: index,
        arg,
        duplicate: false
      };
      assignments.push(assignment);
      primaryByName.set(parameter.name, assignment);
    });

  const seenNamedArgs = new Map<string, ArgumentNode>();
  for (const arg of args.filter(arg => arg.name)) {
    const name = arg.name!.text;
    const previousNamedArg = seenNamedArgs.get(name);
    const parameterEntry = parameterByName.get(name);

    if (previousNamedArg) {
      diagnostics.push(diagnostic(
        options.codes?.duplicate ?? "rsgl.duplicateArgument",
        options.messages?.duplicate?.(name) ?? `Duplicate argument '${name}'.`,
        arg.name!.range
      ));
    } else {
      seenNamedArgs.set(name, arg);
    }

    if (!parameterEntry) {
      unmatchedArgs.push(arg);
      if (!previousNamedArg) {
        diagnostics.push(diagnostic(
          options.codes?.unknown ?? "rsgl.unknownArgument",
          options.messages?.unknown?.(name) ?? `Unknown argument '${name}'.`,
          arg.name!.range
        ));
      }
      continue;
    }

    const duplicate = Boolean(previousNamedArg || primaryByName.has(name));
    if (!previousNamedArg && primaryByName.has(name)) {
      diagnostics.push(diagnostic(
        options.codes?.duplicate ?? "rsgl.duplicateArgument",
        options.messages?.duplicate?.(name) ?? `Duplicate argument '${name}'.`,
        arg.name!.range
      ));
    }

    const assignment: RsglArgumentAssignment<TParameter> = {
      parameter: parameterEntry.parameter,
      parameterIndex: parameterEntry.index,
      arg,
      duplicate
    };
    assignments.push(assignment);
    if (!previousNamedArg) {
      primaryByName.set(name, assignment);
    }
  }

  const missingParameters: TParameter[] = [];
  parameters.forEach((parameter, index) => {
    if (primaryByName.has(parameter.name) || parameter.optional) {
      return;
    }
    missingParameters.push(parameter);
    diagnostics.push(diagnostic(
      options.codes?.missing ?? "rsgl.missingArgument",
      options.messages?.missing?.(parameter) ?? `Missing argument '${parameter.name}'.`,
      options.missingRange?.(parameter, index) ?? options.callRange ?? parameter.node?.range ?? { start: 0, end: 1 }
    ));
  });

  return {
    assignments,
    primaryAssignments: parameters
      .map(parameter => primaryByName.get(parameter.name))
      .filter((assignment): assignment is RsglArgumentAssignment<TParameter> => Boolean(assignment)),
    unmatchedArgs,
    missingParameters,
    diagnostics
  };
}

function diagnostic(code: string, message: string, range: TextRange): RsglDiagnostic {
  return { code, message, range, severity: "error" };
}
