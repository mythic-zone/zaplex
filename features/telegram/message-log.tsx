"use client";

import { formatRelativeDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageCircle, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { WhatsAppMessage } from "@prisma/client";
import { cn } from "@/lib/utils";

interface MessageLogProps {
  messages: WhatsAppMessage[];
}

export function MessageLog({ messages }: MessageLogProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-brand" />
          Recent Messages
        </CardTitle>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No messages yet. Enable Telegram AI and customers can start asking
            about products.
          </p>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "rounded-xl p-3 text-sm",
                  msg.direction === "INBOUND"
                    ? "surface-muted border border-border/50"
                    : "bg-biz-blue/5 dark:bg-primary/10 border border-biz-blue/10 dark:border-primary/20"
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    {msg.direction === "INBOUND" ? (
                      <>
                        <ArrowDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground">Customer</span>
                      </>
                    ) : (
                      <>
                        <ArrowUpRight className="h-3.5 w-3.5 text-biz-emerald" />
                        <span className="text-biz-emerald">AI Reply</span>
                      </>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeDate(msg.createdAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{msg.body}</p>
                {msg.customerPhone && msg.customerPhone !== "simulator" && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {msg.customerPhone}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
