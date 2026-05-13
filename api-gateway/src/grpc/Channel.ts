import * as grpc from '@grpc/grpc-js';

export interface VideoFrame {
  data: Buffer;
  channelId: string;
}

export interface TranslationResult {
  text: string;
  channelId: string;
}

export type ClientStream = grpc.ServerDuplexStream<VideoFrame, TranslationResult>;
export type UpstreamStream = grpc.ClientDuplexStream<VideoFrame, TranslationResult>;

export class Channel {
  readonly id: string;
  private readonly upstream: UpstreamStream;
  private readonly onTeardown: (id: string) => void;
  private readonly clients = new Set<ClientStream>();
  private closed = false;

  constructor(id: string, upstream: UpstreamStream, onTeardown: (id: string) => void) {
    this.id = id;
    this.upstream = upstream;
    this.onTeardown = onTeardown;

    upstream.on('data', (result: TranslationResult) => this.broadcast(result));
    upstream.on('end', () => this.terminate());
    upstream.on('error', (err: Error) => this.terminate(err));
  }

  addClient(call: ClientStream): boolean {
    if (this.closed) return false;
    this.clients.add(call);
    return true;
  }

  removeClient(call: ClientStream): void {
    if (!this.clients.delete(call)) return;
    if (this.clients.size === 0) this.shutdown();
  }

  forward(frame: VideoFrame): boolean {
    if (this.closed) return true;
    if (!frame.data || frame.data.length === 0) return true;
    return this.upstream.write(frame);
  }

  onUpstreamDrain(cb: () => void): void {
    if (this.closed) {
      cb();
      return;
    }
    this.upstream.once('drain', cb);
  }

  get size(): number {
    return this.clients.size;
  }

  private broadcast(result: TranslationResult): void {
    if (this.closed) return;
    if (result.channelId !== this.id) return;
    for (const client of this.clients) {
      client.write(result, (err: Error | null | undefined) => {
        if (err) this.removeClient(client);
      });
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.upstream.end();
    } catch {
      this.upstream.cancel();
    }
    this.onTeardown(this.id);
  }

  private terminate(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      if (err) {
        const code = (err as { code?: grpc.status }).code ?? grpc.status.UNAVAILABLE;
        client.destroy(Object.assign(new Error(err.message), { code }));
      } else {
        client.end();
      }
    }
    this.clients.clear();
    this.onTeardown(this.id);
  }
}

export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  getOrCreate(id: string, openUpstream: () => UpstreamStream): Channel {
    const existing = this.channels.get(id);
    if (existing) return existing;

    const channel = new Channel(id, openUpstream(), (key) => {
      this.channels.delete(key);
      console.log(`[gateway] canal encerrado: ${key} (ativos: ${this.channels.size})`);
    });
    this.channels.set(id, channel);
    console.log(`[gateway] canal iniciado: ${id} (ativos: ${this.channels.size})`);
    return channel;
  }
}
