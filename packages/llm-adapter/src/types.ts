export type ModelProtocol = "openai-compatible" | "anthropic-compatible";

export interface ModelConfigEntry {
  id: string;
  label: string;
  providerId: string;
  protocol: ModelProtocol;
  model: string;
  baseURL: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  aliases?: string[];
  enabled?: boolean;
}

export interface ModelCatalog {
  defaultModelId?: string;
  models: ModelConfigEntry[];
}

export interface ResolvedModelConfig extends ModelConfigEntry {
  apiKey: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  modelId: string;
  messages: LLMMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  envelope?: RequestEnvelopeHint;
}

export interface GenerateTextResult {
  text: string;
  modelId: string;
  providerId: string;
  protocol: ModelProtocol;
  adapterName: string;
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
