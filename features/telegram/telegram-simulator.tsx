"use client";

import { useState, useTransition } from "react";
import { simulateInboundMessage, sendTestTelegramMessage } from "@/actions/telegram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Send, FlaskConical } from "lucide-react";

const QUICK_TESTS = [
  "Do you have Paracetamol?",
  "Hello",
  "How much is Coke?",
  "What are your opening hours?",
];

interface TelegramSimulatorProps {
  telegramConfigured: boolean;
}

export function TelegramSimulator({ telegramConfigured }: TelegramSimulatorProps) {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [testChatId, setTestChatId] = useState("");
  const [isPending, startTransition] = useTransition();

  function runSimulation(text: string) {
    setMessage(text);
    setReply(null);
    startTransition(async () => {
      const result = await simulateInboundMessage(text);
      setReply(result.reply);
    });
  }

  function sendLiveTest() {
    if (!testChatId) return;
    startTransition(async () => {
      const result = await sendTestTelegramMessage(testChatId);
      if (result.error) {
        setReply(`Error: ${result.error}`);
      } else {
        setReply("✅ Test message sent to your Telegram chat!");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-biz-emerald" />
          Test Telegram AI
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {QUICK_TESTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => runSimulation(q)}
              disabled={isPending}
              className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/20 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSimulation(message);
          }}
          className="flex gap-2"
        >
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='Try: "Do you have Paracetamol?"'
            disabled={isPending}
          />
          <Button type="submit" disabled={isPending || !message.trim()}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </form>

        {reply && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
            <p className="text-xs font-semibold text-emerald-700 mb-2">
              AI Reply
            </p>
            <p className="text-sm whitespace-pre-wrap">{reply}</p>
          </div>
        )}

        {telegramConfigured && (
          <div className="border-t pt-4 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              Send live test (Telegram)
            </p>
            <div className="flex gap-2">
              <Input
                value={testChatId}
                onChange={(e) => setTestChatId(e.target.value)}
                placeholder="Your Telegram chat ID"
                type="text"
                inputMode="numeric"
              />
              <Button
                type="button"
                variant="outline"
                onClick={sendLiveTest}
                disabled={isPending || !testChatId}
              >
                Send Test
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Message the bot and send /start to get your chat ID first.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
