# Deploying titw to Azure Container Apps

This guide walks through packaging a titw multi-agent team as an Azure Container Apps Job and wiring it to Azure AI Foundry for LLM inference.

---

## Prerequisites

- Azure CLI (`az`) installed and authenticated
- Docker installed locally
- An Azure subscription with Container Apps and Azure AI Foundry access
- A titw runner project (see `docs/tutorial.md`)

---

## Step 1 — Containerise the runner

Create a `Dockerfile` at the project root:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
CMD ["node", "dist/main.js"]
```

Build and push to Azure Container Registry:

```bash
az acr build \
  --registry <your-registry> \
  --image titw-team:latest \
  .
```

---

## Step 2 — Provision the Container Apps Job

Install the Functions + ARM SDKs:

```bash
npm install @azure/functions @azure/arm-appcontainers @azure/identity
```

For runner configuration (`src/runner.ts`), see `docs/runner-azure-foundry.md` — it covers the `buildAzureFoundryClientConfig` helper and the `api-key` header fix required by Azure AI Foundry.

---

## Step 3 — Configure secrets

Store your API keys in Azure Key Vault and inject them as secrets into the Container Apps Job environment:

```bash
az containerapp job create \
  --name titw-research-team \
  --resource-group <rg> \
  --environment <env> \
  --image <registry>.azurecr.io/titw-team:latest \
  --secrets \
    "azure-ai-endpoint=keyvaultref:<vault>/secrets/AZURE-AI-ENDPOINT,identityref:<identity>" \
    "azure-ai-api-key=keyvaultref:<vault>/secrets/AZURE-AI-API-KEY,identityref:<identity>" \
  --env-vars \
    "AZURE_AI_ENDPOINT=secretref:azure-ai-endpoint" \
    "AZURE_AI_API_KEY=secretref:azure-ai-api-key"
```

---

## Step 4 — Trigger a run

```bash
az containerapp job start \
  --name titw-research-team \
  --resource-group <rg>
```

Logs are available in Application Insights or via:

```bash
az containerapp job execution show \
  --name titw-research-team \
  --resource-group <rg> \
  --job-execution-name <execution-id>
```
