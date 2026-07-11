import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type {
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";
import Ajv, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import addFormats from "ajv-formats";

export const TOOL_ARGUMENT_ERROR_PROTOCOL =
  "turnkeyai.tool_argument_error.v1" as const;

const TOOL_SCHEMA_COMPILER = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
addFormats(TOOL_SCHEMA_COMPILER);

export interface ToolArgumentAdmissionDecision {
  executable: LLMToolCall[];
  rejected: ToolResult[];
}

export interface ToolArgumentValidationIssue {
  path: string;
  keyword: string;
  expected: string;
}

export interface ToolArgumentValidator {
  validate(calls: LLMToolCall[]): ToolArgumentAdmissionDecision;
}

export function applyToolArgumentValidationBeforeAdmission(input: {
  calls: LLMToolCall[];
  validator: ToolArgumentValidator;
  admit(calls: LLMToolCall[]): ToolArgumentAdmissionDecision;
}): ToolArgumentAdmissionDecision {
  const validated = input.validator.validate(input.calls);
  const admitted = input.admit(validated.executable);
  return {
    executable: admitted.executable,
    rejected: [...validated.rejected, ...admitted.rejected],
  };
}

export function createToolArgumentValidator(
  definitions: readonly LLMToolDefinition[],
): ToolArgumentValidator {
  const validators = new Map<string, ValidateFunction>();
  for (const definition of definitions) {
    if (validators.has(definition.name)) {
      throw new Error(`Duplicate tool schema: ${definition.name}`);
    }
    // AJV caches compiled validators by schema object. Registry definitions are
    // immutable and reused across runs, so each native schema compiles once per
    // process while each run still gets an exact offered-tool name map.
    validators.set(
      definition.name,
      TOOL_SCHEMA_COMPILER.compile(definition.inputSchema),
    );
  }

  return {
    validate(calls) {
      const executable: LLMToolCall[] = [];
      const rejected: ToolResult[] = [];
      for (const call of calls) {
        const validate = validators.get(call.name);
        if (!validate) {
          rejected.push(
            buildToolArgumentErrorResult(call, "unknown_tool", [
              {
                path: "/",
                keyword: "tool",
                expected: "an offered tool name",
              },
            ]),
          );
          continue;
        }
        if (validate(call.input)) {
          executable.push(call);
          continue;
        }
        rejected.push(
          buildToolArgumentErrorResult(
            call,
            "invalid_tool_arguments",
            (validate.errors ?? []).map(toValidationIssue),
          ),
        );
      }
      return { executable, rejected };
    },
  };
}

function buildToolArgumentErrorResult(
  call: LLMToolCall,
  code: "invalid_tool_arguments" | "unknown_tool",
  issues: ToolArgumentValidationIssue[],
): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    skipped: true,
    content: JSON.stringify({
      protocol: TOOL_ARGUMENT_ERROR_PROTOCOL,
      code,
      tool_name: call.name,
      issues,
      instruction:
        code === "unknown_tool"
          ? "Choose an offered tool and resend the call."
          : "Correct the arguments and resend the call using the tool schema.",
    }),
  };
}

function toValidationIssue(error: ErrorObject): ToolArgumentValidationIssue {
  return {
    path: validationIssuePath(error),
    keyword: error.keyword,
    expected: validationIssueExpectation(error),
  };
}

function validationIssuePath(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missingProperty = String(error.params.missingProperty ?? "");
    return `${error.instancePath}/${escapeJsonPointerToken(missingProperty)}` || "/";
  }
  return error.instancePath || "/";
}

function validationIssueExpectation(error: ErrorObject): string {
  switch (error.keyword) {
    case "type":
      return String(error.params.type ?? "the declared type");
    case "required":
      return "required property";
    case "additionalProperties":
      return "no additional properties";
    case "enum":
      return `one of ${JSON.stringify(error.params.allowedValues ?? [])}`;
    case "minimum":
    case "maximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return `${error.keyword} ${String(error.params.limit ?? "")}`.trim();
    case "format":
      return `format ${String(error.params.format ?? "")}`.trim();
    default:
      return error.keyword;
  }
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
