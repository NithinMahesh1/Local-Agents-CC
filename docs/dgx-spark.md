# Running the box on an NVIDIA DGX Spark

This document shows how the author serves a model on an NVIDIA DGX Spark for Local-Agents-CC. Local-Agents-CC itself runs on your own computer; the DGX Spark is the box that runs the model server.

[Back to the README](../README.md)

## The hardware

Local-Agents-CC was built for, and runs every day with, an NVIDIA DGX Spark as the box. The DGX Spark has an NVIDIA GB10 Grace Blackwell chip and 128 GB of memory. The CPU and the GPU share this memory. The memory speed is about 273 GB/s. This speed sets how fast the box writes tokens (the pieces of text that a model reads and writes).

## Models we run

We use vLLM to serve models. vLLM is a tool that runs large language models. We run two models: OpenAI gpt-oss-120b and Google Gemma 4 26B-A4B (8-bit). Only one model fits in memory at a time.

The gpt-oss-120b model is a mixture-of-experts (MoE) model. In an MoE model, only some parts of the model run for each token. For this model, 5.1B of its 116.8B parameters are active per token. The weights of the model are in MXFP4. MXFP4 is OpenAI's 4-bit number format. The model size is about 61 GB. The model uses the Apache-2.0 license. The context window is 131,072 tokens. A context window is the amount of text a model considers at one time. The launcher's default `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is 120,000. This leaves room for the answer. The model accepts three reasoning effort levels: high, medium, or low. spark-router changes "max" and "xhigh" effort levels to "high" for box requests.

## How many agents at once

About 8 agents work well at the same time. About 6 agents work well if you use gpt-oss-120b. More agents cause a queue. Each agent becomes slower because they share one GPU.

## Serve a model with vLLM

Wait for the model to start before you start a session. The first start of gpt-oss-120b takes about 11 minutes. You must wait until vLLM's `/health` endpoint answers with status 200. Until then, local-agents-cc warns that the local model server is not answering.

Use this command to start vLLM with Docker:

```bash
docker run --rm --name vllm --gpus all --ipc=host --network host \
  --env-file /etc/vllm/vllm.env \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:<version> \
  openai/gpt-oss-120b \
  --served-model-name gpt-oss-120b local-model \
  --host 0.0.0.0 --port 8000 \
  --enable-prefix-caching \
  --gpu-memory-utilization 0.85 \
  --tool-call-parser openai \
  --enable-auto-tool-choice
```

| Setting | Why |
| --- | --- |
| `--env-file /etc/vllm/vllm.env` | This file holds one line: `VLLM_API_KEY=<your key>`. Only the root user can read this file. |
| `--served-model-name gpt-oss-120b local-model` | This gives the model two names. Clients use `local-model`. This means the router setting, the agent file, and saved sessions do not change when you switch models. |
| `--gpu-memory-utilization 0.85` | vLLM uses at most 85% of the shared memory for the model and its cache. The rest remains for the operating system. |
| `--tool-call-parser openai` and `--enable-auto-tool-choice` | These settings turn the model's tool calls into the API's tool-call format. This allows Claude Code's tools to work. Without these, a request with tools fails with HTTP 400. |
| `--enable-prefix-caching` | vLLM keeps the start of each conversation. The next turn does not process the start of the conversation again. |

## Connect your computer

Set these environment variables on your computer:

- `SPARK_ROUTER_LOCAL_URL=http://your-box.local:8000`
- `SPARK_ROUTER_LOCAL_MODELS=local-model`

The key file holds the same key as `VLLM_API_KEY`. See [Configuration](configuration.md) for more details.

## Network and key safety

vLLM's `/health` endpoint needs no key. Every `/v1` request needs the key in the header as `Authorization: Bearer <key>`. spark-router adds this header for you.

vLLM reads the API key from the `VLLM_API_KEY` environment variable if you do not use the `--api-key` flag. Put the key in an environment file. Only the root user should read this file. This prevents the key from appearing on a command line or in shell history.

Allow the vLLM port (8000) only from your home network in the firewall. Do not open this port to the internet.

If the box's firewall allows only IPv4, a name that resolves to an IPv6 address first can cause connections to hang. In this case, set `SPARK_ROUTER_LOCAL_URL` to the IPv4 address of the box.

## Other hardware

Any computer that serves a model with the Anthropic Messages API, a Bearer key, `/health` endpoint, and tool calling works. The author only tested this on a DGX Spark.
