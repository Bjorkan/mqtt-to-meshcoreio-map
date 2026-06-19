import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  createMapUploadSigningIdentity,
  MeshcoreMapUploader,
  MeshcoreioPoster,
} from '../../dist/map-uploader.js';
import {
  ADVERT_SEED,
  OBSERVER_ID,
  captureConsoleOutput,
  hex,
  makeAdvertPacket,
  makeConfig,
  makeFetch,
  rememberDefaultStatus,
  signedRequestData,
} from '../mqtt-reader/helpers.mjs';

test('logs map API accepted and recently-updated responses for pushed adverts', async () => {
  for (const [text, expected] of [
    [
      '{"message":"Node(s) inserted/updated successfully","code":"NODES_INSERTED"}',
      /Meshcore\.io accepted advert for SE-STO-TEST \([0-9a-f]{6}\)\./,
    ],
    [
      '{"error":"Advert recently processed, ignoring","code":"ERR_ADVERT_DUPLICATE"}',
      /Meshcore\.io accepted advert for SE-STO-TEST \([0-9a-f]{6}\) but dropped it because it was updated recently\./,
    ],
  ]) {
    const { fetch } = makeFetch({ text });
    const uploader = new MeshcoreMapUploader(makeConfig(), { fetch });
    await rememberDefaultStatus(uploader);

    const packet = makeAdvertPacket({ timestamp: 1_800_090_000 + text.length });
    const logs = await captureConsoleOutput(async () => {
      await uploader.processMqttMessage(
        `meshcore/STO/${OBSERVER_ID}/packets`,
        Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, type: 'PACKET', raw: hex(packet) }))
      );
    });

    assert.match(logs.at(-1), expected);
  }
});

test('does not retry terminal map API responses', async () => {
  const { fetch, requests } = makeFetch({
    ok: false,
    status: 409,
    text: '{"error":"Advert recently processed, ignoring","code":"ERR_ADVERT_DUPLICATE"}',
  });
  const uploader = new MeshcoreMapUploader(makeConfig(), {
    fetch,
    workerDelay: async () => {},
  });
  await rememberDefaultStatus(uploader);

  const logs = await captureConsoleOutput(async () => {
    await uploader.processMqttMessage(
      `meshcore/STO/${OBSERVER_ID}/packets`,
      Buffer.from(JSON.stringify({
        origin_id: OBSERVER_ID,
        raw: hex(makeAdvertPacket({ timestamp: 1_800_090_500 })),
      }))
    );
  });

  assert.equal(requests.length, 1);
  assert.match(
    logs.at(-1),
    /Meshcore\.io accepted advert for SE-STO-TEST \([0-9a-f]{6}\) but dropped it because it was updated recently\./
  );
});

test('signs map uploads with a generated ephemeral upload identity', async () => {
  const { fetch, requests } = makeFetch();
  const signingIdentity = createMapUploadSigningIdentity();
  const uploader = new MeshcoreMapUploader(makeConfig(), { fetch, signingIdentity });
  await uploader.ready;
  await rememberDefaultStatus(uploader);

  const packet = makeAdvertPacket({});
  await uploader.processMqttMessage(
    `meshcore/STO/${OBSERVER_ID}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, type: 'PACKET', raw: hex(packet) }))
  );

  assert.equal(requests.length, 1);
  const requestBody = JSON.parse(requests[0].init.body);
  const dataHash = createHash('sha256').update(requestBody.data).digest();
  assert.equal(requestBody.publicKey, hex(signingIdentity.publicKey));
  assert.equal(
    ed25519.verify(
      Buffer.from(requestBody.signature, 'hex'),
      dataHash,
      signingIdentity.publicKey
    ),
    true
  );
});

test('posts JSON-serializable queue work requests without parsed Advert instances', async () => {
  const { fetch, requests } = makeFetch({ text: '{"code":"NODES_INSERTED"}' });
  const signingIdentity = createMapUploadSigningIdentity();
  const poster = new MeshcoreioPoster(makeConfig(), { fetch, signingIdentity });
  const packet = makeAdvertPacket({ timestamp: 1_800_091_500 });
  const nodePublicKey = hex(ed25519.getPublicKey(ADVERT_SEED));

  const workRequest = JSON.parse(JSON.stringify({
    requestId: 'f8d0f0fb-783c-4a2e-b0c4-22a86b22b43b',
    retriesAllowed: 3,
    advertKey: `${nodePublicKey}:1800091500`,
    advertTimestamp: 1_800_091_500,
    advertType: 'REPEATER',
    nodeName: 'SE-STO-TEST',
    nodePublicKey,
    rawPacketHex: hex(packet),
    observerId: OBSERVER_ID,
    observerName: 'SE-STO-OBSERVER',
    radioParams: {
      freq: 869.617981,
      bw: 62.5,
      sf: 8,
      cr: 8,
    },
    logContext: {
      advertLabel: `SE-STO-TEST (${nodePublicKey.slice(0, 6)})`,
      observerLabel: 'SE-STO-OBSERVER',
    },
  }));

  const result = await poster.post(workRequest);

  assert.deepEqual(result, {
    status: 'handled',
    pubKey: nodePublicKey,
    timestamp: 1_800_091_500,
    responseFromMeshcoreIO: '{"code":"NODES_INSERTED"}',
  });
  assert.match(workRequest.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(requests.length, 1);
  assert.deepEqual(signedRequestData(requests), {
    params: {
      freq: 869.618,
      bw: 62.5,
      sf: 8,
      cr: 8,
    },
    links: [`meshcore://${hex(packet)}`],
  });
});

test('creates a fresh upload identity for each test helper call', () => {
  const first = createMapUploadSigningIdentity();
  const second = createMapUploadSigningIdentity();

  assert.match(hex(first.publicKey), /^[0-9a-f]{64}$/);
  assert.match(hex(first.privateSeed), /^[0-9a-f]{64}$/);
  assert.notEqual(hex(first.publicKey), hex(second.publicKey));
  assert.notEqual(hex(first.privateSeed), hex(second.privateSeed));
});
