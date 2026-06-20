import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createMapUploadSigningIdentity,
  MeshcoreMapUploader,
  SqliteObserverStatusStore,
} from '../../dist/map-uploader.js';
import { DashboardState } from '../../dist/dashboard/dashboard-state.js';
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
} from './helpers.mjs';

test('uploads verified packets.raw adverts with firmware radio parameters', async () => {
  const { fetch, requests } = makeFetch();
  const signingIdentity = createMapUploadSigningIdentity();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch, signingIdentity }));
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, type: 'PACKET', raw: hex(packet) }))
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, API_URL);
  assert.equal(requests[0].init.headers['content-type'], 'application/json');

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

test('silently ignores duplicate adverts already queued or in flight', async () => {
  let releaseFetch;
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch: async () => {
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return { ok: true, status: 200, text: async () => '{"code":"NODES_INSERTED"}' };
    },
  }));
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({ timestamp: 1_800_091_000 });
  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  const logs = await captureConsoleLog(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
    );
  });

  releaseFetch();
  await first;

  assert.deepEqual(logs, []);
});

test('does not log successful observer status updates as map uploads', async () => {
  const { fetch } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));

  const logs = await captureConsoleLog(async () => {
    await rememberDefaultStatus(uploader);
  });

  assert.deepEqual(logs, []);
});

test('does not add routine status and empty packet messages to dashboard events', async () => {
  const dashboardState = new DashboardState({
    now: () => new Date('2026-06-19T10:00:00.000Z'),
  });
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch: makeFetch().fetch,
    dashboardState,
  }));

  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, type: 'PACKET' }))
  );

  assert.deepEqual(dashboardState.snapshot().logs, []);
});

test('uploads verified raw.data adverts with human readable radio parameters', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await uploader.processMqttMessage(
    'meshcore/STO/observer-key/status',
    statusPayload({ radio: '869.617981 MHz · SF8 · BW62.5 · CR8' })
  );

  const packet = makeAdvertPacket({ timestamp: 1_800_003_700 });
  await uploader.processMqttMessage(
    'meshcore/STO/observer-key/raw',
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, type: 'RAW', data: hex(packet) }))
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    sf: 8,
    bw: 62.5,
    cr: 8,
  });
});

test('normalizes direct frequency fields from MHz, kHz, and Hz', async () => {
  for (const [freq, expected] of [
    [869.617981, 869.618],
    [869617.981, 869.618],
    [869617981, 869.618],
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await uploader.processMqttMessage(
      'meshcore/STO/observer-key/status',
      statusPayload({ radio: undefined, params: { freq, bw: 62500, sf: 8, cr: 8 } })
    );

    const packet = makeAdvertPacket({ timestamp: 1_800_010_000 + Math.floor(freq) });
    await uploader.processMqttMessage(
      'meshcore/STO/observer-key/raw',
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
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

test('normalizes comma radio strings from Hz and Hz bandwidth', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await uploader.processMqttMessage(
    'meshcore/STO/observer-key/status',
    statusPayload({ radio: '869617981,62500,8,8' })
  );

  await uploader.processMqttMessage(
    'meshcore/STO/observer-key/raw',
    Buffer.from(JSON.stringify({
      origin_id: OBSERVER_ID,
      data: hex(makeAdvertPacket({ timestamp: 1_800_011_000 })),
    }))
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test('uses 64-hex observer id from standard, meshrank, and custom topics when payload omits origin_id', async () => {
  for (const topic of [
    `meshcore/STO/${OBSERVER_ID}/raw`,
    `meshrank/uplink/token/${OBSERVER_ID}/packets`,
    `mynetwork/raw/${OBSERVER_ID}`,
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await uploader.processMqttMessage(`mynetwork/status/${OBSERVER_ID}`, statusPayload({ origin_id: undefined }));

    const packet = makeAdvertPacket({ timestamp: 1_800_030_000 + requests.length + topic.length });
    await uploader.processMqttMessage(
      topic,
      Buffer.from(JSON.stringify({ data: hex(packet), raw: hex(packet) }))
    );

    assert.equal(requests.length, 1);
  }
});

test('normalizes uppercase observer origin_id and topic ids', async () => {
  const upperObserverId = OBSERVER_ID.toUpperCase();
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));

  await uploader.processMqttMessage(
    `meshcore/STO/${upperObserverId}/status`,
    statusPayload({ origin_id: upperObserverId })
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${upperObserverId}/raw`,
    Buffer.from(JSON.stringify({
      origin_id: upperObserverId,
      data: hex(makeAdvertPacket({ timestamp: 1_800_031_000 })),
    }))
  );

  assert.equal(requests.length, 1);
});

test('skips custom topic packets without payload origin_id or 64-hex topic id', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    'mynetwork/raw/not-a-public-key',
    Buffer.from(JSON.stringify({ data: hex(packet) }))
  );

  assert.equal(requests.length, 0);
});

test('keeps the latest valid radio params when a later complete status is invalid', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: '869.617981,62.5,8,8' })
  );
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: '1001000000,62.5,8,8' })
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({
      origin_id: OBSERVER_ID,
      data: hex(makeAdvertPacket({ timestamp: 1_800_050_000 })),
    }))
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test('keeps previous valid radio params when later status is offline or incomplete', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    Buffer.from(JSON.stringify({ status: 'offline', origin_id: OBSERVER_ID }))
  );

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 869.618,
    bw: 62.5,
    sf: 8,
    cr: 8,
  });
});

test('replaces previous observer radio params when a newer valid status arrives', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));

  await rememberDefaultStatus(uploader);
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    statusPayload({ radio: '868.100,125,7,5' })
  );

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({
      origin_id: OBSERVER_ID,
      data: hex(makeAdvertPacket({ timestamp: 1_800_065_000 })),
    }))
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).params, {
    freq: 868.1,
    bw: 125,
    sf: 7,
    cr: 5,
  });
});

test('drops observer radio status after one hour without a new valid status', async () => {
  const { fetch, requests } = makeFetch();
  let now = 1_000_000;
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch,
    now: () => now,
  }));

  await rememberDefaultStatus(uploader);
  now += 60 * 60 * 1000 + 1;

  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/status`,
    Buffer.from(JSON.stringify({ status: 'offline', origin_id: OBSERVER_ID }))
  );
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_070_000 })) }))
  );

  assert.equal(requests.length, 0);
});

test('loads persisted observer radio status from SQLite after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mqtt-to-map-observers-'));
  const dbPath = join(directory, 'observer-status.sqlite');

  try {
    const firstStore = new SqliteObserverStatusStore(dbPath);
    const firstUploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
      fetch: makeFetch().fetch,
      observerStatusStore: firstStore,
      now: () => 1_000_000,
    }));
    await rememberDefaultStatus(firstUploader);
    firstStore.close();

    const { fetch, requests } = makeFetch();
    const secondStore = new SqliteObserverStatusStore(dbPath);
    const secondUploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
      fetch,
      observerStatusStore: secondStore,
      now: () => 1_000_000 + 30 * 60 * 1000,
    }));

    await secondUploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_070_000 })) }))
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).params, {
      freq: 869.618,
      bw: 62.5,
      sf: 8,
      cr: 8,
    });
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('removes persisted observer radio status older than one hour', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mqtt-to-map-observers-'));
  const dbPath = join(directory, 'observer-status.sqlite');

  try {
    const firstStore = new SqliteObserverStatusStore(dbPath);
    firstStore.upsert({
      origin: 'SE-STO-OBSERVER',
      originId: OBSERVER_ID,
      params: { freq: 869.618, bw: 62.5, sf: 8, cr: 8 },
      updatedAt: 1_000_000,
    });
    firstStore.close();

    const secondStore = new SqliteObserverStatusStore(dbPath);
    new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
      fetch: makeFetch().fetch,
      observerStatusStore: secondStore,
      now: () => 1_000_000 + 60 * 60 * 1000 + 1,
    }));

    assert.deepEqual(secondStore.loadAll(), []);
    secondStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prefers packet raw over data and raw topic data over raw field', async () => {
  const packet = makeAdvertPacket({ timestamp: 1_800_060_000 });
  const junkPacket = makeAdvertPacket({ timestamp: 1_800_063_700, type: advertTypes.chat });

  {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(junkPacket),
        raw: hex(packet),
      }))
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).links, [`meshcore://${hex(packet)}`]);
  }

  {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(packet),
        raw: hex(junkPacket),
      }))
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(signedRequestData(requests).links, [`meshcore://${hex(packet)}`]);
  }
});

test('skips adverts when radio params are complete but outside sane ranges', async () => {
  for (const radio of [
    '1,62.5,8,8',
    '869.617981,0,8,8',
    '869.617981,62.5,99,8',
    '869.617981,62.5,8,99',
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/status`,
      statusPayload({ radio })
    );

    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ timestamp: 1_800_040_000 + radio.length })),
      }))
    );

    assert.equal(requests.length, 0);
  }
});

test('deduplicates the same advert when raw and packets arrive together', async () => {
  let releaseFetch;
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch: async (url, init) => {
      requests.push({ url, init });
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  }));
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  const first = uploader.processMqttMessage(
    'meshcore/STO/observer-key/packets',
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) }))
  );
  const second = uploader.processMqttMessage(
    'meshcore/STO/observer-key/raw',
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  releaseFetch();
  await Promise.all([first, second]);
});

test('does not let an invalid in-flight copy suppress a later valid copy', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await rememberDefaultStatus(uploader);

  const invalid = makeAdvertPacket({ tamperSignature: true });
  const valid = makeAdvertPacket({});
  await Promise.all([
    uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(invalid) }))
    ),
    uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(valid) }))
    ),
  ]);

  assert.equal(requests.length, 1);
});

test('dry-run processes five adverts end to end without posting invalid or valid adverts', async () => {
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig({
    dryRun: true,
  }), makeUploaderDependencies({
    fetch: async (url, init) => {
      requests.push({ url, init });
      throw new Error('dry-run should not call fetch');
    },
  }));
  await rememberDefaultStatus(uploader);

  const adverts = [
    makeAdvertPacket({ timestamp: 1_800_600_000, name: 'SE-STO-DRY-1' }),
    makeAdvertPacket({
      seed: FOURTH_ADVERT_SEED,
      timestamp: 1_800_603_700,
      name: 'SE-STO-DRY-2',
      type: advertTypes.sensor,
    }),
    makeAdvertPacket({
      seed: FIFTH_ADVERT_SEED,
      timestamp: 1_800_607_400,
      name: 'SE-STO-BAD-CHAT',
      type: advertTypes.chat,
    }),
    makeAdvertPacket({
      seed: Buffer.from('27'.repeat(32), 'hex'),
      timestamp: 1_800_611_100,
      name: 'SE-STO-BAD-NONE',
      type: advertTypes.none,
    }),
    makeAdvertPacket({
      seed: Buffer.from('28'.repeat(32), 'hex'),
      timestamp: 1_800_614_800,
      name: 'SE-STO-BAD-SIG',
      tamperSignature: true,
    }),
  ];

  const logs = await captureConsoleOutput(async () => {
    for (const packet of adverts) {
      await uploader.processMqttMessage(
        `meshcore/STO/${OBSERVER_ID}/raw`,
        Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
      );
    }
  });

  assert.equal(requests.length, 0);
  assert.equal(logs.filter((line) => /registered to posting queue/.test(line)).length, 2);
  assert.equal(logs.filter((line) => /Dry run enabled; would send advert/.test(line)).length, 2);
  assert.equal(logs.filter((line) => /Dropping\./.test(line)).length, 3);
  assert.match(logs.join('\n'), /SE-STO-BAD-CHAT .* has type CHAT\. Dropping\./);
  assert.match(logs.join('\n'), /SE-STO-BAD-NONE .* has type NONE\. Dropping\./);
  assert.match(logs.join('\n'), /SE-STO-BAD-SIG .* failed signature verification\. Dropping\./);
});

test('skips adverts until observer radio parameters are complete', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  const packet = makeAdvertPacket({});

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      'meshcore/STO/observer-key/raw',
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
    );
  });

  assert.equal(requests.length, 0);
  assert.match(
    logs.at(-1),
    /Advert for SE-STO-TEST \([0-9a-f]{6}\) received by a1a1a1 is missing valid observer radio parameters\. Dropping\./
  );
});

test('skips chat, none, and invalid-signature adverts', async () => {
  for (const [packet, expected] of [
    [
      makeAdvertPacket({ type: advertTypes.chat }),
      /Advert for SE-STO-TEST \([0-9a-f]{6}\) received by SE-STO-OBSERVER has type CHAT\. Dropping\./,
    ],
    [
      makeAdvertPacket({ type: advertTypes.none }),
      /Advert for SE-STO-TEST \([0-9a-f]{6}\) received by SE-STO-OBSERVER has type NONE\. Dropping\./,
    ],
    [
      makeAdvertPacket({ tamperSignature: true }),
      /Advert for SE-STO-TEST \([0-9a-f]{6}\) received by SE-STO-OBSERVER failed signature verification\. Dropping\./,
    ],
  ]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await rememberDefaultStatus(uploader);

    const logs = await captureConsoleOutput(async () => {
      await uploader.processMqttMessage(
        'meshcore/STO/observer-key/raw',
        Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
      );
    });

    assert.equal(requests.length, 0);
    assert.match(logs.at(-1), expected);
  }
});

test('uploads repeater, room, and sensor adverts only', async () => {
  for (const type of [advertTypes.repeater, advertTypes.room, advertTypes.sensor]) {
    const { fetch, requests } = makeFetch();
    const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
    await rememberDefaultStatus(uploader);

    await uploader.processMqttMessage(
      'meshcore/STO/observer-key/raw',
      Buffer.from(JSON.stringify({
        origin_id: OBSERVER_ID,
        data: hex(makeAdvertPacket({ type, timestamp: 1_800_020_000 + type })),
      }))
    );

    assert.equal(requests.length, 1);
  }
});

test('applies replay, reupload interval, and queued upload retry', async () => {
  const { fetch, requests } = makeFetch();
  let now = 10_000;
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch,
    now: () => now,
  }));
  await rememberDefaultStatus(uploader);

  const first = makeAdvertPacket({ timestamp: 1_800_000_000 });
  await uploader.processMqttMessage('meshcore/STO/observer-key/raw', Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(first) })));
  let logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage('meshcore/STO/observer-key/raw', Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(first) })));
  });
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /was already heard at timestamp 1800000000\. Dropping\./);

  const tooSoon = makeAdvertPacket({ timestamp: 1_800_000_100 });
  logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage('meshcore/STO/observer-key/raw', Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(tooSoon) })));
  });
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /is 100s newer than the last upload; minimum reupload interval is 3600s\. Dropping\./);

  const later = makeAdvertPacket({ timestamp: 1_800_003_700 });
  await uploader.processMqttMessage('meshcore/STO/observer-key/raw', Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(later) })));
  assert.equal(requests.length, 2);

  const retryRequests = [];
  let retryAttempt = 0;
  const retryUploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch: async (url, init) => {
      retryRequests.push({ url, init });
      retryAttempt += 1;
      return retryAttempt === 1
        ? { ok: false, status: 500, text: async () => 'nope' }
        : { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    now: () => now,
  }));
  await rememberDefaultStatus(retryUploader);
  const retryPacket = makeAdvertPacket({ timestamp: 1_800_100_000 });

  logs = await captureConsoleOutput(async () => {
    await retryUploader.processMqttMessage('meshcore/STO/observer-key/raw', Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(retryPacket) })));
  });
  assert.equal(retryRequests.length, 2);
  assert.match(logs.join('\n'), /Upload failed for SE-STO-TEST \([0-9a-f]{6}\): meshcore\.io responded 500: nope\. Going to the back of the queue, 2 retries allowed\./);
  assert.match(logs.at(-1), /Meshcore\.io accepted advert for SE-STO-TEST \([0-9a-f]{6}\): {"ok":true}/);
});

test('suppresses repeated drop logs for the same advert and reason', async () => {
  const { fetch, requests } = makeFetch();
  let now = 10_000;
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({
    fetch,
    now: () => now,
  }));
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({ timestamp: 1_800_400_000 });
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
  );

  let logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
    );
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) }))
    );
  });

  assert.equal(requests.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /was already heard at timestamp 1800400000\. Dropping\./);

  now += 60_001;
  logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(packet) }))
    );
  });

  assert.equal(logs.length, 1);
  assert.match(logs[0], /was already heard at timestamp 1800400000\. Dropping\./);
});

test('skips oversized packet hex before parsing', async () => {
  const { fetch, requests } = makeFetch();
  const uploader = new MeshcoreMapUploader(makeConfig(), makeUploaderDependencies({ fetch }));
  await rememberDefaultStatus(uploader);

  await uploader.processMqttMessage(
    'meshcore/STO/observer-key/raw',
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: 'aa'.repeat(600) }))
  );

  assert.equal(requests.length, 0);
});
