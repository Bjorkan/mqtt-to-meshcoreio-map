import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createMapUploadSigningIdentity,
  MeshcoreMapUploader,
} from "../../src/map-uploader.ts";
import {
  API_URL,
  FIFTH_ADVERT_SEED,
  FOURTH_ADVERT_SEED,
  OBSERVER_ID,
  advertTypes,
  captureConsoleLog,
  captureConsoleOutput,
  hex,
  makeAdvertPacket,
  makeConfig,
  makeFetch,
  makeUploaderDependencies,
  rememberDefaultStatus,
  signedRequestData,
  statusPayload,
} from "./helpers.mjs";

test("uploads verified packets.raw adverts with firmware radio parameters", async () => {
  const { fetch, requests } = makeFetch();
  const signingIdentity = createMapUploadSigningIdentity();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch, signingIdentity }),
  );
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        type: "PACKET",
        raw: hex(packet),
      }),
    ),
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, API_URL);
  assert.equal(requests[0].init.headers["content-type"], "application/json");

  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.publicKey, hex(signingIdentity.publicKey));
  assert.match(requestBody.signature, /^[0-9a-f]{128}$/);

  const data = signedRequestData(requests);
  assert.deepEqual(data.params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
  assert.deepEqual(data.links, [`meshcore://${hex(packet)}`]);
});

test("does not upload or log a duplicate advert while the first copy is in flight", async () => {
  let releaseFetch;
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch: async () => {
        await new Promise((resolve) => {
          releaseFetch = resolve;
        });
        return {
          ok: true,
          status: 200,
          text: async () => '{"code":"NODES_INSERTED"}',
        };
      },
    }),
  );
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({ timestamp: 1_800_091_000 });
  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) })),
  );

  await new Promise((resolve) => setImmediate(resolve));
  const logs = await captureConsoleLog(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
      ),
    );
  });

  releaseFetch();
  await first;

  assert.deepEqual(logs, []);
});

test("does not log successful observer status updates as map uploads", async () => {
  const { fetch } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );

  const logs = await captureConsoleLog(async () => {
    await rememberDefaultStatus(uploader);
  });

  assert.deepEqual(logs, []);
});

test("uploads verified raw.data adverts with human readable radio parameters", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/status",
    statusPayload({ radio: "869.617981 MHz · SF8 · BW62.5 · CR8" }),
  );

  const packet = makeAdvertPacket({ timestamp: 1_800_003_700 });
  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        type: "RAW",
        data: hex(packet),
      }),
    ),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    sf: 8,
    bw: 62.5,
    cr: 8,
  });
});

test("normalizes direct frequency fields from MHz, kHz, and Hz", async () => {
  for (const [freq, expected] of [
    [869.617981, 869.618],
    [869617.981, 869.618],
    [869617981, 869.618],
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/status",
      statusPayload({
        radio: undefined,
        params: { freq, bw: 62500, sf: 8, cr: 8 },
      }),
    );

    const packet = makeAdvertPacket({
      timestamp: 1_800_010_000 + Math.floor(freq),
    });
    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
      ),
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).params, {
      freq: expected,
      bw: 62.5,
      sf: 8,
      cr: 8,
    });
  }
});

test("normalizes comma radio strings from Hz and Hz bandwidth", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/status",
    statusPayload({ radio: "869617981,62500,8,8" }),
  );

  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_011_000 })),
      }),
    ),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test("uses 64-hex observer id from standard, meshrank, and custom topics when payload omits origin_id", async () => {
  for (const topic of [
    `meshcore/STO/${OBSERVER_ID}/raw`,
    `meshrank/uplink/token/${OBSERVER_ID}/packets`,
    `mynetwork/raw/${OBSERVER_ID}`,
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await uploader.processMqttMessage(
      `mynetwork/status/${OBSERVER_ID}`,
      statusPayload({ origin_id: undefined }),
    );

    const packet = makeAdvertPacket({
      timestamp: 1_800_030_000 + requests.length + topic.length,
    });
    await uploader.processMqttMessage(
      topic,
      Buffer.from(JSON.stringify({ data: hex(packet), raw: hex(packet) })),
    );

    assert.equal(requests.length, 1);
  }
});

test("normalizes uppercase observer origin_id and topic ids", async () => {
  const upperObserverId = OBSERVER_ID.toUpperCase();
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${upperObserverId}/status`,
    statusPayload({ origin_id: upperObserverId }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${upperObserverId}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: upperObserverId,
        data: hex(makeAdvertPacket({ timestamp: 1_800_031_000 })),
      }),
    ),
  );

  assert.equal(requests.length, 1);
});

test("skips custom topic packets without payload origin_id or 64-hex topic id", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    "mynetwork/raw/not-a-public-key",
    Buffer.from(JSON.stringify({ data: hex(packet) })),
  );

  assert.equal(requests.length, 0);
});

test("keeps the latest valid radio params when a later complete status is invalid", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: "869.617981,62.5,8,8" }),
  );
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: "1001000000,62.5,8,8" }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_050_000 })),
      }),
    ),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test("keeps previous valid radio params when later status is offline or incomplete", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    Buffer.from(JSON.stringify({ status: "offline", origin_id: OBSERVER_ID })),
  );

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) })),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test("replaces previous observer radio params when a newer valid status arrives", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );

  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: "868.100,125,7,5" }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_065_000 })),
      }),
    ),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 868.1,
    bw: 125,
    sf: 7,
    cr: 5,
  });
});

test("drops observer radio status after 24 hours without a new valid status", async () => {
  const { fetch, requests } = makeFetch();
  let now = 1_000_000;
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch,
      now: () => now,
    }),
  );

  await rememberDefaultStatus(uploader);
  now += 24 * 60 * 60 * 1000 + 1;

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    Buffer.from(JSON.stringify({ status: "offline", origin_id: OBSERVER_ID })),
  );
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_070_000 })),
      }),
    ),
  );

  assert.equal(requests.length, 0);
});

test("prefers packet raw over data and raw topic data over raw field", async () => {
  const packet = makeAdvertPacket({ timestamp: 1_800_060_000 });
  const junkPacket = makeAdvertPacket({
    timestamp: 1_800_063_700,
    type: advertTypes.chat,
  });

  {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(
        JSON.stringify({
          origin_id: OBSERVER_ID,
          data: hex(junkPacket),
          raw: hex(packet),
        }),
      ),
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).links, [
      `meshcore://${hex(packet)}`,
    ]);
  }

  {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(
        JSON.stringify({
          origin_id: OBSERVER_ID,
          data: hex(packet),
          raw: hex(junkPacket),
        }),
      ),
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).links, [
      `meshcore://${hex(packet)}`,
    ]);
  }
});

test("skips adverts when radio params are complete but outside sane ranges", async () => {
  for (const radio of [
    "1,62.5,8,8",
    "869.617981,0,8,8",
    "869.617981,62.5,99,8",
    "869.617981,62.5,8,99",
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/status`,
      statusPayload({ radio }),
    );

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(
        JSON.stringify({
          origin_id: OBSERVER_ID,
          data: hex(
            makeAdvertPacket({ timestamp: 1_800_040_000 + radio.length }),
          ),
        }),
      ),
    );

    assert.equal(requests.length, 0);
  }
});

test("deduplicates the same advert when raw and packets arrive together", async () => {
  let releaseFetch;
  const requests = [];
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch: async (url, init) => {
        requests.push({ url, init });
        await new Promise((resolve) => {
          releaseFetch = resolve;
        });
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
    }),
  );
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  const first = uploader.processMqttMessage(
    "meshcore/STO/observer-key/packets",
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) })),
  );
  const second = uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) })),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  releaseFetch();
  await Promise.all([first, second]);
});

test("does not let an invalid in-flight copy suppress a later valid copy", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await rememberDefaultStatus(uploader);

  const invalid = makeAdvertPacket({ tamperSignature: true });
  const valid = makeAdvertPacket({});
  await Promise.all([
    uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(invalid) }),
      ),
    ),
    uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(valid) })),
    ),
  ]);

  assert.equal(requests.length, 1);
});

test("dry-run processes five adverts end to end without posting invalid or valid adverts", async () => {
  const requests = [];
  const uploader = new MeshcoreMapUploader(
    makeConfig({
      dryRun: true,
    }),
    makeUploaderDependencies({
      fetch: async (url, init) => {
        requests.push({ url, init });
        throw new Error("dry-run should not call fetch");
      },
    }),
  );
  await rememberDefaultStatus(uploader);

  const adverts = [
    makeAdvertPacket({ timestamp: 1_800_600_000, name: "SE-STO-DRY-1" }),
    makeAdvertPacket({
      seed: FOURTH_ADVERT_SEED,
      timestamp: 1_800_603_700,
      name: "SE-STO-DRY-2",
      type: advertTypes.sensor,
    }),
    makeAdvertPacket({
      seed: FIFTH_ADVERT_SEED,
      timestamp: 1_800_607_400,
      name: "SE-STO-BAD-CHAT",
      type: advertTypes.chat,
    }),
    makeAdvertPacket({
      seed: Buffer.from("27".repeat(32), "hex"),
      timestamp: 1_800_611_100,
      name: "SE-STO-BAD-NONE",
      type: advertTypes.none,
    }),
    makeAdvertPacket({
      seed: Buffer.from("28".repeat(32), "hex"),
      timestamp: 1_800_614_800,
      name: "SE-STO-BAD-SIG",
      tamperSignature: true,
    }),
  ];

  const logs = await captureConsoleOutput(async () => {
    for (const packet of adverts) {
      await uploader.processMqttMessage(
        `meshcore/STO/${OBSERVER_ID}/raw`,
        Buffer.from(
          JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
        ),
      );
    }
  });

  assert.equal(requests.length, 0);
  assert.equal(
    logs.filter((line) => /Dry run: would send advert/.test(line)).length,
    2,
  );
  assert.equal(logs.filter((line) => /Dropping\./.test(line)).length, 0);
});

test("skips adverts until observer radio parameters are complete", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  const packet = makeAdvertPacket({});

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
      ),
    );
  });

  assert.equal(requests.length, 0);
  assert.deepEqual(logs, []);
});

test("skips chat, none, and invalid-signature adverts silently", async () => {
  for (const packet of [
    makeAdvertPacket({ type: advertTypes.chat }),
    makeAdvertPacket({ type: advertTypes.none }),
    makeAdvertPacket({ tamperSignature: true }),
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await rememberDefaultStatus(uploader);

    const logs = await captureConsoleOutput(async () => {
      await uploader.processMqttMessage(
        "meshcore/STO/observer-key/raw",
        Buffer.from(
          JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
        ),
      );
    });

    assert.equal(requests.length, 0);
    assert.deepEqual(logs, []);
  }
});

test("uploads repeater, room, and sensor adverts only", async () => {
  for (const type of [
    advertTypes.repeater,
    advertTypes.room,
    advertTypes.sensor,
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(
      makeConfig(),
      makeUploaderDependencies({ fetch }),
    );
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(
        JSON.stringify({
          origin_id: OBSERVER_ID,
          data: hex(
            makeAdvertPacket({ type, timestamp: 1_800_020_000 + type }),
          ),
        }),
      ),
    );

    assert.equal(requests.length, 1);
  }
});

test("applies replay, reupload interval, and queued upload retry", async () => {
  const { fetch, requests } = makeFetch();
  let now = 10_000;
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch,
      now: () => now,
    }),
  );
  await rememberDefaultStatus(uploader);

  const first = makeAdvertPacket({ timestamp: 1_800_000_000 });
  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(first) })),
  );
  let logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(first) })),
    );
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(logs, []);

  const tooSoon = makeAdvertPacket({ timestamp: 1_800_000_100 });
  logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(tooSoon) }),
      ),
    );
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(logs, []);

  now += 60 * 60 * 1000;
  const later = makeAdvertPacket({ timestamp: 1_800_003_700 });
  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(later) })),
  );
  assert.equal(requests.length, 2);

  const retryRequests = [];
  let retryAttempt = 0;
  const retryUploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch: async (url, init) => {
        retryRequests.push({ url, init });
        retryAttempt += 1;
        return retryAttempt === 1
          ? { ok: false, status: 500, text: async () => "nope" }
          : { ok: true, status: 200, text: async () => '{"ok":true}' };
      },
      now: () => now,
    }),
  );
  await rememberDefaultStatus(retryUploader);
  const retryPacket = makeAdvertPacket({ timestamp: 1_800_100_000 });

  logs = await captureConsoleOutput(async () => {
    await retryUploader.processMqttMessage(
      "meshcore/STO/observer-key/raw",
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(retryPacket) }),
      ),
    );
  });
  assert.equal(retryRequests.length, 2);
  assert.equal(logs.filter((line) => /Upload failed/.test(line)).length, 0);
  assert.match(
    logs.at(-1),
    /Advert SE-STO-TEST \([0-9a-f]{6}\) sent to meshcore\.io: no parseable response – \{"ok":true\}/,
  );
});

test("holds a valid advert on in-memory cooldown for one hour across observers", async () => {
  const { fetch, requests } = makeFetch();
  let now = 10_000;
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch,
      now: () => now,
    }),
  );
  const secondObserverId = "b2".repeat(32);

  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${secondObserverId}/status`,
    statusPayload({ origin: "SE-STO-OBSERVER-2", origin_id: secondObserverId }),
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_200_000 })),
      }),
    ),
  );

  let logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${secondObserverId}/raw`,
      Buffer.from(
        JSON.stringify({
          origin_id: secondObserverId,
          data: hex(makeAdvertPacket({ timestamp: 1_800_203_700 })),
        }),
      ),
    );
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(logs, []);

  now += 60 * 60 * 1000;
  await uploader.processMqttMessage(
    `meshcore/STO/${secondObserverId}/raw`,
    Buffer.from(
      JSON.stringify({
        origin_id: secondObserverId,
        data: hex(makeAdvertPacket({ timestamp: 1_800_207_400 })),
      }),
    ),
  );

  assert.equal(requests.length, 2);
});

test("logs one outcome line when several observers hear the same advert", async () => {
  const { fetch, requests } = makeFetch({ text: '{"code":"NODES_INSERTED"}' });
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch,
      now: () => 10_000,
    }),
  );
  const secondObserverId = "b2".repeat(32);
  const thirdObserverId = "c3".repeat(32);

  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${secondObserverId}/status`,
    statusPayload({ origin: "SE-STO-OBSERVER-2", origin_id: secondObserverId }),
  );
  await uploader.processMqttMessage(
    `meshcore/STO/${thirdObserverId}/status`,
    statusPayload({ origin: "SE-STO-OBSERVER-3", origin_id: thirdObserverId }),
  );

  const packet = makeAdvertPacket({ timestamp: 1_800_400_000 });
  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(
        JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }),
      ),
    );
    await uploader.processMqttMessage(
      `meshcore/STO/${secondObserverId}/packets`,
      Buffer.from(
        JSON.stringify({ origin_id: secondObserverId, raw: hex(packet) }),
      ),
    );
    await uploader.processMqttMessage(
      `meshcore/STO/${thirdObserverId}/raw`,
      Buffer.from(
        JSON.stringify({ origin_id: thirdObserverId, data: hex(packet) }),
      ),
    );
  });

  assert.equal(requests.length, 1);
  const outcomeLines = logs.filter((line) => /sent to meshcore\.io/.test(line));
  assert.equal(outcomeLines.length, 1);
  assert.match(outcomeLines[0], /sent to meshcore\.io: NODES_INSERTED/);
});

test("skips oversized packet hex before parsing", async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({ fetch }),
  );
  await rememberDefaultStatus(uploader);

  await uploader.processMqttMessage(
    "meshcore/STO/observer-key/raw",
    Buffer.from(
      JSON.stringify({ origin_id: OBSERVER_ID, data: "aa".repeat(600) }),
    ),
  );

  assert.equal(requests.length, 0);
});
