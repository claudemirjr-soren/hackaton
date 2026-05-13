# Plano de Deploy do `api-gateway` na AWS

Este documento descreve como eu colocaria o `api-gateway` (Node.js / gRPC) em produção na AWS, com foco em (1) atender o contrato de **canal efêmero compartilhado por `channel_id`**, (2) suportar **gRPC bidirecional** (HTTP/2 end-to-end) e (3) escalar horizontalmente sem perder a semântica dos canais em memória.

---

## 1. Visão geral da arquitetura proposta

```
                   Internet
                      │ (gRPC / HTTP/2 + TLS)
                      ▼
               ┌─────────────┐
               │     ALB     │  (HTTP/2 listener, target-type=ip)
               │   gRPC LB   │
               └──────┬──────┘
                      │ ALGORITMO: consistent hashing por channel-id
                      ▼ (via Envoy sidecar / dispatcher — ver §5)
          ┌────────────────────────┐
          │   api-gateway tasks    │  ECS Fargate Service
          │     (N replicas)       │  Service Connect mesh
          └────────────┬───────────┘
                       │ gRPC interno (service-translation.local:50051)
                       ▼
          ┌────────────────────────┐
          │ service-translation    │  ECS Fargate Service
          │     (M replicas)       │
          └────────────────────────┘

Observabilidade: CloudWatch Logs + Container Insights + ADOT/X-Ray
CI/CD: GitHub Actions → ECR → ECS rolling deploy
```

---

## 2. Serviço de container

**Escolha: Amazon ECS com Fargate.**

Justificativa:

| Critério | ECS Fargate | EKS |
|---|---|---|
| Custo operacional | Sem gerenciar nodes | Precisa node group / Karpenter |
| Curva de aprendizado | Baixa | Alta (RBAC, manifests, controllers) |
| Integração nativa AWS | Service Connect, ALB, IAM Task Role, Secrets Manager direto | Tudo via add-ons / IRSA |
| Adequação ao workload | App único, semi-stateful, gRPC | Ganha em ambientes multi-tenant |
| Time-to-prod | Horas | Dias |

O `api-gateway` é **um serviço focado**, sem necessidade de orquestração complexa, jobs ad-hoc, CRDs ou plataforma multi-team. **Fargate** entrega isolamento por task, integra com Service Connect e ALB gRPC sem fricção, e elimina a operação do plano de dados (nodes, AMIs, patches). EKS só valeria se já existisse uma plataforma K8s consolidada no time.

Configuração de task:

- **CPU/Memória:** começar com `0.5 vCPU / 1 GB` por task (Node single-thread + I/O bound). Ajustar via load test.
- **Network mode:** `awsvpc` (cada task ganha ENI própria + security group dedicado).
- **Task role IAM:** acesso mínimo (CloudWatch Logs, X-Ray, leitura no ECR).
- **Health check:** gRPC health probe (`grpc_health_probe`) no container; ECS usa `containerHealthCheck` + ALB target group health.
- **Graceful shutdown:** `stopTimeout: 30s` para drenar streams ativas ao final do deploy.

---

## 3. Registro de imagem e pipeline de build

**Registry:** **Amazon ECR (private repository)** `hackaton/api-gateway`.

Por quê: ECR integra com IAM (sem segredos no `docker login`), tem scan nativo (Inspector ou básico), lifecycle policy para descartar imagens antigas, e é a opção mais barata/rápida para puxar de dentro da VPC (via VPC endpoint).

**Pipeline (GitHub Actions):**

```yaml
on:
  push:
    branches: [main]
    paths: ['api-gateway/**']

jobs:
  build-and-deploy:
    permissions:
      id-token: write   # OIDC para assumir role na AWS sem long-lived keys
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<acct>:role/github-actions-ecr-push
          aws-region: us-east-1
      - uses: aws-actions/amazon-ecr-login@v2
      - run: |
          IMAGE=$ECR_REGISTRY/hackaton/api-gateway:$GITHUB_SHA
          docker buildx build --platform linux/amd64 \
            -f api-gateway/Dockerfile -t $IMAGE \
            --push .
      - run: |
          aws ecs update-service \
            --cluster prod \
            --service api-gateway \
            --force-new-deployment \
            --task-definition $(aws ecs register-task-definition --cli-input-json file://taskdef.json --query taskDefinition.taskDefinitionArn --output text)
```

Pontos-chave:

- **OIDC** em vez de chaves AWS estáticas no GitHub.
- **Lifecycle policy** no ECR mantendo as últimas 30 imagens da `main` + tags semânticas.
- **Vulnerability scan on push** (Inspector v2). Falha o pipeline em CVE crítica.
- **Image signing** com `cosign` (keyless via OIDC) para garantir proveniência.

---

## 4. Rede e descoberta de serviço

**Service Connect** do ECS é a escolha primária.

Como funciona:

- Cada task ganha um proxy Envoy sidecar gerenciado pela AWS.
- Endpoints são publicados num namespace do **Cloud Map** (`hackaton.internal`).
- O `api-gateway` resolve `service-translation.hackaton.internal:50051` localmente; o Envoy faz o LB do lado cliente, com retries e timeouts configuráveis.
- Suporte nativo a **gRPC/HTTP2**, ao contrário do antigo `awsvpc` puro com DNS round-robin.
- Métricas HTTP/gRPC já emitidas pra CloudWatch.

Topologia:

- Uma **VPC privada** com subnets em ≥2 AZs.
- **Security groups por serviço:**
  - `sg-api-gateway` aceita `:50052` apenas do SG do ALB.
  - `sg-service-translation` aceita `:50051` apenas do SG do `api-gateway`.
- **VPC endpoints** (Interface Endpoints) pra ECR, CloudWatch Logs, Secrets Manager → tráfego nunca sai pra Internet.
- **Sem NAT Gateway** se não houver outras dependências externas (economia).

Alternativa considerada: Cloud Map puro com DNS A-records. Funciona, mas perde retries L7, observabilidade nativa e tem cache de DNS chato em runtime Node.

---

## 5. Exposição externa

**Application Load Balancer (ALB) com listener HTTP/2** atrás de **AWS WAF** + **Route 53** (`grpc.dominio.com`).

Por quê ALB (e não NLB):

| | ALB | NLB |
|---|---|---|
| HTTP/2 / gRPC end-to-end | ✅ (desde 2020) | ✅ TCP transparente |
| Header/path routing | ✅ | ❌ |
| WAF integrado | ✅ | ❌ |
| Health check gRPC | ✅ (status code) | TCP apenas |
| Logs estruturados (access logs) | ✅ | Limitado |
| Custo a alta vazão | $$ | $ |
| Latência | ~ms a mais | Quase zero |

Pra esse caso (tráfego gRPC com requisitos de WAF, logs detalhados e roteamento por path/host) o **ALB compensa** o pequeno overhead. NLB só seria preferível se a vazão fosse ordem de >100 Gbps ou se latência sub-ms fosse crítica.

Configurações:

- **Listener:** `HTTPS:443` com cert ACM. Protocol version `HTTP/2`.
- **Target group:** `protocol=HTTP`, `protocol-version=gRPC`, target-type `ip`. Health check `/grpc.health.v1.Health/Check` com matcher `0,12`.
- **Idle timeout:** 4000s (streams bidirecionais longas).
- **Deregistration delay:** 30s pra drenar streams no rolling deploy.

### Ponto crítico: roteamento por `channel_id` (afinidade de canal)

O modelo do gateway mantém **canais em memória**: vários clientes com o mesmo `channel_id` precisam cair na **mesma task** pra compartilhar o stream upstream.

ALB **não consegue** rotear por `channel_id` (o id vive no corpo protobuf de cada `VideoFrame`, não em header HTTP). Stickiness por cookie/IP **não resolve**, pois clientes do mesmo canal podem vir de IPs diferentes.

**Solução adotada:** o cliente publica o `channel_id` também como **gRPC metadata** (`x-channel-id`), e na frente das tasks existe um **Envoy** (sidecar via Service Connect ou cluster próprio) com `RING_HASH` em cima daquele header:

```yaml
load_assignment: { ... ECS service discovery ... }
lb_policy: RING_HASH
lb_subset_config: { ... }
route:
  hash_policy:
    - header: { header_name: "x-channel-id" }
```

Resultado: clientes com o mesmo `x-channel-id` caem deterministicamente na mesma task; tasks novas/removidas redistribuem só uma fração dos canais (consistent hashing).

Alternativas analisadas:

- **Fanout via pub/sub (ElastiCache Redis ou MSK):** cada task assina o canal global, broadcast cruzado. Vantagem: roteamento trivial. Desvantagem: latência extra por hop, custo, complicação de ciclo de vida (TTL de canal entre réplicas).
- **App Mesh com consistent hashing:** equivalente ao Envoy custom, mas em sunset (AWS depreciou App Mesh em 2024).
- **Réplica única vertical:** simples, mas teto de capacidade definido por uma máquina só.

---

## 6. Escalabilidade

Premissa: o gateway é **stateful por canal** (em memória), mas o estado é **particionável por `channel_id`**. Com consistent hashing (§5), cada task vira "dona" de um subconjunto de canais; adicionar/remover tasks rebalanceia só ~1/N canais.

**Auto Scaling:**

- **Target tracking** em ECS Application Auto Scaling, sinais combinados:
  - `CPUUtilization` alvo 60%.
  - **Métrica customizada** `ActiveChannels` emitida via EMF (ver §7); alvo, por exemplo, 200 canais por task.
- **Cooldown alto pra scale-in** (10 min) — evita matar tasks com streams ativas.
- **Min replicas: 2** (HA inter-AZ). **Max: 20** inicialmente.

**Deploys sem perder streams ativas:**

1. **Rolling deploy** com `minimumHealthyPercent=100`, `maximumPercent=200`.
2. ECS marca a task antiga como `DRAINING` → ALB para de mandar **conexões novas**.
3. Connection draining de até 30s no target group + `stopTimeout: 30s` no container.
4. O gateway intercepta `SIGTERM` e emite o gRPC trailer `GOAWAY` em cada stream → o cliente reconecta numa task nova; o Envoy faz o re-hash e a maioria dos canais reabre na mesma task ou cai num "vizinho" do ring.

**Limites verticais:** com as otimizações atuais (1 stream upstream por canal, pipe sem buffer, backpressure), uma task `0.5 vCPU / 1 GB` atende centenas de canais. O bottleneck passa a ser CPU do Node (event loop) ou a memória do `service-translation`, não o gateway.

---

## 7. Observabilidade

Três pilares: **logs**, **métricas**, **tracing**.

### Logs

- **Driver:** `awslogs` direto pro CloudWatch Logs (`/ecs/api-gateway/<env>`).
- **Formato:** JSON estruturado (pino/winston) com `traceId`, `channelId`, `clientId`, `event`, `latencyMs`.
- **Retenção:** 30 dias em CloudWatch; export S3 + Athena pra análise histórica.
- **Insights queries** prontas pra:
  - "top 20 channels por duração",
  - "taxa de erro por minuto",
  - "tasks que mais teardown sofrem em 5 min" (sinal de scale-in agressivo).

### Métricas

- **CloudWatch Container Insights** (CPU/mem/network por task — incluso no Fargate).
- **Application metrics via EMF** (Embedded Metric Format) — log estruturado vira métrica sem precisar de daemon:
  - `ActiveChannels` (gauge)
  - `ChannelLifetimeMs` (histogram)
  - `UpstreamWriteBackpressure` (count) — quantas vezes pausamos clientes
  - `BroadcastWriteErrors` (count)
  - `ClientsPerChannel` (histogram)
- **Alarms** críticos:
  - `5xx` > 1% por 5 min → page.
  - `ActiveChannels / desiredCount` > 80% por 10 min → scale-out preventivo (caso o target tracking esteja em delay).
  - `BroadcastWriteErrors` taxa anômala → degradação no Swift.

### Tracing distribuído

- **AWS Distro for OpenTelemetry (ADOT)** como sidecar.
- Instrumentação automática do gRPC client/server em Node (`@opentelemetry/instrumentation-grpc`).
- Exporter para **AWS X-Ray** (ou Tempo/AMG, dependendo do stack do time).
- Atributos relevantes: `channel.id`, `upstream.service`, `frames.forwarded`, `client.role` (sender/listener).

### Painéis e SLO

- **Grafana** (AMG) consumindo CloudWatch + X-Ray.
- SLOs iniciais:
  - **Disponibilidade gRPC**: 99.9% (success rate de `StreamTranslation`).
  - **Time-to-first-caption** (latência da 1ª legenda após o 1º frame de vídeo do sender) p99 < 2s.
  - **Broadcast fanout latency** p99 < 200ms (delta entre `upstream.data` e `client.write` confirmado).

---

## Resumo das escolhas

| Camada | Escolha | Motivo |
|---|---|---|
| Compute | **ECS Fargate** | Stateless infra, foco no app, integração nativa |
| Registry | **ECR private** | IAM-first, scan, VPC endpoint |
| CI/CD | **GitHub Actions + OIDC** | Sem long-lived secrets, deploy declarativo |
| Service discovery | **ECS Service Connect** | Envoy gerenciado, gRPC-aware, métricas grátis |
| LB externo | **ALB HTTP/2 + WAF** | gRPC nativo, roteamento L7, logs ricos |
| Afinidade de canal | **Envoy consistent hashing** em `x-channel-id` metadata | Particionamento determinístico sem pub/sub |
| Escalabilidade | Target tracking em **CPU + ActiveChannels** | Sinais combinados; scale-in conservador |
| Observabilidade | **CloudWatch + EMF + ADOT/X-Ray** | Sem servidor de métricas próprio; tudo gerenciado |
