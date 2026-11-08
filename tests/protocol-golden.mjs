// Regenerate with bun tests/protocol-golden.mjs
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { Advert, Packet } from "@liamcottle/meshcore.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ADVERT_SEED,
  advertTypes,
  hex,
  makeAdvertPacket,
} from "./mqtt-reader/helpers.mjs";

const repeater = makeAdvertPacket({});
const appData = Buffer.concat([
  Buffer.from([0xf2]), // repeater with lat/lon, two feature fields, name
  Buffer.alloc(8),
  Buffer.from([0x01, 0x02, 0x03, 0x04]),
  Buffer.from("Map relay", "utf8"),
]);
const signed = Buffer.concat([repeater.subarray(2, 38), appData]);
const metadataPacket = Buffer.concat([
  repeater.subarray(0, 38),
  Buffer.from(ed25519.sign(signed, ADVERT_SEED)),
  appData,
]);
const cases = [
  ["flood", repeater],
  [
    "two-byte-path",
    Buffer.concat([
      repeater.subarray(0, 1),
      Buffer.from([0x41, 0xaa, 0xbb]),
      repeater.subarray(2),
    ]),
  ],
  ["direct", Buffer.concat([Buffer.from([0x12]), repeater.subarray(1)])],
  [
    "transport-flood",
    Buffer.concat([Buffer.from([0x10, 0, 0, 0, 0]), repeater.subarray(1)]),
  ],
  [
    "transport-direct",
    Buffer.concat([Buffer.from([0x13, 0, 0, 0, 0]), repeater.subarray(1)]),
  ],
  ["room", makeAdvertPacket({ type: advertTypes.room })],
  ["sensor", makeAdvertPacket({ type: advertTypes.sensor })],
  ["unicode-name", makeAdvertPacket({ name: "Malmö 📡" })],
  ["optional-metadata", metadataPacket],
  ["chat", makeAdvertPacket({ type: advertTypes.chat })],
  ["bad-signature", makeAdvertPacket({ tamperSignature: true })],
  ["truncated", repeater.subarray(0, 20)],
  ["bad-header", Buffer.concat([Buffer.from([0]), repeater.subarray(1)])],
];
const vectors = [];
for (const [name, bytes] of cases) {
  let expected = null;
  try {
    const packet = Packet.fromBytes(bytes);
    if (packet.payload_type_string === "ADVERT") {
      const advert = Advert.fromBytes(packet.payload);
      if (
        ["REPEATER", "ROOM", "SENSOR"].includes(advert.parsed.type) &&
        (await advert.isVerified())
      ) {
        expected = {
          public_key: hex(advert.publicKey),
          timestamp: advert.timestamp,
          name: advert.parsed.name ?? hex(advert.publicKey).slice(0, 8),
          kind: advert.parsed.type,
        };
      }
    }
  } catch {
    /* malformed packet */
  }
  vectors.push({ name, hex: hex(bytes), expected });
}
writeFileSync(
  new URL("./protocol-golden.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);
