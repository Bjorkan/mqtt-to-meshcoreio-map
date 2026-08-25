import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createMapUploadSigningIdentity,
  MeshcoreioPoster,
} from "../../src/map-uploader.ts";
import { formatMapApiOutcomeLog } from "../../src/map-utils.ts";

const context = { advertLabel: "SE-STO-TEST (a09aa5)" };

test("outcome log covers known response codes", () => {
  assert.equal(
    formatMapApiOutcomeLog(context, { code: "NODES_INSERTED" }, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: NODES_INSERTED",
  );
  assert.equal(
    formatMapApiOutcomeLog(context, { code: "ERR_ADVERT_DUPLICATE" }, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: ERR_ADVERT_DUPLICATE – node was updated recently",
  );
  assert.equal(
    formatMapApiOutcomeLog(context, { code: "ERR_COORDS_MISSING" }, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: ERR_COORDS_MISSING – map coordinates are missing",
  );
});

test("outcome log handles unparseable and odd response bodies", () => {
  assert.equal(
    formatMapApiOutcomeLog(context, undefined, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: no parseable response",
  );

  const arrayBody = "[1,2,3]";
  assert.equal(
    formatMapApiOutcomeLog(context, undefined, arrayBody),
    `Advert SE-STO-TEST (a09aa5) sent to meshcore.io: no parseable response – ${arrayBody}`,
  );

  assert.equal(
    formatMapApiOutcomeLog(context, { code: "" }, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: no parseable response",
  );

  assert.equal(
    formatMapApiOutcomeLog(context, { code: 42 }, ""),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: no parseable response",
  );
});

test("outcome log prefers string message/error details and skips non-strings", () => {
  assert.equal(
    formatMapApiOutcomeLog(
      context,
      { code: "ERR_CUSTOM", message: "later", error: "first" },
      "raw",
    ),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: ERR_CUSTOM – later",
  );
  assert.equal(
    formatMapApiOutcomeLog(
      context,
      { code: "ERR_CUSTOM", error: "fallback" },
      "raw",
    ),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: ERR_CUSTOM – fallback",
  );
  assert.equal(
    formatMapApiOutcomeLog(
      context,
      { code: "ERR_CUSTOM", message: { deep: true } },
      "",
    ),
    "Advert SE-STO-TEST (a09aa5) sent to meshcore.io: ERR_CUSTOM",
  );
});

test("rejects signing identities with wrong buffer sizes", () => {
  const empty = Buffer.alloc(0);
  assert.throws(
    () =>
      new MeshcoreioPoster(
        {
          enabled: true,
          apiUrl: "",
          dryRun: false,
          minReuploadIntervalSeconds: 0,
          requestTimeoutMs: 1000,
          maxQueuedUploads: 1,
          retriesAllowed: 1,
        },
        { signingIdentity: { privateSeed: empty, publicKey: empty } },
      ),
    /32-byte/,
  );

  const identity = createMapUploadSigningIdentity();
  const seed32 = Buffer.concat([identity.privateSeed, Buffer.alloc(0)]);
  assert.equal(seed32.length, 32);
});
