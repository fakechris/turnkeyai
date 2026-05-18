export type ModelProtocol = "openai-compatible" | "anthropic-compatible";
export type ModelApiType = "openai" | "anthropic";

export interface ModelConfigEntry {
  id: string;
  label: string;
  providerId: string;
  protocol: ModelProtocol;
  model: string;
  baseURL?: string;
  baseURLEnv?: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  aliases?: string[];
  enabled?: boolean;
}

export interface ModelChainEntry {
  id: string;
  primary: string;
  fallbacks?: string[];
  aliases?: string[];
  enabled?: boolean;
}

export interface NamedModelConfigEntry extends Omit<ModelConfigEntry, "id" | "protocol"> {
  id?: string;
  protocol?: ModelProtocol;
  apiType?: ModelApiType | ModelProtocol;
}

export interface NamedModelChainEntry extends Omit<ModelChainEntry, "id"> {
  id?: string;
}

export interface ModelCatalog {
  defaultModelId?: string;
  defaultModelChainId?: string;
  models: ModelConfigEntry[] | Record<string, NamedModelConfigEntry>;
  modelChains?: ModelChainEntry[] | Record<string, NamedModelChainEntry>;
}

export interface ResolvedModelConfig extends Omit<ModelConfigEntry, "baseURL"> {
  baseURL: string;
  apiKey: string;
}

export interface ModelSelection {
  chainId?: string;
  primaryModelId: string;
  fallbackModelIds: string[];
}

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock;

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LLMContentBlock[];
  /** Provider-neutral link from a tool result message to the model's tool call. */
  toolCallId?: string;
  /** Optional tool/function name for OpenAI-compatible tool messages. */
  name?: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LLMToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      name: string;
    };

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RequestEnvelopeHint {
  artifactIds?: string[];
  toolCount?: number;
  toolSchemaBytes?: number;
  toolResultCount?: number;
  toolResultBytes?: number;
  inlineAttachmentBytes?: number;
  inlineImageCount?: number;
  inlineImageBytes?: number;
  inlinePdfCount?: number;
  inlinePdfBytes?: number;
  multimodalPartCount?: number;
}

export interface RequestEnvelopeDiagnostics {
  messageCount: number;
  promptChars: number;
  promptBytes: number;
  metadataBytes: number;
  artifactCount: number;
  toolCount: number;
  toolSchemaBytes: number;
  toolResultCount: number;
  toolResultBytes: number;
  inlineAttachmentBytes: number;
  inlineImageCount: number;
  inlineImageBytes: number;
  inlinePdfCount: number;
  inlinePdfBytes: number;
  multimodalPartCount: number;
  totalSerializedBytes: number;
  overLimitKeys: Array<
    | "messageCount"
    | "promptChars"
    | "promptBytes"
    | "metadataBytes"
    | "artifactCount"
    | "toolCount"
    | "toolSchemaBytes"
    | "toolResultCount"
    | "toolResultBytes"
    | "inlineAttachmentBytes"
    | "inlineImageCount"
    | "inlineImageBytes"
    | "inlinePdfCount"
    | "inlinePdfBytes"
    | "multimodalPartCount"
    | "totalSerializedBytes"
  >;
}

export interface GenerateTextInput {
  modelId?: string;
  modelChainId?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  toolChoice?: LLMToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  envelope?: RequestEnvelopeHint;
}

export interface GenerateTextResult {
  text: string;
  contentBlocks?: LLMContentBlock[];
  toolCalls?: LLMToolCall[];
  modelId: string;
  modelChainId?: string;
  providerId: string;
  protocol: ModelProtocol;
  adapterName: string;
  attemptedModelIds?: string[];
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  requestEnvelope?: RequestEnvelopeDiagnostics;
  raw: unknown;
}

export interface ProtocolClient {
  supports(protocol: ModelProtocol): boolean;
  generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult>;
}

export interface ModelCatalogSource {
  load(): Promise<ModelCatalog>;
}
