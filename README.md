# Micro Learning

Micro Learning is a companion app for Even Realities G2 glasses that turns topics into short study cards, helps you review them quickly on-glasses, and tracks your learning progress over time.

## User Solution

This app is for learners who want to move from "I want to learn this topic" to "I reviewed and learned it" in a repeatable workflow:

- Capture a topic by voice from glasses or type it on phone.
- Generate AI cards automatically.
- Study cards in short sessions and mark card status as you learn.
- Review your learning history, then continue with the next topic.

## Instructions for Use

1. **Set API keys on your phone**
   - Open app settings on the phone and save your OpenAI key (required) and ElevenLabs key (needed for read-aloud and voice features).
2. **Add a new topic**
   - Use **Record new topic for research** on glasses (voice), or type a topic on phone and add it.
   - Keep it short but specific (for example: "TCP congestion control basics" instead of just "networking").
3. **Wait for card generation**
   - The app calls AI services and stores generated cards for that topic.
   - Depending on network speed and API latency, generation may take a short moment.
4. **Read cards and mark them**
   - Open **List of topics** on glasses, choose a topic, then study cards.
   - Use the card menu to mark each card (`read`, `learned`, `done`) and optionally use read-aloud.
5. **Delete topic when learned**
   - After you finish a topic, remove it from the phone topic list to keep the queue clean.
6. **Review learning history and continue**
   - Open **Learning progress** in the main menu to review totals/history, then start the next topic.

## Tech Solution Description

Micro Learning is a phone + glasses workflow connected by Even Hub bridge events and bridge storage.

- **Phone UI (`main.ts`)**
  - Saves API keys and topics.
  - Can add a topic directly (typed input).
  - Manages optional phone audio output selection and playback unlock flow.
- **Glasses UI (`even-client.ts`)**
  - Renders the main menu, topic list, study views, and card action menus.
  - Handles gesture-driven navigation (click/double-click) and session state.
- **Topic-to-cards pipeline (`topic-pipeline.ts`)**
  - Validates topic/config, optionally appends topic to stored list, then generates and stores cards.
- **AI integrations**
  - **OpenAI**: topic -> generated learning cards.
  - **ElevenLabs**: speech-to-text for voice topic capture and text-to-speech for read-aloud.
- **Persistence**
  - Uses `EvenAppBridge` local storage APIs (`getLocalStorage` / `setLocalStorage`) for app data.

## Technical Documentation

### Prerequisites

- Node.js and npm
- Even Realities app environment with bridge support
- OpenAI API key (required for card generation)
- ElevenLabs API key (recommended for voice/read-aloud features)

### Install and Run

```bash
npm install
npm run dev
npm run qr
```

- `npm run dev`: starts Vite dev server.
- `npm run qr`: generates an Even Hub QR flow for loading the app.

### Build and Package

```bash
npm run build
npm run pack:check
npm run pack
```

- `npm run build`: production build and build metadata bump.
- `npm run pack:check`: validates package inputs.
- `npm run pack`: emits `micro-learning.ehpk`.

### App Permissions and Manifest Notes

Defined in `app.json`:

- `network` permission for OpenAI and ElevenLabs calls.
- `g2-microphone` permission for glasses voice recording flow.
- `min_app_version`: `2.0.0`
- `min_sdk_version`: `0.0.7`

### Data Storage Keys (Bridge Storage)

Core keys written via bridge storage:

- `micro-learning:openai-key`
- `micro-learning:elevenlabs-key`
- `micro-learning:topics`
- `micro-learning:learning-progress-daily`
- `micro-learning:learning-progress` (legacy)
- `micro-learning:learning-score` (legacy)
- `micro-learning:theme`
- `micro-learning:phone-audio-output-id`
- `micro-learning:phone-audio-input-id`
- `micro-learning:topic-cards:<base64url(topic)>`

### Source Modules

- `src/main.ts`
  - Phone-side bootstrapping, settings/topics dashboard, bridge connection lifecycle.
- `src/even-client.ts`
  - Glasses UI rendering, menu/topic/card flows, gesture handling, read-aloud flow.
- `src/topic-pipeline.ts`
  - Topic intake and AI card generation orchestration.
- `src/stt-elevenlabs.ts`
  - G2 audio capture + ElevenLabs speech-to-text integration.
- `src/api.ts`
  - OpenAI responses call for cards and ElevenLabs TTS API call.
- `src/utils.ts`
  - Bridge storage helpers, config/topics/progress/card persistence utilities.
- `src/phone-audio.ts`
  - Shared playback audio element and output routing helpers.

### Runtime Workflow Summary

1. User sets keys and topic(s) from phone or records from glasses.
2. App generates cards via OpenAI and saves them to bridge storage.
3. User studies cards on glasses and updates card status.
4. Progress is aggregated and shown in learning history view.

### TO-DO

1. Fix numbers on card count - when card is hidden the index goes up but the total count goes down
2. Add a line in the card menu - 'Create a sub-topic from this card...' - a Yes/No dialog for new topic creation from this card content
