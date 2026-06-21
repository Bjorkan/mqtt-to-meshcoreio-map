import assert from "node:assert/strict";
import { test } from "node:test";

const API_ENTRIES = [
  { title: "EU/UK (Narrow)", frequency: "869.618", bandwidth: "62.5", spreading_factor: "8", coding_rate: "8" },
  { title: "Netherlands", frequency: "869.618", bandwidth: "62.5", spreading_factor: "7", coding_rate: "5" },
  { title: "Czech Republic (Narrow)", frequency: "869.432", bandwidth: "62.5", spreading_factor: "7", coding_rate: "5" },
  { title: "Australia", frequency: "915.800", bandwidth: "250", spreading_factor: "10", coding_rate: "5" },
];

test("fetchSuggestedRadioPresets fetches only once; matchPresetTitle resolves correctly", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCount++;
    assert.equal(url, "https://api.meshcore.nz/api/v1/config");
    return {
      ok: true,
      json: async () => ({
        config: { suggested_radio_settings: { entries: API_ENTRIES } },
      }),
    };
  };

  try {
    const mod = await import("../../dist/suggested-radio-presets.js");

    await mod.fetchSuggestedRadioPresets();
    await mod.fetchSuggestedRadioPresets();
    await mod.fetchSuggestedRadioPresets();

    assert.equal(fetchCount, 1, "must hit the network exactly once");

    assert.equal(mod.matchPresetTitle({ freq: 869.618, bw: 62.5, sf: 8 }), "EU/UK (Narrow)");
    assert.equal(mod.matchPresetTitle({ freq: 869.618, bw: 62.5, sf: 7 }), "Netherlands");
    assert.equal(mod.matchPresetTitle({ freq: 869.432, bw: 62.5, sf: 7 }), "Czech Republic (Narrow)");
    assert.equal(mod.matchPresetTitle({ freq: 915.8, bw: 250, sf: 10 }), "Australia");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matchPresetTitle returns undefined when no preset matches", async () => {
  const mod = await import("../../dist/suggested-radio-presets.js");

  assert.equal(mod.matchPresetTitle({ freq: 869.5, bw: 125, sf: 9 }), undefined);
  assert.equal(mod.matchPresetTitle({ freq: 869.618, bw: 125, sf: 8 }), undefined);
  assert.equal(mod.matchPresetTitle({ freq: 869.618, bw: 62.5, sf: 9 }), undefined);
});

test("matchPresetTitle returns undefined for partial or missing radio params", async () => {
  const mod = await import("../../dist/suggested-radio-presets.js");

  assert.equal(mod.matchPresetTitle({}), undefined);
  assert.equal(mod.matchPresetTitle({ freq: 869.618 }), undefined);
  assert.equal(mod.matchPresetTitle({ bw: 62.5 }), undefined);
  assert.equal(mod.matchPresetTitle({ sf: 8 }), undefined);
  assert.equal(mod.matchPresetTitle({ freq: 869.618, bw: 62.5 }), undefined);

});
