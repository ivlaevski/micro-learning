import { appendEventLog } from './utils';
import type { LearningCard } from './types';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_CARDS = 19;
const TOPIC_CARDS_INSTRUCTIONS = `Provide structured, factual information about the given topic in the form of information cards presented as a JSON array. Each card must focus on a single, specific aspect or key area of knowledge related to the topic, be clearly and concisely titled, contain only verified or publicly available facts, and must not exceed 1900 characters in its "text" field. Create up to 19 cards, or fewer if the topic does not have enough unique aspects to warrant more. For each card, the "additionalResearchNeeded" value must be a related sub-topic or dimension that someone should learn more about, and it must explicitly reference the original topic to ensure that the connection is clear even if the context or topic changes later.

Before producing your JSON output, carefully:
- Identify all broad and significant categories of the topic.
- Organise information so each card covers a distinct, non-overlapping area.
- Ensure all content is factual and well-organised, covering from general overview to more specific details.
- Make sure no card contains opinions, speculative statements, or redundant facts.
- Assign each card a unique "cardId" (start from 1), a clear "cardTitle", a concise and fact-only "text", and a relevant "additionalResearchNeeded" sub-topic. The "additionalResearchNeeded" field must mention the original topic (e.g., "Comparison of solar energy to other renewables" or "Solar energy policy developments in the EU") to allow users to reference the knowledge, even if the topic changes in subsequent stages.

Do not include any introductory, summarizing, or commentary text. Do not return code blocks, markdown formatting, or headings. Your output should be a valid JSON array only.

# Output Format
Output a single JSON array. Each element is an object with the following properties:
- "cardId": [integer] The sequential number of the card, starting at 1.
- "cardTitle": [string] Concise, descriptive title for the card's topic.
- "text": [string] Factual, clearly written content about that subtopic (maximum 1900 characters).
- "additionalResearchNeeded": [string] A concise sub-topic or aspect that relates to this card and explicitly includes the original topic in its phrasing.

The full response must be a single JSON array (not nested or split), containing all generated cards in logical order from general to specific.

# Steps
1. Identify all broad to specific areas about the topic that merit their own information card.
2. Organize and verify facts for each card to ensure clarity and accuracy.
3. Write each card's "cardTitle" and "text". For "additionalResearchNeeded", determine a logical sub-topic or aspect directly related to each card and ensure it references the original topic explicitly.
4. Construct the JSON array as specified above.

# Notes
- "additionalResearchNeeded" must always mention or reference the original topic explicitly.
- Each card should remain clear and factual; do not include opinions, summaries, or speculative statements.
- "cardTitle" should be concise and specific.
- Do not include markdown, headings, or code blocks-output ONLY the pure JSON array.
- Cards must be numbered sequentially and in logical topic order.
- No extra or wrap-around text should appear outside the JSON array.

Reminder: Output ONLY a JSON array of cards, each with "cardId", "cardTitle", "text", and "additionalResearchNeeded". Structure and fact-organise internally before generating your final JSON array.`;

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
    const additionalResearchNeeded = String(r.additionalResearchNeeded ?? r.additional_research_needed ?? '');
    if (!text.trim()) continue;
    cards.push({ cardId, cardTitle, text, additionalResearchNeeded });
  }
  return cards;
}

/**
 * Calls OpenAI Responses API with inline instructions; expects a JSON array of card objects.
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
      instructions: TOPIC_CARDS_INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: `Topic: ${trimmed}` }],
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
