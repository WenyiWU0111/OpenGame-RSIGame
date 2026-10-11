import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';

/**
 * Default provider for standard OpenAI-compatible APIs
 */
export class DefaultOpenAICompatibleProvider implements OpenAICompatibleProvider {
  protected contentGeneratorConfig: ContentGeneratorConfig;
  protected cliConfig: Config;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.cliConfig = cliConfig;
    this.contentGeneratorConfig = contentGeneratorConfig;
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    return {
      'User-Agent': userAgent,
    };
  }

  buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
    });
  }

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    // Default provider doesn't need special enhancements, just pass through all parameters
    return {
      ...request, // Preserve all original parameters including sampling params
    };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    // No default top_p: some models (e.g. gpt-5.5-class reasoning models)
    // reject the `top_p` sampling parameter outright (400 unsupported_parameter).
    // Only send it if explicitly configured elsewhere.
    //
    // Generous default max output tokens: reasoning models spend a large,
    // variable chunk of the completion budget on hidden reasoning_content
    // before emitting visible text/tool_calls. Without an explicit cap here,
    // some gateways fall back to a small default, so a reasoning-heavy turn
    // hits finish_reason=length with empty visible content and no tool call
    // (surfaces as "Model stream ended with empty response text.").
    return {
      maxOutputTokens: 32000,
    };
  }
}
