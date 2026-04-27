export type ViewName =
  | 'main-menu'
  | 'glasses-topic-list'
  | 'topic-card-study'
  | 'topic-card-study-menu'
  | 'topic-card-read-aloud'
  | 'app-message'
  | 'topic-recording'
  | 'topic-generating-cards';

/** `done` = finished study flow (hidden from study like `hidden`). */
export type LearningCardStatus = 'new-card' | 'read' | 'learned' | 'hidden' | 'done';

export interface LearningCard {
  cardId: string;
  cardTitle: string;
  text: string;
  additionalResearchNeeded: string;
  status: LearningCardStatus;
}

export interface MicroLearningConfig {
  openAiApiKey: string;
  elevenLabsApiKey: string;
}
