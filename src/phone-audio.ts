/** Playback sink for `HTMLAudioElement`. Empty = OS default. */
export const PHONE_AUDIO_OUTPUT_KEY = 'micro-learning:phone-audio-output-id';

/** Reserved for future phone-mic use. */
export const PHONE_AUDIO_INPUT_KEY = 'micro-learning:phone-audio-input-id';

let sharedPlaybackAudio: HTMLAudioElement | null = null;
let sharedPlaybackBlobUrl: string | null = null;

let phonePlaybackPrimedThisSession = false;

export function hasPhonePlaybackPrimedThisSession(): boolean {
  return phonePlaybackPrimedThisSession;
}

function silentWavDataUri(): string {
  const numChannels = 1;
  const sampleRate = 8000;
  const bitsPerSample = 8;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const numSamples = 96;
  const dataBytes = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buffer);
  let o = 0;
  const wr = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
    o += s.length;
  };
  wr('RIFF');
  dv.setUint32(o, 36 + dataBytes, true);
  o += 4;
  wr('WAVE');
  wr('fmt ');
  dv.setUint32(o, 16, true);
  o += 4;
  dv.setUint16(o, 1, true);
  o += 2;
  dv.setUint16(o, numChannels, true);
  o += 2;
  dv.setUint32(o, sampleRate, true);
  o += 4;
  dv.setUint32(o, byteRate, true);
  o += 4;
  dv.setUint16(o, blockAlign, true);
  o += 2;
  dv.setUint16(o, bitsPerSample, true);
  o += 2;
  wr('data');
  dv.setUint32(o, dataBytes, true);
  o += 4;
  for (let i = 0; i < numSamples; i += 1) {
    dv.setUint8(o, 128);
    o += 1;
  }
  const u8 = new Uint8Array(buffer);
  let binary = '';
  u8.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const SILENT_WAV_DATA_URI = silentWavDataUri();

export function phoneAudioOutputSupportsSink(): boolean {
  return (
    typeof HTMLAudioElement !== 'undefined' &&
    'setSinkId' in HTMLAudioElement.prototype &&
    typeof (HTMLAudioElement.prototype as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      .setSinkId === 'function'
  );
}

export function applyPhoneAudioOutput(audio: HTMLAudioElement): void {
  const id = localStorage.getItem(PHONE_AUDIO_OUTPUT_KEY)?.trim();
  if (!id) return;
  const el = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
  if (typeof el.setSinkId !== 'function') return;
  void el.setSinkId(id).catch(() => {});
}

export function getSharedPlaybackAudio(): HTMLAudioElement {
  if (!sharedPlaybackAudio) {
    sharedPlaybackAudio = new Audio();
    sharedPlaybackAudio.preload = 'auto';
    sharedPlaybackAudio.setAttribute('playsinline', 'true');
    sharedPlaybackAudio.setAttribute('webkit-playsinline', 'true');
    applyPhoneAudioOutput(sharedPlaybackAudio);
  }
  return sharedPlaybackAudio;
}

export function revokeSharedPlaybackBlobUrl(): void {
  if (sharedPlaybackBlobUrl) {
    URL.revokeObjectURL(sharedPlaybackBlobUrl);
    sharedPlaybackBlobUrl = null;
  }
}

export async function primeSharedPlaybackAudioFromUserGesture(): Promise<boolean> {
  const a = getSharedPlaybackAudio();
  applyPhoneAudioOutput(a);
  try {
    revokeSharedPlaybackBlobUrl();
    a.pause();
    a.volume = 0.05;
    a.src = SILENT_WAV_DATA_URI;
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.volume = 1;
    phonePlaybackPrimedThisSession = true;
    return true;
  } catch {
    a.volume = 1;
    return false;
  }
}
