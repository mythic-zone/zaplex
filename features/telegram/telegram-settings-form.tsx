"use client";

import { useState, useTransition } from "react";
import { updateTelegramConfig } from "@/actions/telegram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Copy, Check } from "lucide-react";
import type { WhatsAppConfig } from "@prisma/client";

interface TelegramSettingsFormProps {
  config: WhatsAppConfig;
  webhookUrl: string;
  telegramConfigured: boolean;
}

export function TelegramSettingsForm({
  config,
  webhookUrl,
  telegramConfigured,
}: TelegramSettingsFormProps) {
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(config.isEnabled);
  const [autoReply, setAutoReply] = useState(config.autoReplyEnabled);
  const [saleAlerts, setSaleAlerts] = useState(config.saleAlertsEnabled);

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.set("isEnabled", String(enabled));
    formData.set("autoReplyEnabled", String(autoReply));
    formData.set("saleAlertsEnabled", String(saleAlerts));
    startTransition(async () => {
      await updateTelegramConfig(formData);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Telegram AI Settings</CardTitle>
      </CardHeader>
      <CardContent>
        {!telegramConfigured && (
          <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
            Telegram bot is not configured. Add TELEGRAM_BOT_TOKEN and
            TELEGRAM_WEBHOOK_SECRET to your .env file. You can still test with
            the simulator below.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-center justify-between rounded-xl surface-muted p-4">
            <div>
              <p className="font-medium text-sm">Enable Telegram AI</p>
              <p className="text-xs text-muted-foreground">
                Auto-reply to customer messages
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`relative h-7 w-12 rounded-full transition-colors ${
                enabled ? "bg-biz-emerald" : "bg-gray-300"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
            <input type="hidden" name="isEnabled" value={String(enabled)} />
          </div>

          <div className="flex items-center justify-between rounded-xl surface-muted p-4">
            <div>
              <p className="font-medium text-sm">Auto-reply</p>
              <p className="text-xs text-muted-foreground">
                AI responds instantly to stock queries
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoReply}
              onClick={() => setAutoReply(!autoReply)}
              className={`relative h-7 w-12 rounded-full transition-colors ${
                autoReply ? "bg-biz-emerald" : "bg-gray-300"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                  autoReply ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-xl surface-muted p-4">
            <div>
              <p className="font-medium text-sm">Sale alerts</p>
              <p className="text-xs text-muted-foreground">
                Get a Telegram message every time a POS sale completes (sent
                to the owner&apos;s linked Telegram ID from Settings → Team)
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={saleAlerts}
              onClick={() => setSaleAlerts(!saleAlerts)}
              className={`relative h-7 w-12 rounded-full transition-colors ${
                saleAlerts ? "bg-biz-emerald" : "bg-gray-300"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                  saleAlerts ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="greetingMessage">Greeting message</Label>
            <textarea
              id="greetingMessage"
              name="greetingMessage"
              defaultValue={config.greetingMessage ?? ""}
              rows={3}
              className="flex w-full rounded-xl border border-input bg-background text-foreground px-4 py-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-biz-blue/30 dark:focus-visible:ring-primary/30"
              placeholder="Hello! Welcome to our shop..."
            />
          </div>

          <div className="rounded-xl bg-biz-blue/5 dark:bg-primary/10 p-4 space-y-3">
            <p className="text-xs font-semibold text-brand uppercase">
              Business Code (multi-shop routing)
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-card border px-3 py-2 text-sm font-mono font-bold">
                {config.businessCode}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copyText(config.businessCode ?? "", "code")}
              >
                {copied === "code" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Customers can message:{" "}
              <strong>
                {config.businessCode}: Do you have Paracetamol?
              </strong>
            </p>
          </div>

          <div className="rounded-xl surface-muted p-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              Telegram Webhook URL
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-card px-3 py-2 text-xs font-mono break-all border">
                {webhookUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copyText(webhookUrl, "webhook")}
              >
                {copied === "webhook" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Registered with Telegram via the bot&apos;s setWebhook call —
              this is shown for reference, not something to paste manually.
            </p>
          </div>

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Save Settings"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
