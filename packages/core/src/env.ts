import { env } from "cloudflare:workers";

export type ServerEnv = {
  PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
  DISCORD_WEBHOOK_URL?: string;
  ALERT_DAYS_THRESHOLD?: string;
  DB?: D1Database;
};

export function getServerEnv(): ServerEnv {
  return env as ServerEnv;
}
