import type { LanguageModel } from 'ai';
import type { IProviderSetting } from '~/types/model';

export interface ModelInfo {
  name: string;
  label: string;
  provider: string;
  isFree?: boolean;

  /** Maximum context window size (input tokens) - how many tokens the model can process */
  maxTokenAllowed: number;

  /** Maximum completion/output tokens - how many tokens the model can generate. If not specified, falls back to provider defaults */
  maxCompletionTokens?: number;
}

export interface ProviderInfo {
  name: string;
  staticModels: ModelInfo[];
  getDynamicModels?: (
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ) => Promise<ModelInfo[]>;
  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModel;
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
  icon?: string;

  /**
   * Whether the model accepts a forced `tool_choice` (`required` or a named tool).
   *
   * Thinking-enabled models reject the request instead of ignoring the hint
   * (DeepSeek V4 answers 400 "Thinking mode does not support this tool_choice"),
   * so callers fall back to `auto` for these models.
   */
  supportsToolChoice?: (model: string) => boolean;

  /**
   * Practical default for `maxOutputTokens`, used when the model's published
   * ceiling is far above what a single response should request.
   */
  getCompletionTokenLimitHint?: () => number;
}
export interface ProviderConfig {
  baseUrlKey?: string;
  baseUrl?: string;
  apiTokenKey?: string;
}
