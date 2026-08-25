import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AdvertPostingQueue,
  MeshcoreMapUploader,
} from '../../dist/map-uploader.js';
import {
  ADVERT_SEED,
  OBSERVER_ID,
  SECOND_ADVERT_SEED,
  THIRD_ADVERT_SEED,
  captureConsoleOutput,
  hex,
  makeAdvertPacket,
  makeConfig,
  makeFetch,
  rememberDefaultStatus,
  signedRequestData,
} from '../mqtt-reader/helpers.mjs';

test('stays silent about a failed attempt that succeeds on retry', async () => {
  const requests = [];
  let attempt = 0;
  const uploader = new MeshcoreMapUploader(makeConfig(), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      attempt += 1;
      if (attempt === 1) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }

      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_101_000 })) }))
    );
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(logs.filter((line) => /Upload failed|Going to the back/.test(line)), []);
  assert.match(logs.at(-1), /sent to meshcore\.io/);
});

test('serializes uploads and queues the rest', async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig({
    maxQueuedUploads: 5,
  }), {
    fetch: async (url, init) => {
      active += 1;
      peak = Math.max(peak, active);
      requests.push({ url, init });
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_200_000 })) }))
  );
  const second = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ seed: SECOND_ADVERT_SEED, timestamp: 1_800_203_700 })) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(peak, 1);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(peak, 1);

  releases.shift()();
  await Promise.all([first, second]);
});

test('drops extra adverts when the upload queue is full', async () => {
  const releases = [];
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig({
    maxQueuedUploads: 1,
  }), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      await new Promise((resolve) => releases.push(resolve));
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_220_000 })) }))
  );
  const second = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ seed: SECOND_ADVERT_SEED, timestamp: 1_800_223_700 })) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ seed: THIRD_ADVERT_SEED, timestamp: 1_800_227_400 })) }))
    );
  });

  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /Upload queue is full\. Dropping advert for SE-STO-TEST \([0-9a-f]{6}\)\./);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);

  releases.shift()();
  await Promise.all([first, second]);
});

test('waits between uploads before draining the next queued advert', async () => {
  const requests = [];
  let delayCalls = 0;
  let releaseFirstUploadDelay;
  const uploader = new MeshcoreMapUploader(makeConfig({
    maxQueuedUploads: 5,
  }), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {
      delayCalls += 1;
      if (delayCalls === 1) {
        await new Promise((resolve) => {
          releaseFirstUploadDelay = resolve;
        });
      }
    },
  });
  await rememberDefaultStatus(uploader);

  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_210_000 })) }))
  );
  const second = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ seed: SECOND_ADVERT_SEED, timestamp: 1_800_213_700 })) }))
  );

  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  releaseFirstUploadDelay();
  await second;
  assert.equal(requests.length, 2);
});

test('prevents concurrent uploads inside the same node reupload interval', async () => {
  const releases = [];
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig({
    minReuploadIntervalSeconds: 3600,
  }), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      await new Promise((resolve) => releases.push(resolve));
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const first = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_500_000 })) }))
  );
  const tooSoon = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_500_100 })) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  releases.shift()();
  await Promise.all([first, tooSoon]);
  assert.equal(requests.length, 1);
});

test('skips an older queued advert after a newer advert was uploaded', async () => {
  let releaseFetch;
  const requests = [];
  const newerPacket = makeAdvertPacket({ timestamp: 1_800_403_700 });
  const olderPacket = makeAdvertPacket({ timestamp: 1_800_400_000 });
  const uploader = new MeshcoreMapUploader(makeConfig({
    maxQueuedUploads: 5,
    minReuploadIntervalSeconds: 0,
  }), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const newer = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(newerPacket) }))
  );
  const older = uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/raw`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(olderPacket) }))
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  releaseFetch();
  await Promise.all([newer, older]);

  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests).links, [`meshcore://${hex(newerPacket)}`]);
});

test('drops uploads after three failed tries', async () => {
  const failing = makeFetch({ ok: false, status: 503, text: 'down' });
  const uploader = new MeshcoreMapUploader(makeConfig(), {
    fetch: failing.fetch,
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_300_000 })) }))
    );
  });

  assert.equal(failing.requests.length, 3);
  assert.equal(logs.filter((line) => /Upload failed|Going to the back/.test(line)).length, 0);
  assert.match(
    logs.at(-1),
    /Advert SE-STO-TEST \([0-9a-f]{6}\) dropped after 3 attempts: meshcore\.io responded 503: down\./
  );
});

test('queue drops incoming work requests with no retries allowed silently', async () => {
  const queue = new AdvertPostingQueue(
    makeConfig(),
    { post: async () => ({ status: 'handled', pubKey: ADVERT_SEED.toString('hex'), timestamp: 1 }) },
    () => {},
    { uploadDelay: async () => {} }
  );

  const logs = await captureConsoleOutput(async () => {
    await queue.registerAdvert({
      requestId: 'f8d0f0fb-783c-4a2e-b0c4-22a86b22b43b',
      retriesAllowed: 0,
      advertKey: `${ADVERT_SEED.toString('hex')}:1`,
      advertTimestamp: 1,
      advertType: 'REPEATER',
      nodeName: 'SE-STO-TEST',
      nodePublicKey: ADVERT_SEED.toString('hex'),
      rawPacketHex: '0100',
      observerId: OBSERVER_ID,
      observerName: 'SE-STO-OBSERVER',
      radioParams: {
        freq: 869.618,
        bw: 62.5,
        sf: 8,
        cr: 8,
      },
      logContext: {
        advertLabel: 'SE-STO-TEST (a09aa5)',
      },
    });
  });

  assert.deepEqual(logs, []);
});

test('aborts an upload whose server stalls mid-body instead of hanging the queue', async () => {
  const requests = [];
  const uploader = new MeshcoreMapUploader(makeConfig({ requestTimeoutMs: 50 }), {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }),
      };
    },
    uploadDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/raw`,
      Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, data: hex(makeAdvertPacket({ timestamp: 1_800_600_000 })) }))
    );
  });

  assert.equal(requests.length, 3);
  assert.match(
    logs.at(-1),
    /Advert SE-STO-TEST \([0-9a-f]{6}\) dropped after 3 attempts: operation aborted\./
  );
});
