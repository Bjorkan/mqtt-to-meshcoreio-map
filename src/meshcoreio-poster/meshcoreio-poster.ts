import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { logMapUpload, trimLogBody } from "../map-log.js";
import {
  buildUploadParams,
  formatMapApiOutcomeLog,
  hasValidParams,
  isTerminalMapApiResponse,
  parseMapApiResponse,
} from "../map-utils.js";
import type {
  MapUploadSigningIdentity,
  MapUploadWorkRequest,
  MapUploaderConfig,
  PosterResult,
  SignedRequest,
} from "../map-types.js";

export interface MeshcoreioPosterDependencies {
  fetch?: typeof fetch;
  signingIdentity?: MapUploadSigningIdentity;
}

export function createMapUploadSigningIdentity(): MapUploadSigningIdentity {
  const privateSeed = randomBytes(32);
  return {
    privateSeed,
    publicKey: Buffer.from(ed25519.getPublicKey(privateSeed)),
  };
}

export class MeshcoreioPoster {
  private readonly fetchImpl: typeof fetch;
  private readonly publicKey: Buffer;
  private readonly publicKeyHex: string;
  private readonly privateSeed: Buffer;
  readonly ready: Promise<void>;

  constructor(
    private readonly config: MapUploaderConfig,
    dependencies: MeshcoreioPosterDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    const signingIdentity =
      dependencies.signingIdentity ?? createMapUploadSigningIdentity();
    this.publicKey = Buffer.from(signingIdentity.publicKey);
    this.privateSeed = Buffer.from(signingIdentity.privateSeed);
    this.publicKeyHex = this.publicKey.toString("hex");
    this.ready = Promise.resolve();

    logMapUpload(
      `Using ephemeral MeshCore.io upload public key ${this.publicKeyHex}.`,
    );
  }

  async post(job: MapUploadWorkRequest): Promise<PosterResult> {
    const {
      advertTimestamp,
      logContext,
      nodePublicKey,
      radioParams,
      rawPacketHex,
    } = job;

    const params = buildUploadParams(radioParams);
    if (!hasValidParams(params)) {
      return {
        status: "handled",
        pubKey: nodePublicKey,
        timestamp: advertTimestamp,
      };
    }

    try {
      const data = {
        params,
        links: [`meshcore://${rawPacketHex}`],
      };

      const requestData = await this.signData(data);

      if (this.config.dryRun) {
        logMapUpload(
          `Dry run: would send advert ${logContext.advertLabel} to meshcore.io.`,
        );
        return {
          status: "handled",
          pubKey: nodePublicKey,
          timestamp: advertTimestamp,
        };
      }

      const response = await this.postWithTimeout(requestData);
      const rawResponseText = await response.text().catch(() => "");
      const mapResponse = parseMapApiResponse(rawResponseText);
      const loggedText = trimLogBody(rawResponseText);

      if (!response.ok && isTerminalMapApiResponse(mapResponse)) {
        logMapUpload(formatMapApiOutcomeLog(logContext, mapResponse, loggedText));
        return {
          status: "handled",
          pubKey: nodePublicKey,
          timestamp: advertTimestamp,
          responseFromMeshcoreIO: rawResponseText,
        };
      }

      if (!response.ok) {
        return {
          status: "retry",
          error: new Error(
            `meshcore.io responded ${response.status}${rawResponseText ? `: ${trimLogBody(rawResponseText)}` : ""}`,
          ),
        };
      }

      logMapUpload(formatMapApiOutcomeLog(logContext, mapResponse, loggedText));
      return {
        status: "handled",
        pubKey: nodePublicKey,
        timestamp: advertTimestamp,
        responseFromMeshcoreIO: rawResponseText,
      };
    } catch (error: unknown) {
      return { status: "retry", error };
    }
  }

  private async signData(data: unknown): Promise<SignedRequest> {
    await this.ready;

    const json = JSON.stringify(data);
    const hashHex = createHash("sha256").update(json).digest("hex");
    const signature = Buffer.from(
      ed25519.sign(Buffer.from(hashHex, "hex"), this.privateSeed),
    ).toString("hex");

    return {
      data: json,
      signature,
      publicKey: this.publicKeyHex,
    };
  }

  private async postWithTimeout(body: SignedRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );

    try {
      return await this.fetchImpl(this.config.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
