import { generateLearningCardsFromTopic } from './api';
import {
  loadConfigFromLocalStorage,
  loadTopicsFromLocalStorage,
  saveLearningCardsForTopic,
  saveTopicsToLocalStorage,
} from './utils';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type IntroduceTopicMode = 'phone-add' | 'glasses-voice';

/**
 * Adds topic to the list when missing, runs OpenAI prompt, saves cards (with status) to storage.
 * - phone-add: skip entirely if topic already in list (no duplicate list entries, no API).
 * - glasses-voice: add if missing; always run API (refresh cards for existing topic).
 */
export async function introduceTopicWithCards(
  bridge: EvenAppBridge | null,
  topic: string,
  mode: IntroduceTopicMode,
): Promise<{ addedToList: boolean; cardCount: number }> {
  const trimmed = topic.trim();
  if (!trimmed) {
    throw new Error('Topic is empty');
  }

  const cfg = await loadConfigFromLocalStorage(bridge);
  if (!cfg.openAiApiKey.trim()) {
    throw new Error('OpenAI API key missing — set it in Settings on the phone.');
  }

  let topics = await loadTopicsFromLocalStorage(bridge);
  const alreadyListed = topics.includes(trimmed);

  if (mode === 'phone-add' && alreadyListed) {
    return { addedToList: false, cardCount: 0 };
  }

  let addedToList = false;
  if (!alreadyListed) {
    topics = [...topics, trimmed];
    await saveTopicsToLocalStorage(bridge, topics);
    addedToList = true;
  }

  const cards = await generateLearningCardsFromTopic(cfg.openAiApiKey, trimmed);
  await saveLearningCardsForTopic(bridge, trimmed, cards);

  return { addedToList, cardCount: cards.length };
}
