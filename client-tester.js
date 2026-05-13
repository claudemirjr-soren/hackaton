const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

const PROTO_PATH = path.join(__dirname, './protos/translation.proto');
const VIDEO_PATH = path.join(__dirname, './test-video.mp4');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  defaults: true,
});
const translationProto = grpc.loadPackageDefinition(packageDefinition).translation.v1;

const CHANNEL_COUNT = 3290;
const CLIENTS_PER_CHANNEL = 5;
const CHUNK_SIZE = 64 * 1024;
const EXPECTED_LEGENDS_PER_CLIENT = Math.ceil(fs.statSync(VIDEO_PATH).size / CHUNK_SIZE);
const TEST_TIMEOUT_MS = 30_000;
const CLIENT_POOL_SIZE = Math.max(1, Math.ceil((CHANNEL_COUNT * CLIENTS_PER_CHANNEL) / 100));

const clientPool = [];
for (let i = 0; i < CLIENT_POOL_SIZE; i += 1) {
  clientPool.push(
    new translationProto.TranslationProvider('localhost:50052', grpc.credentials.createInsecure(), {
      'grpc.primary_user_agent': `client-tester-${i}`,
    }),
  );
}

let nextClientIdx = 0;
const pickClient = () => {
  const c = clientPool[nextClientIdx % clientPool.length];
  nextClientIdx += 1;
  return c;
};

function runChannelClient(channelId, clientNumber, sendsVideo) {
  return new Promise((resolve) => {
    const clientId = `${channelId}/client-${clientNumber}${sendsVideo ? '/sender' : '/listener'}`;
    const call = pickClient().StreamTranslation();
    let receivedResults = 0;
    let mismatchedResults = 0;
    let settled = false;

    const finish = (reason = 'completed') => {
      if (settled) return;
      settled = true;

      if (receivedResults === 0) {
        console.warn(
          `[${clientId}] ⚠️ Stream finalizada sem nenhuma legenda retornada pelo servidor.`,
        );
      }

      if (mismatchedResults > 0) {
        console.error(
          `[${clientId}] ❌ Stream recebeu ${mismatchedResults} legenda(s) de outro canal.`,
        );
      }

      console.log(`[${clientId}] 🏁 ${reason}. Legendas recebidas: ${receivedResults}.`);
      resolve({ channelId, clientId, receivedResults, mismatchedResults });
    };

    console.log(
      `[${clientId}] 🎬 Entrando no canal${sendsVideo ? ' e enviando vídeo' : ' como listener'}`,
    );

    call.on('data', (response) => {
      const responseChannelId = response.channel_id || response.channelId || '';

      if (responseChannelId !== channelId) {
        mismatchedResults += 1;
        console.error(
          `[${clientId}] ❌ Legenda recebida no canal errado: ${responseChannelId || '<vazio>'}`,
        );
        call.cancel();
        finish('mismatch de canal');
        return;
      }

      receivedResults += 1;

      if (receivedResults === EXPECTED_LEGENDS_PER_CLIENT) {
        call.cancel();
        finish('quantidade esperada recebida');
      }
    });

    call.on('error', (err) => {
      if (!settled) {
        console.error(`[${clientId}] ❌ Erro:`, err.message);
        finish('erro');
      }
    });

    call.on('end', () => finish('stream encerrada pelo servidor'));

    call.write({
      data: Buffer.alloc(0),
      channel_id: channelId,
    });

    if (!sendsVideo) {
      return;
    }

    const readStream = fs.createReadStream(VIDEO_PATH, { highWaterMark: CHUNK_SIZE });

    readStream.on('data', (chunk) => {
      const canContinue = call.write({
        data: chunk,
        channel_id: channelId,
      });

      if (!canContinue) {
        readStream.pause();
        call.once('drain', () => readStream.resume());
      }
    });

    readStream.on('end', () => {
      console.log(`[${clientId}] 📦 Fim do arquivo de vídeo. Fechando envio gRPC...`);
      call.end();
    });

    readStream.on('error', (err) => {
      console.error(`[${clientId}] ❌ Erro ao ler o arquivo de vídeo:`, err);
      call.cancel();
      finish('erro de leitura');
    });
  });
}

const testRunId = Math.random().toString(36).substring(7);
const channelClients = [];

for (let channelIndex = 1; channelIndex <= CHANNEL_COUNT; channelIndex += 1) {
  const channelId = `shared-channel-${testRunId}-${channelIndex}`;

  for (let clientIndex = 1; clientIndex <= CLIENTS_PER_CHANNEL; clientIndex += 1) {
    channelClients.push(runChannelClient(channelId, clientIndex, clientIndex === 1));
  }
}

const timeout = new Promise((resolve) => {
  setTimeout(() => resolve({ timeout: true }), TEST_TIMEOUT_MS);
});

Promise.race([Promise.all(channelClients), timeout])
  .then((results) => {
    if (results.timeout) {
      console.error(`❌ Timeout de ${TEST_TIMEOUT_MS}ms aguardando canais compartilhados.`);
      clientPool.forEach((c) => c.close());
      process.exitCode = 1;
      return;
    }

    const totalLegends = results.reduce((sum, result) => sum + result.receivedResults, 0);
    const totalMismatches = results.reduce((sum, result) => sum + result.mismatchedResults, 0);
    const missingLegends = results.filter(
      (result) => result.receivedResults !== EXPECTED_LEGENDS_PER_CLIENT,
    );

    if (totalMismatches > 0) {
      console.error(`❌ ${totalMismatches} legenda(s) recebida(s) em canal incorreto.`);
      process.exitCode = 1;
    }

    if (missingLegends.length > 0) {
      console.error(
        `❌ ${missingLegends.length} cliente(s) não receberam ${EXPECTED_LEGENDS_PER_CLIENT} legenda(s).`,
      );
      process.exitCode = 1;
    }

    console.log(
      `✅ ${results.length} conexões em ${CHANNEL_COUNT} canais finalizadas. Total de legendas recebidas: ${totalLegends}`,
    );
    clientPool.forEach((c) => c.close());
  })
  .catch((err) => {
    console.error('❌ Erro inesperado:', err);
    clientPool.forEach((c) => c.close());
    process.exitCode = 1;
  });
