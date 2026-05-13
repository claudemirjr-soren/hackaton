import * as grpc from '@grpc/grpc-js';
import { Channel, ChannelRegistry, ClientStream, UpstreamStream, VideoFrame } from './Channel';
import { TranslationPackage } from './proto';

type Dependencies = {
  translationPackage: TranslationPackage;
  translationTarget: string;
};

export function createTranslationProxyHandlers(
  deps: Dependencies,
): grpc.UntypedServiceImplementation {
  const upstreamClient = new deps.translationPackage.TranslationProvider(
    deps.translationTarget,
    grpc.credentials.createInsecure(),
  ) as unknown as grpc.Client & { streamTranslation(): UpstreamStream };

  const registry = new ChannelRegistry();

  return {
    streamTranslation: (call: ClientStream) => {
      let channelId: string | null = null;
      let channel: Channel | null = null;
      let cleaned = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (channel) channel.removeClient(call);
      };

      const reject = (msg: string, code: grpc.status = grpc.status.INVALID_ARGUMENT) => {
        cleanup();
        call.destroy(Object.assign(new Error(msg), { code }));
      };

      call.on('data', (frame: VideoFrame) => {
        if (!frame.channelId) {
          return reject('channelId é obrigatório em todo frame');
        }

        if (channelId === null) {
          channelId = frame.channelId;
          channel = registry.getOrCreate(channelId, () => upstreamClient.streamTranslation());
          if (!channel.addClient(call)) {
            return reject('canal indisponível', grpc.status.UNAVAILABLE);
          }
        } else if (frame.channelId !== channelId) {
          return reject(
            `channelId imutável (esperado "${channelId}", recebido "${frame.channelId}")`,
          );
        }

        if (!channel!.forward(frame)) {
          call.pause();
          channel!.onUpstreamDrain(() => call.resume());
        }
      });

      call.on('error', (err: Error) => {
        console.error(`[gateway] erro no stream ${channelId ?? '-'}: ${err.message}`);
        cleanup();
      });

      call.on('close', cleanup);
    },
  };
}
