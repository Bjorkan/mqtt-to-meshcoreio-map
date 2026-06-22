import { AdvertPostingQueue } from "./queue/advert-posting-queue.js";
import { MeshcoreioPoster } from "./meshcoreio-poster/meshcoreio-poster.js";
import { MqttBrokerAdvertReader } from "./mqtt-reader/mqtt-broker-advert-reader.js";
import type { MapUploaderConfig, MapUploaderDependencies } from "./map-types.js";

export * from "./queue/advert-posting-queue.js";
export * from "./map-log.js";
export * from "./map-types.js";
export * from "./persistence-store.js";
export * from "./meshcoreio-poster/meshcoreio-poster.js";
export * from "./mqtt-reader/mqtt-broker-advert-reader.js";

export class MeshcoreMapUploader {
  private readonly reader: MqttBrokerAdvertReader;
  readonly ready: Promise<void>;

  constructor(
    config: MapUploaderConfig,
    dependencies: MapUploaderDependencies = {}
  ) {
    const posters = Array.from(
      { length: config.maxConcurrentUploads },
      () => new MeshcoreioPoster(config, dependencies)
    );
    const queue = new AdvertPostingQueue(
      config,
      posters,
      (pubKey, timestamp) => this.reader.rememberSuccessfulAdvert(pubKey, timestamp),
      dependencies
    );

    this.reader = new MqttBrokerAdvertReader(config, queue, dependencies);
    this.ready = Promise.all([
      this.reader.ready,
      ...posters.map((poster) => poster.ready),
    ]).then(() => undefined);
  }

  handleMqttMessage(topic: string, payload: Buffer, sourceName?: string): void {
    this.reader.handleMqttMessage(topic, payload, sourceName);
  }

  processMqttMessage(topic: string, payload: Buffer, sourceName?: string): Promise<void> {
    return this.reader.processMqttMessage(topic, payload, sourceName);
  }
}
