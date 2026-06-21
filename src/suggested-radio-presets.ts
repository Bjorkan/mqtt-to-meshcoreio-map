interface RadioPresetEntry {
  title: string;
  frequency: string;
  bandwidth: string;
  spreading_factor: string;
}

interface SuggestedRadioSettings {
  entries: RadioPresetEntry[];
}

interface ConfigResponse {
  config: {
    suggested_radio_settings: SuggestedRadioSettings;
  };
}

let presets: RadioPresetEntry[] | null = null;
let fetchPromise: Promise<void> | null = null;

export async function fetchSuggestedRadioPresets(): Promise<void> {
  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch("https://api.meshcore.nz/api/v1/config");
      if (!response.ok) {
        presets = [];
        return;
      }
      const data = (await response.json()) as ConfigResponse;
      presets = data.config.suggested_radio_settings.entries;
    } catch {
      presets = [];
    }
  })();

  await fetchPromise;
}

export function matchPresetTitle(radioParams: {
  freq?: number;
  bw?: number;
  sf?: number;
}): string | undefined {
  if (!presets || radioParams.freq === undefined || radioParams.bw === undefined || radioParams.sf === undefined) {
    return undefined;
  }

  const freq = Math.round(radioParams.freq * 1000) / 1000;
  const bw = radioParams.bw;
  const sf = radioParams.sf;

  for (const entry of presets) {
    const entryFreq = Math.round(parseFloat(entry.frequency) * 1000) / 1000;
    const entryBw = parseFloat(entry.bandwidth);
    const entrySf = parseInt(entry.spreading_factor, 10);

    if (Math.abs(entryFreq - freq) < 0.001 && Math.abs(entryBw - bw) < 0.01 && entrySf === sf) {
      return entry.title;
    }
  }

  return undefined;
}
