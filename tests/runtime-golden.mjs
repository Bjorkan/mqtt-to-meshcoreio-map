// Regenerate with: bun tests/runtime-golden.mjs
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { MeshcoreMapUploader } from "../src/map-uploader.ts";
import { parseStaticSigningIdentity } from "../src/map-uploader.ts";
import {
  OBSERVER_ID,
  hex,
  makeAdvertPacket,
  makeConfig,
  makeFetch,
  makeUploaderDependencies,
  statusPayload,
} from "./mqtt-reader/helpers.mjs";

const seed = "01".repeat(32);
const vectors = [];
for (const [name, status, packet] of [
  ["comma", statusPayload(), makeAdvertPacket({})],
  [
    "direct-hz",
    statusPayload({
      radio: undefined,
      params: { freq: 869617981, bw: 62500, sf: 8, cr: 8 },
    }),
    makeAdvertPacket({ timestamp: 1800000500 }),
  ],
  [
    "text-radio",
    statusPayload({ radio: "869.617981 MHz · SF8 · BW62.5 · CR8" }),
    makeAdvertPacket({ timestamp: 1800001000 }),
  ],
  [
    "invalid-signature",
    statusPayload(),
    makeAdvertPacket({ tamperSignature: true }),
  ],
  ["chat", statusPayload(), makeAdvertPacket({ type: 1 })],
  [
    "invalid-text-radio-units",
    statusPayload({ radio: "869000000 MHz · BW62500 · SF8 · CR8" }),
    makeAdvertPacket({ timestamp: 1800001500 }),
  ],
]) {
  const { fetch, requests } = makeFetch({ text: '{"code":"NODES_INSERTED"}' });
  const uploader = new MeshcoreMapUploader(
    makeConfig(),
    makeUploaderDependencies({
      fetch,
      signingIdentity: parseStaticSigningIdentity(seed),
    }),
  );
  const topic = `meshcore/STO/${OBSERVER_ID}`;
  await uploader.processMqttMessage(`${topic}/status`, status);
  await uploader.processMqttMessage(
    `${topic}/packets`,
    Buffer.from(JSON.stringify({ origin_id: OBSERVER_ID, raw: hex(packet) })),
  );
  vectors.push({
    name,
    status: status.toString(),
    topic,
    packet: hex(packet),
    request: requests[0] ? JSON.parse(requests[0].init.body) : null,
  });
}
writeFileSync(
  new URL("./runtime-golden.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);
