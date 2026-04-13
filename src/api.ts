import { appendEventLog } from './utils';
import type { LearningCard } from './types';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const TOPIC_CARDS_PROMPT_ID = 'pmpt_69da1decea7481908e47eb9cf665fbcd0c2b0f351f7d27d9';
const TOPIC_CARDS_PROMPT_VERSION = '3';
const MAX_CARDS = 20;

type ResponsesApiJson = {
  output?: unknown[];
  output_text?: string;
  [key: string]: unknown;
};

function extractOutputText(data: ResponsesApiJson): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const parts: string[] = [];
  const out = data.output;
  if (!Array.isArray(out)) return '';

  for (const item of out) {
    if (item == null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const content = o.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const t = b.type;
      const text = b.text;
      if (typeof text === 'string' && (t === 'output_text' || t === 'text')) {
        parts.push(text);
      }
    }
    if (typeof o.text === 'string') {
      parts.push(o.text);
    }
  }
  return parts.join('\n').trim();
}

function parseCardsFromModelText(raw: string): Omit<LearningCard, 'status'>[] {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(s);
  if (fence) s = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(s.slice(start, end + 1));
      } catch {
        appendEventLog('[OpenAI] Could not parse cards JSON from model output.');
        throw new Error('Model did not return valid JSON array of cards.');
      }
    } else {
      appendEventLog('[OpenAI] Could not parse cards JSON from model output.');
      throw new Error('Model did not return valid JSON array of cards.');
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of learning cards.');
  }

  const cards: Omit<LearningCard, 'status'>[] = [];
  for (let i = 0; i < parsed.length && cards.length < MAX_CARDS; i += 1) {
    const row = parsed[i];
    if (row == null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const cardId = String(r.cardId ?? r.card_id ?? `card-${i}`);
    const cardTitle = String(r.cardTitle ?? r.card_title ?? 'Card');
    const text = String(r.text ?? '');
    const additionalResearchNeeded = Boolean(r.additionalResearchNeeded ?? r.additional_research_needed);
    if (!text.trim()) continue;
    cards.push({ cardId, cardTitle, text, additionalResearchNeeded });
  }
  return cards;
}

/**
 * Calls OpenAI Responses API with the configured prompt; expects a JSON array of card objects.
 */
export async function generateLearningCardsFromTopic(apiKey: string, topic: string): Promise<LearningCard[]> {
  const trimmed = topic.trim();
  if (!trimmed) {
    throw new Error('Topic is empty');
  }
  if (!apiKey.trim()) {
    throw new Error('OpenAI API key missing');
  }

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      prompt: {
        id: TOPIC_CARDS_PROMPT_ID,
        version: TOPIC_CARDS_PROMPT_VERSION,
      },
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: trimmed }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    appendEventLog(`OpenAI responses error ${res.status}: ${errText.slice(0, 400)}`);
    throw new Error(`OpenAI error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as ResponsesApiJson;
  const outputText = extractOutputText(data);
  if (!outputText) {
    appendEventLog('[OpenAI] Empty output from responses API.');
    throw new Error('OpenAI returned no text output');
  }

  const base = parseCardsFromModelText(outputText);
  return base.map((c) => ({ ...c, status: 'new-card' as const }));
}

const ELEVENLABS_DEFAULT_VOICE_ID = 'rWArYo7a2NWuBYf5BE4V';

export async function synthesizeSpeech(elevenLabsApiKey: string, text: string): Promise<ArrayBuffer> {
  if (!elevenLabsApiKey.trim()) {
    throw new Error('ElevenLabs API key not configured');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Text to speak is empty');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': elevenLabsApiKey.trim(),
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: trimmed.slice(0, 8000),
      model_id: 'eleven_multilingual_v2',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    appendEventLog(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 400)}`);
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 200)}`);
  }

  return res.arrayBuffer();
}
