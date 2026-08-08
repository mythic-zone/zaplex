import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),
  CLERK_SECRET_KEY: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const publicEnvSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function validateServerEnv(): {
  valid: boolean;
  missing: string[];
} {
  const required = ["DATABASE_URL", "CLERK_SECRET_KEY"] as const;
  const missing = required.filter((key) => !process.env[key]);
  return { valid: missing.length === 0, missing: [...missing] };
}

export function getServerEnv(): ServerEnv {
  return serverEnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NODE_ENV: process.env.NODE_ENV,
  });
}

export function getPublicEnv() {
  return publicEnvSchema.safeParse({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}

/**
 * Netlify already provides full URLs including the scheme, where Vercel gives
 * bare hostnames — so these are kept apart rather than blindly prefixed with
 * https://, which would produce https://https://… on Netlify.
 */
function netlifyUrl(): string | undefined {
  // URL is the production address; DEPLOY_PRIME_URL is the branch or preview.
  const value = process.env.URL ?? process.env.DEPLOY_PRIME_URL;
  return value?.startsWith("http") ? value.replace(/\/$/, "") : undefined;
}

export function getAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const deploymentHost = process.env.VERCEL_URL;

  const isLocalConfigured =
    configured?.includes("localhost") || configured?.includes("127.0.0.1");

  // Prefer explicit production URL when it is not a local dev value.
  if (configured && !isLocalConfigured) {
    return configured;
  }

  // Then whichever host we are actually running on.
  const fromNetlify = netlifyUrl();
  if (fromNetlify) {
    return fromNetlify;
  }

  if (productionHost) {
    return `https://${productionHost}`;
  }

  if (deploymentHost) {
    return `https://${deploymentHost}`;
  }

  if (configured) {
    return configured;
  }

  return "http://localhost:3000";
}

export const PRODUCTION_ENV_CHECKLIST = [
  { key: "DATABASE_URL", required: true, service: "Supabase" },
  { key: "DIRECT_URL", required: true, service: "Supabase migrations" },
  { key: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", required: true, service: "Clerk" },
  { key: "CLERK_SECRET_KEY", required: true, service: "Clerk" },
  { key: "NEXT_PUBLIC_APP_URL", required: true, service: "Vercel" },
  { key: "GEMINI_API_KEY", required: false, service: "Google Gemini (free AI)" },
  { key: "TRIAL_AI_DAILY_LIMIT", required: false, service: "Trial AI messages per day (default 25)" },
  { key: "TRIAL_AI_HOURLY_LIMIT", required: false, service: "Trial AI messages per hour (default 8)" },
  { key: "PAID_STARTER_AI_DAILY_LIMIT", required: false, service: "Starter plan AI messages per day (default 60)" },
  { key: "PAID_STARTER_AI_HOURLY_LIMIT", required: false, service: "Starter plan AI messages per hour (default 15)" },
  { key: "PAID_BUSINESS_AI_DAILY_LIMIT", required: false, service: "Business plan AI messages per day (default 200)" },
  { key: "PAID_BUSINESS_AI_HOURLY_LIMIT", required: false, service: "Business plan AI messages per hour (default 50)" },
  { key: "PAID_AI_PRO_AI_DAILY_LIMIT", required: false, service: "AI Pro plan AI messages per day (default 500)" },
  { key: "PAID_AI_PRO_AI_HOURLY_LIMIT", required: false, service: "AI Pro plan AI messages per hour (default 120)" },
  { key: "OPENAI_API_KEY", required: false, service: "OpenAI (optional fallback)" },
  { key: "FLUTTERWAVE_SECRET_KEY", required: false, service: "Flutterwave" },
  { key: "NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY", required: false, service: "Flutterwave" },
  { key: "FLUTTERWAVE_SECRET_HASH", required: false, service: "Flutterwave webhooks" },
  { key: "TELEGRAM_BOT_TOKEN", required: false, service: "Telegram" },
  { key: "TELEGRAM_WEBHOOK_SECRET", required: false, service: "Telegram webhook validation" },
  { key: "NEXT_PUBLIC_SUPABASE_URL", required: false, service: "Supabase Storage" },
  { key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", required: false, service: "Supabase Storage" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", required: false, service: "Product image uploads" },
  { key: "NEXT_PUBLIC_POSTHOG_KEY", required: false, service: "PostHog" },
  { key: "HEALTH_CHECK_SECRET", required: false, service: "Detailed /api/health responses" },
  { key: "INTERNAL_ADMIN_EMAILS", required: false, service: "Internal Ops console bootstrap" },
  { key: "NEXT_PUBLIC_SENTRY_DSN", required: false, service: "Sentry (client)" },
  { key: "SENTRY_DSN", required: false, service: "Sentry (server)" },
  { key: "RUN_PRISMA_MIGRATE", required: false, service: "Auto-apply DB migrations on deploy" },
] as const;
