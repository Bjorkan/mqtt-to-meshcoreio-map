import { ed25519 } from '@noble/curves/ed25519.js';

export const ADVERT_SEED = Buffer.from('22'.repeat(32), 'hex');
export const SECOND_ADVERT_SEED = Buffer.from('23'.repeat(32), 'hex');
export const THIRD_ADVERT_SEED = Buffer.from('24'.repeat(32), 'hex');
export const FOURTH_ADVERT_SEED = Buffer.from('25'.repeat(32), 'hex');
export const FIFTH_ADVERT_SEED = Buffer.from('26'.repeat(32), 'hex');
export const OBSERVER_ID = 'a1'.repeat(32);
export const API_URL = 'https://map.meshcore.io/api/v1/uploader/node';

export const advertTypes = {
  none: 0,
  chat: 1,
  repeater: 2,
  room: 3,
  sensor: 4,
};

export function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function u32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export function makeConfig(overrides = {}) {
  return {
    enabled: true,
    apiUrl: API_URL,
    dryRun: false,
    minReuploadIntervalSeconds: 3600,
    requestTimeoutMs: 10000,
    maxConcurrentUploads: 2,
    maxQueuedUploads: 25,
    retriesAllowed: 3,
    ...overrides,
  };
}

export function makeFetch({ ok = true, status = 200, text = '{"ok":true}' } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok,
      status,
      text: async () => text,
    };
  };

  return { fetch, requests };
}

export function makeAdvertPacket({
  seed = ADVERT_SEED,
  timestamp = 1_800_000_000,
  name = 'SE-STO-TEST',
  type = advertTypes.repeater,
  tamperSignature = false,
}) {
  const publicKey = Buffer.from(ed25519.getPublicKey(seed));
  const appData = Buffer.concat([
    Buffer.from([0x80 | type]),
    Buffer.from(name, 'utf8'),
  ]);
  const signed = Buffer.concat([publicKey, u32le(timestamp), appData]);
  const signature = Buffer.from(ed25519.sign(signed, seed));
  if (tamperSignature) {
    signature[0] ^= 0xff;
  }

  const payload = Buffer.concat([publicKey, u32le(timestamp), signature, appData]);
  return Buffer.concat([
    Buffer.from([(0x04 << 2) | 0x01, 0x00]),
    payload,
  ]);
}

export function statusPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    origin: 'SE-STO-OBSERVER',
    origin_id: OBSERVER_ID,
    radio: '869.617981,62.5,8,8',
    ...overrides,
  }));
}

export async function rememberDefaultStatus(uploader) {
  await uploader.processMqttMessage(`meshcore/STO/${OBSERVER_ID}/status`, statusPayload());
}

export function signedRequestData(requests) {
  const requestBody = JSON.parse(requests[0].init.body);
  return JSON.parse(requestBody.data);
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]+m/g, '');
}

export async function captureConsoleLog(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(stripAnsi(args.join(' ')));
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
  }

  return lines;
}

export async function captureConsoleOutput(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  const capture = (...args) => {
    lines.push(stripAnsi(args.join(' ')));
  };
  console.log = capture;
  console.warn = capture;

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  return lines;
}
