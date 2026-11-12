/** Static tool list used when the hosted server cannot be listed. */
export const STATIC_TOOLS = [
  {
    name: 'list_models',
    description:
      'List models ioi can serve, with context windows and prices. Free. Prices are micro-USD per 1M tokens.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_quote',
    description:
      'Quote the USDC ceiling for a chat or text completion. Free: nothing is signed and the model does not run. Set max_tokens; without it upto assumes 4096 output tokens and exact assumes 512.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model id from list_models, for example deepseek/deepseek-v4.1-flash.',
        },
        messages: {
          type: 'array',
          description: 'Chat messages. Provide messages or prompt.',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
        prompt: { type: 'string', description: 'Text-completion prompt. Provide prompt or messages.' },
        max_tokens: { type: 'integer', minimum: 1 },
      },
      required: ['model'],
      additionalProperties: true,
    },
  },
  {
    name: 'chat',
    description:
      'OpenAI-shaped chat completion. Paid with x402 USDC on Base (upto settles the tokens used, exact pays the whole quote) unless IOI_API_KEY is set. Always set max_tokens. The minimum quote is 0.001 USDC.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        messages: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
        max_tokens: { type: 'integer', minimum: 1 },
        stream: {
          type: 'boolean',
          description: 'Passed through. The tool result is the final completion, not a live stream.',
        },
      },
      required: ['model', 'messages'],
      additionalProperties: true,
    },
  },
  {
    name: 'complete',
    description:
      'OpenAI-shaped text completion. Paid the same way as chat: x402 on Base, or Bearer sk-canary-… when IOI_API_KEY is set.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        prompt: { type: 'string' },
        max_tokens: { type: 'integer', minimum: 1 },
        stream: { type: 'boolean' },
      },
      required: ['model', 'prompt'],
      additionalProperties: true,
    },
  },
] as const;

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } & Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
