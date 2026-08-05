"use client";

import { useState, useTransition } from "react";
import { updateWhatsAppConfig } from "@/actions/whatsapp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Copy, Check } from "lucide-react";
import type { WhatsAppConfig } from "@prisma/client";

interface WhatsAppSettingsFormProps {
  config: WhatsAppConfig;
  webhookUrl: string;
  twilioConfigured: boolean;
}

export function WhatsAppSettingsForm({
  config,
  webhookUrl,
  twilioConfigured,
}: WhatsAppSettingsFormProps) {
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
      await updateWhatsAppConfig(formData);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WhatsApp AI Settings</CardTitle>
      </CardHeader>
      <CardContent>
        {!twilioConfigured && (
          <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
            Twilio is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
            and TWILIO_WHATSAPP_NUMBER to your .env file. You can still test with
            the simulator below.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-center justify-between rounded-xl surface-muted p-4">
            <div>
              <p className="font-medium text-sm">Enable WhatsApp AI</p>
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
                Get a WhatsApp message every time a POS sale completes
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

          {saleAlerts && (
            <div className="space-y-2">
              <Label htmlFor="ownerAlertPhone">Send sale alerts to</Label>
              <Input
                id="ownerAlertPhone"
                name="ownerAlertPhone"
                type="tel"
                defaultValue={config.ownerAlertPhone ?? ""}
                placeholder="+234 800 000 0000"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="whatsappNumber">Your shop WhatsApp number</Label>
            <Input
              id="whatsappNumber"
              name="whatsappNumber"
              type="tel"
              defaultValue={config.whatsappNumber ?? ""}
              placeholder="+234 800 000 0000"
            />
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
              Twilio Webhook URL
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
              Paste this in Twilio Console → Messaging → WhatsApp Sandbox →
              &quot;When a message comes in&quot;
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
