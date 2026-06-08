# AI Werewolf

AI Werewolf is a local Werewolf game sandbox. It lets human and AI seats play through night actions, sheriff election, speeches, voting, exile, win checks, and reviewable AI decision logs.

## Requirements

- Node.js 20 or newer
- npm

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

Then open:

- Web app: http://127.0.0.1:12000
- API server: http://127.0.0.1:12001

Build check:

```bash
npm run build
```

Run tests:

```bash
npm test
```

## How to Use

1. Open http://127.0.0.1:12000.
2. Choose total players, human players, AI players, and the random seed.
3. Start a new game.
4. Follow the current phase prompts for night actions, sheriff election, speeches, voting, and exile.
5. Enable exposure mode when you need to debug or review roles, AI rationales, prompts, and call logs.

## Configure Real AI

The project can run with mock decisions by default. To use a real model:

1. Open the admin console.
2. Go to AI configuration and choose or add a provider.
3. Enter the Base URL, model name, and local API key.
4. Run the connection test.
5. Return to the game and let AI seats request model decisions.

API keys are not committed to Git. The default local config file is `data/ai-config.json`, which is ignored by `.gitignore`.

Common environment variables:

- `PORT`: API server port, default `12001`
- `HOST`: API server host, default `127.0.0.1`
- `LANGRENSHA_DATA_DIR`: local config directory, default `data` in the project root
- `LANGRENSHA_ALLOWED_ORIGINS`: allowed frontend origins for the API server
- `LANGRENSHA_BODY_LIMIT_BYTES`: API request body size limit

## Features

- 6-12 player standard progressive Werewolf preset
- Mixed human, AI, and mock seats
- Automatic role assignment with deterministic seeds
- Guard, werewolf, seer, and witch night actions
- Sheriff election, daytime speeches, voting, exile, and win checks
- AI provider, model, reasoning effort, context compression, and cost controls
- AI decision progress tracking for prompt building, provider wait, output repair, completion, and failure
- Normal player view hides roles and private AI details
- Exposure mode for testing, audit logs, and full-game review
- Markdown game log export

## Project Structure

```txt
apps/web              React/Vite frontend
apps/server           Fastify API server
packages/engine       Werewolf rules engine
packages/llm-gateway  Multi-provider LLM adapter layer
packages/prompts      AI prompts
packages/shared       Shared types and rule config
data                  Local AI config directory
```
