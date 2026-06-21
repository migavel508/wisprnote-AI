import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Loads sensitive configuration from AWS Secrets Manager once per container
 * (cached for the life of the warm Lambda) so secrets never live in plaintext
 * environment variables.
 *
 * The secret referenced by API_SECRETS_ID is a JSON document, e.g.
 *   { "DB_PASSWORD": "...", "RESEND_API_KEY": "..." }
 *
 * During a staged rollout the loader falls back to the matching env vars if the
 * Secrets Manager fetch fails, so deploying the code BEFORE the env vars are
 * removed is safe.
 */
export interface ApiSecrets {
  DB_PASSWORD: string;
  RESEND_API_KEY: string;
  // AI provider keys — held server-side so they never ship in the client bundle.
  GEMINI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  // OpenAI (GPT) — DIRECT API key for the agentic chat loop. Empty until provisioned.
  OPENAI_API_KEY: string;
  DEEPGRAM_API_KEY: string;
  OPENROUTER_API_KEY: string;
  TURBOPUFFER_API_KEY: string;
  // Paddle (billing) — server-side secret. Used for Paddle API calls
  // (subscription status, etc.). NEVER ship this in the client bundle.
  PADDLE_API_KEY: string;
  // Paddle webhook signing secret (from the notification destination). Used to
  // verify the Paddle-Signature header on incoming webhooks.
  PADDLE_WEBHOOK_SECRET: string;
  // Sandbox webhook signing secret — lets the same endpoint accept sandbox
  // (dev/test) webhooks alongside live ones. Empty in pure-live deployments.
  PADDLE_SANDBOX_WEBHOOK_SECRET: string;
  // Braintrust (LLM observability) — server-side key. When present, every AI
  // call through the proxy is traced to Braintrust. Empty = tracing disabled
  // (no-op), so the app runs identically with or without it.
  BRAINTRUST_API_KEY: string;
}

const SECRET_ID = process.env.API_SECRETS_ID || 'wisprnote/prod/api';
const region = process.env.AWS_REGION || 'us-east-1';
const client = new SecretsManagerClient({ region });

let cached: Promise<ApiSecrets> | null = null;

export function getSecrets(): Promise<ApiSecrets> {
  if (!cached) {
    cached = (async () => {
      const fallback: ApiSecrets = {
        DB_PASSWORD: process.env.DB_PASSWORD || '',
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
        TURBOPUFFER_API_KEY: process.env.TURBOPUFFER_API_KEY || '',
        PADDLE_API_KEY: process.env.PADDLE_API_KEY || '',
        PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET || '',
        PADDLE_SANDBOX_WEBHOOK_SECRET: process.env.PADDLE_SANDBOX_WEBHOOK_SECRET || '',
        BRAINTRUST_API_KEY: process.env.BRAINTRUST_API_KEY || '',
      };
      try {
        const resp = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
        if (resp.SecretString) {
          const parsed = JSON.parse(resp.SecretString) as Partial<ApiSecrets>;
          return {
            DB_PASSWORD: parsed.DB_PASSWORD || fallback.DB_PASSWORD,
            RESEND_API_KEY: parsed.RESEND_API_KEY || fallback.RESEND_API_KEY,
            GEMINI_API_KEY: parsed.GEMINI_API_KEY || fallback.GEMINI_API_KEY,
            ANTHROPIC_API_KEY: parsed.ANTHROPIC_API_KEY || fallback.ANTHROPIC_API_KEY,
            OPENAI_API_KEY: parsed.OPENAI_API_KEY || fallback.OPENAI_API_KEY,
            DEEPGRAM_API_KEY: parsed.DEEPGRAM_API_KEY || fallback.DEEPGRAM_API_KEY,
            OPENROUTER_API_KEY: parsed.OPENROUTER_API_KEY || fallback.OPENROUTER_API_KEY,
            TURBOPUFFER_API_KEY: parsed.TURBOPUFFER_API_KEY || fallback.TURBOPUFFER_API_KEY,
            PADDLE_API_KEY: parsed.PADDLE_API_KEY || fallback.PADDLE_API_KEY,
            PADDLE_WEBHOOK_SECRET: parsed.PADDLE_WEBHOOK_SECRET || fallback.PADDLE_WEBHOOK_SECRET,
            PADDLE_SANDBOX_WEBHOOK_SECRET: parsed.PADDLE_SANDBOX_WEBHOOK_SECRET || fallback.PADDLE_SANDBOX_WEBHOOK_SECRET,
            BRAINTRUST_API_KEY: parsed.BRAINTRUST_API_KEY || fallback.BRAINTRUST_API_KEY,
          };
        }
      } catch (e) {
        console.error('Secrets Manager load failed, falling back to env vars:', e);
      }
      return fallback;
    })();
  }
  return cached;
}
