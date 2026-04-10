export interface AzureFoundryOptions {
  /**
   * The endpoint URL copied from the Azure AI Foundry portal ("Target URI").
   *
   * Claude (Anthropic SDK) example:
   *   https://my-resource.services.ai.azure.com/models
   *
   * DeepSeek (OpenAI SDK) example:
   *   https://my-resource.services.ai.azure.com/api/projects/my-project
   *
   * Pass the Target URI exactly as shown in the portal.
   * The SDK you use appends its own path suffix (e.g. /v1/messages or /chat/completions).
   */
  endpoint: string
  /**
   * The Azure AI API key ("Project API Key") from the Foundry portal.
   * Azure requires this as an `api-key` header, not `x-api-key` or `Authorization: Bearer`.
   */
  apiKey: string
}

export interface AzureFoundryClientConfig {
  baseURL: string
  apiKey: string
  defaultHeaders: { 'api-key': string }
}

/**
 * Returns an SDK constructor config object for an Azure AI Foundry endpoint.
 *
 * Azure AI Foundry expects an `api-key` header. The Anthropic SDK sends
 * `x-api-key` by default, and the OpenAI SDK sends `Authorization: Bearer`
 * — both cause a 401. This function returns a plain config object
 * `{ baseURL, apiKey, defaultHeaders }` that can be spread into either
 * `new Anthropic({...})` or `new OpenAI({...})` to fix the header.
 *
 * @example Anthropic SDK (Claude models)
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk'
 * import { buildAzureFoundryClientConfig } from '@conducco/titw'
 *
 * const client = new Anthropic(buildAzureFoundryClientConfig({
 *   endpoint: process.env.AZURE_AI_ENDPOINT!,
 *   apiKey:   process.env.AZURE_AI_API_KEY!,
 * }))
 * ```
 *
 * @example OpenAI SDK (DeepSeek and other OpenAI-compatible models)
 * ```ts
 * import OpenAI from 'openai'
 * import { buildAzureFoundryClientConfig } from '@conducco/titw'
 *
 * const client = new OpenAI(buildAzureFoundryClientConfig({
 *   endpoint: process.env.AZURE_AI_DEEPSEEK_ENDPOINT!,
 *   apiKey:   process.env.AZURE_AI_DEEPSEEK_KEY!,
 * }))
 * ```
 */
export function buildAzureFoundryClientConfig(
  options: AzureFoundryOptions,
): AzureFoundryClientConfig {
  const baseURL = options.endpoint.replace(/\/+$/, '')
  return {
    baseURL,
    apiKey: options.apiKey,   // SDK requires a non-empty value; Azure ignores it (api-key header takes precedence)
    defaultHeaders: { 'api-key': options.apiKey },
  }
}
