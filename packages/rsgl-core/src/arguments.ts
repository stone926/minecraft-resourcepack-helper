import {
  ArgumentNode,
  RsglDiagnostic,
  RsglNode,
  TextRange
} from "./parser";

export interface RsglCallableParameter {
  name: string;
  optional?: boolean;
  /** Positional-only rest segment. Only builtin signatures may declare one. */
  rest?: true;
  node?: RsglNode;
}

export interface RsglArgumentSlotAssignment<
  TParameter extends RsglCallableParameter,
  TArgument
> {
  parameter: TParameter;
  parameterIndex: number;
  arg: TArgument;
  duplicate: boolean;
}

export type RsglArgumentAssignment<TParameter extends RsglCallableParameter> =
  RsglArgumentSlotAssignment<TParameter, ArgumentNode>;

export type RsglArgumentSlotIssue<
  TParameter extends RsglCallableParameter,
  TArgument
> =
  | { kind: "duplicate"; name: string; arg: TArgument }
  | { kind: "tooMany"; arg: TArgument }
  | { kind: "unknown"; name: string; arg: TArgument }
  | { kind: "namedRest"; name: string; arg: TArgument }
  | { kind: "missing"; parameter: TParameter; parameterIndex: number };

export interface RsglArgumentSlotBinding<
  TParameter extends RsglCallableParameter,
  TArgument
> {
  assignments: Array<RsglArgumentSlotAssignment<TParameter, TArgument>>;
  primaryAssignments: Array<RsglArgumentSlotAssignment<TParameter, TArgument>>;
  restAssignments: Array<RsglArgumentSlotAssignment<TParameter, TArgument>>;
  unmatchedArgs: TArgument[];
  missingParameters: TParameter[];
  issues: Array<RsglArgumentSlotIssue<TParameter, TArgument>>;
}

export interface RsglArgumentBinding<TParameter extends RsglCallableParameter> {
  assignments: Array<RsglArgumentAssignment<TParameter>>;
  primaryAssignments: Array<RsglArgumentAssignment<TParameter>>;
  restAssignments: Array<RsglArgumentAssignment<TParameter>>;
  unmatchedArgs: ArgumentNode[];
  missingParameters: TParameter[];
  diagnostics: RsglDiagnostic[];
}

export interface RsglArgumentBindingOptions<TParameter extends RsglCallableParameter> {
  callRange?: TextRange;
  codes?: Partial<Record<"duplicate" | "missing" | "tooMany" | "unknown" | "namedRest", string>>;
  messages?: Partial<{
    duplicate: (name: string) => string;
    missing: (parameter: TParameter) => string;
    tooMany: () => string;
    unknown: (name: string) => string;
    namedRest: (name: string) => string;
  }>;
  missingRange?: (parameter: TParameter, index: number) => TextRange;
}

export function bindRsglArguments<TParameter extends RsglCallableParameter>(
  parameters: TParameter[],
  args: ArgumentNode[],
  options: RsglArgumentBindingOptions<TParameter> = {}
): RsglArgumentBinding<TParameter> {
  const binding = bindRsglArgumentSlots(parameters, args, arg => arg.name?.text);
  const diagnostics = binding.issues.map(issue => {
    if (issue.kind === "missing") {
      return diagnostic(
        options.codes?.missing ?? "rsgl.missingArgument",
        options.messages?.missing?.(issue.parameter)
          ?? `Missing argument '${issue.parameter.name}'.`,
        options.missingRange?.(issue.parameter, issue.parameterIndex)
          ?? options.callRange
          ?? issue.parameter.node?.range
          ?? { start: 0, end: 1 }
      );
    }
    const nameRange = "name" in issue
      ? issue.arg.name?.range ?? issue.arg.range
      : issue.arg.range;
    if (issue.kind === "duplicate") {
      return diagnostic(
        options.codes?.duplicate ?? "rsgl.duplicateArgument",
        options.messages?.duplicate?.(issue.name) ?? `Duplicate argument '${issue.name}'.`,
        nameRange
      );
    }
    if (issue.kind === "unknown") {
      return diagnostic(
        options.codes?.unknown ?? "rsgl.unknownArgument",
        options.messages?.unknown?.(issue.name) ?? `Unknown argument '${issue.name}'.`,
        nameRange
      );
    }
    if (issue.kind === "namedRest") {
      return diagnostic(
        options.codes?.namedRest ?? "rsgl.namedRestArgumentNotSupported",
        options.messages?.namedRest?.(issue.name)
          ?? `Rest parameter '${issue.name}' accepts positional arguments only.`,
        nameRange
      );
    }
    return diagnostic(
      options.codes?.tooMany ?? "rsgl.tooManyArguments",
      options.messages?.tooMany?.() ?? "Too many positional arguments.",
      issue.arg.range
    );
  });
  return {
    assignments: binding.assignments,
    primaryAssignments: binding.primaryAssignments,
    restAssignments: binding.restAssignments,
    unmatchedArgs: binding.unmatchedArgs,
    missingParameters: binding.missingParameters,
    diagnostics
  };
}

/**
 * Protocol-neutral argument slot binder shared by semantic AST calls and the
 * evaluator's already-evaluated arguments. Diagnostics remain the caller's
 * responsibility so runtime code does not need parser nodes or source ranges.
 */
export function bindRsglArgumentSlots<
  TParameter extends RsglCallableParameter,
  TArgument
>(
  parameters: readonly TParameter[],
  args: readonly TArgument[],
  nameOf: (arg: TArgument) => string | undefined
): RsglArgumentSlotBinding<TParameter, TArgument> {
  const restParameters = parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(entry => entry.parameter.rest);
  if (restParameters.length > 1 || (restParameters[0] && restParameters[0].index !== parameters.length - 1)) {
    throw new Error("RSGL rest parameter must be unique and appear last.");
  }
  const restEntry = restParameters[0];
  const issues: Array<RsglArgumentSlotIssue<TParameter, TArgument>> = [];
  const assignments: Array<RsglArgumentSlotAssignment<TParameter, TArgument>> = [];
  const unmatchedArgs: TArgument[] = [];
  const parameterByName = new Map(parameters.map((parameter, index) => [parameter.name, { parameter, index }]));
  const primaryByName = new Map<string, RsglArgumentSlotAssignment<TParameter, TArgument>>();

  args
    .filter(arg => nameOf(arg) === undefined)
    .forEach((arg, index) => {
      const parameterIndex = restEntry && index >= restEntry.index ? restEntry.index : index;
      const parameter = parameters[parameterIndex];
      if (!parameter) {
        unmatchedArgs.push(arg);
        issues.push({ kind: "tooMany", arg });
        return;
      }

      const assignment: RsglArgumentSlotAssignment<TParameter, TArgument> = {
        parameter,
        parameterIndex,
        arg,
        duplicate: false
      };
      assignments.push(assignment);
      if (!primaryByName.has(parameter.name)) {
        primaryByName.set(parameter.name, assignment);
      }
    });

  const seenNamedArgs = new Map<string, TArgument>();
  for (const arg of args.filter(arg => nameOf(arg) !== undefined)) {
    const name = nameOf(arg)!;
    const previousNamedArg = seenNamedArgs.get(name);
    const parameterEntry = parameterByName.get(name);

    if (previousNamedArg) {
      issues.push({ kind: "duplicate", name, arg });
    } else {
      seenNamedArgs.set(name, arg);
    }

    if (!parameterEntry) {
      unmatchedArgs.push(arg);
      if (!previousNamedArg) {
        issues.push({ kind: "unknown", name, arg });
      }
      continue;
    }

    if (parameterEntry.parameter.rest) {
      unmatchedArgs.push(arg);
      if (!previousNamedArg) {
        issues.push({ kind: "namedRest", name, arg });
      }
      continue;
    }

    const duplicate = Boolean(previousNamedArg || primaryByName.has(name));
    if (!previousNamedArg && primaryByName.has(name)) {
      issues.push({ kind: "duplicate", name, arg });
    }

    const assignment: RsglArgumentSlotAssignment<TParameter, TArgument> = {
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
    if (primaryByName.has(parameter.name) || parameter.optional || parameter.rest) {
      return;
    }
    missingParameters.push(parameter);
    issues.push({ kind: "missing", parameter, parameterIndex: index });
  });

  const argumentOrder = new Map<TArgument, number>();
  args.forEach((arg, index) => {
    if (!argumentOrder.has(arg)) {
      argumentOrder.set(arg, index);
    }
  });
  const orderOf = (arg: TArgument): number => argumentOrder.get(arg) ?? Number.MAX_SAFE_INTEGER;
  assignments.sort((left, right) => orderOf(left.arg) - orderOf(right.arg));
  unmatchedArgs.sort((left, right) => orderOf(left) - orderOf(right));
  issues.sort((left, right) => {
    const leftOrder = left.kind === "missing" ? Number.MAX_SAFE_INTEGER : orderOf(left.arg);
    const rightOrder = right.kind === "missing" ? Number.MAX_SAFE_INTEGER : orderOf(right.arg);
    return leftOrder - rightOrder;
  });

  return {
    assignments,
    primaryAssignments: parameters
      .map(parameter => primaryByName.get(parameter.name))
      .filter((assignment): assignment is RsglArgumentSlotAssignment<TParameter, TArgument> => Boolean(assignment)),
    restAssignments: assignments.filter(assignment => assignment.parameter.rest),
    unmatchedArgs,
    missingParameters,
    issues
  };
}

function diagnostic(code: string, message: string, range: TextRange): RsglDiagnostic {
  return { code, message, range, severity: "error" };
}
