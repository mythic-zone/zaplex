export type GeminiChatMessage = {
  role: "user" | "model";
  parts: { text: string }[];
};

export function resolveGeminiApiKey(): string | undefined {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export async function geminiGenerateText(params: {
  systemPrompt: string;
  contents: GeminiChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<string | null> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) return null;

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: params.systemPrompt }],
        },
        contents: params.contents,
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens ?? 800,
          temperature: params.temperature ?? 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Gemini API error:", response.status, errorText.slice(0, 500));
    return null;
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  return text || null;
}

/**
 * Multimodal Gemini call: one inline image or audio clip plus a text prompt.
 * Gemini 2.0 Flash accepts both image/* and audio/* inlineData natively, so
 * this single function covers invoice-photo OCR and voice-note understanding
 * — no separate OCR or speech-to-text service is needed.
 */
export async function geminiAnalyzeMedia(params: {
  systemPrompt: string;
  prompt: string;
  mediaBase64: string;
  mimeType: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<string | null> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) return null;

  const model = geminiModel();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: params.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: params.mimeType, data: params.mediaBase64 } },
              { text: params.prompt },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens ?? 1500,
          temperature: params.temperature ?? 0.2,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("Gemini media API error:", response.status, errorText.slice(0, 500));
    return null;
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  return text || null;
}

export function isGeminiConfigured(): boolean {
  return Boolean(resolveGeminiApiKey());
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
}
