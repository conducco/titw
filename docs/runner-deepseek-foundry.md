# Using DeepSeek on Azure AI Foundry

Azure AI Foundry lets you deploy DeepSeek models (R1, V3, and others) as serverless APIs — pay-per-token. DeepSeek uses an **OpenAI-compatible API**, so your runner uses `client.chat.completions.create(...)` instead of `client.messages.create(...)`.

Because titw never calls LLMs directly, the entire integration lives in your `AgentRunner`. The framework, team config, and orchestration are unchanged.

---

## Step 1 — Deploy DeepSeek in Azure AI Foundry

1. Go to [portal.azure.ai](https://portal.azure.ai) and open your project.
2. Navigate to **Model Catalog** in the left menu.
3. Search for **DeepSeek**. Select your model (DeepSeek-R1 for reasoning tasks, DeepSeek-V3 for general use).
4. Click **Deploy** → **Serverless API**.
5. Set a **Deployment Name** (e.g. `deepseek-r1`). This name becomes the model ID in your API calls.
6. Click **Deploy** and wait.

---

## Step 2 — Copy your credentials

Once the deployment is active:

1. Open the deployment's **Details** tab.
2. Copy the **Target URI** — looks like:
   ```
   https://[resource].services.ai.azure.com/api/projects/[project]
   ```
3. Copy the **API Key**.

Set as environment variables:

```bash
AZURE_AI_DEEPSEEK_ENDPOINT=https://[resource].services.ai.azure.com/api/projects/[project]
AZURE_AI_DEEPSEEK_KEY=your-azure-api-key
```

> **Note:** DeepSeek's endpoint path (`/api/projects/[project]`) differs from Claude's (`/models`). Both work with `buildAzureFoundryClientConfig` — just pass your Target URI as `endpoint`.

---

## Step 3 — Verify the correct baseURL for the OpenAI SDK

> **Do this before writing the runner.** Azure AI Foundry project endpoints use different sub-path suffixes depending on the deployment.

In the Foundry portal, click **View Code** on your deployment and look at the OpenAI SDK example. It will show you either:

- The Target URI as-is:
  `https://[resource].services.ai.azure.com/api/projects/[project]`
- The Target URI with `/openai` appended:
  `https://[resource].services.ai.azure.com/api/projects/[project]/openai`

Use whichever the portal shows. The OpenAI SDK appends `/chat/completions` to whatever `baseURL` you provide, so the full request path must match what Azure expects. If you get a 404, see Common Issues below.

---

## Step 4 — Configure the runner

### Why `buildAzureFoundryClientConfig` is needed

The OpenAI SDK sends `Authorization: Bearer <key>` by default. Azure AI Foundry expects `api-key: <key>`. Without the override, every request returns 401. `buildAzureFoundryClientConfig` injects the `api-key` header automatically.

### Install the OpenAI SDK

```bash
npm install openai
```

### Update `src/runner.ts` — client instantiation

```ts
// Before (native Anthropic)
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()

// After (DeepSeek on Azure AI Foundry)
import OpenAI from 'openai'
import { buildAzureFoundryClientConfig } from '@conducco/titw'

const client = new OpenAI(buildAzureFoundryClientConfig({
  endpoint: process.env.AZURE_AI_DEEPSEEK_ENDPOINT!,
  apiKey:   process.env.AZURE_AI_DEEPSEEK_KEY!,
}))
```

### Update `src/runner.ts` — message loop

DeepSeek uses the OpenAI-compatible chat completions format. Replace `client.messages.create(...)` with `client.chat.completions.create(...)` and switch to OpenAI-style message types:

```ts
// Tool definitions use OpenAI format
const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'spawn_teammate',
      description: '...',
      parameters: { type: 'object', properties: { ... }, required: [...] },
    },
  },
  // ...
]

// Message loop
const response = await client.chat.completions.create({
  model:    params.model,
  messages: messages as OpenAI.ChatCompletionMessageParam[],
  tools:    TOOLS,
})

const message = response.choices[0].message

// Append assistant turn
messages.push(message)

// Handle tool calls
if (message.tool_calls && message.tool_calls.length > 0) {
  for (const toolCall of message.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments)
    const result = await dispatchTool(toolCall.function.name, args)

    // Tool result in OpenAI format
    messages.push({
      role:         'tool',
      tool_call_id: toolCall.id,
      content:      JSON.stringify(result),
    })
  }
} else {
  // No tool calls — model returned a final answer
  break
}
```

The full pattern (TOOLS definition, message loop, retry logic) is covered in `docs/tutorial.md` under the `## Swapping providers` section (OpenAI example).

---

## Step 5 — Set the model in TeamConfig

```ts
export const team: TeamConfig = {
  name: 'research-team',
  leadAgentName: 'lead',
  defaultModel: 'deepseek-r1',   // ← your Foundry deployment name
  members: [...]
}
```

The deployment name is passed through `params.model` to your `client.chat.completions.create({ model: params.model, ... })` call unchanged.

---

## Step 6 — Run

```bash
AZURE_AI_DEEPSEEK_ENDPOINT=https://... AZURE_AI_DEEPSEEK_KEY=... npx tsx src/main.ts
```

---

## Environment variables reference

| Variable | Value |
|----------|-------|
| `AZURE_AI_DEEPSEEK_ENDPOINT` | Target URI from Foundry portal |
| `AZURE_AI_DEEPSEEK_KEY` | API Key from Foundry portal |

---

## Common issues

**401 Unauthorized**
The SDK is sending the wrong auth header. Confirm you are using `buildAzureFoundryClientConfig`. The `api-key` header must be set.

**404 Not Found**
The `baseURL` path doesn't match Azure's expected path. Check **View Code** in the portal (Step 3). You may need to append `/openai` to the Target URI before passing it as `endpoint`.

**Model not found / deployment not found**
`params.model` must exactly match your **Deployment Name** in Foundry (e.g. `deepseek-r1`), not the catalog identifier.

**Tool call schema errors / 400 Bad Request**
DeepSeek's tool format uses `parameters` (not `input_schema`) and wraps tools as `{ type: 'function', function: { ... } }`. This is the OpenAI format — do not use the Anthropic tool schema.

**Model not available in catalog**
Not all DeepSeek versions are listed in every Azure region. Check the current catalog in your Foundry project.

---

## Using with Azure Container Apps deployment

If you are deploying titw to Azure Container Apps (see `docs/deployment-azure-container-apps.md`), store `AZURE_AI_DEEPSEEK_ENDPOINT` and `AZURE_AI_DEEPSEEK_KEY` in Key Vault and inject them into the Container Apps Job as secrets — replacing the `AZURE_AI_ENDPOINT` / `AZURE_AI_API_KEY` values shown in that guide's Step 3.
