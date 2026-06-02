# Changelog

## v0.1.2 - 2026-06-02

- Improved AI prompt boundaries so public reasoning uses visible table information instead of hidden role knowledge.
- Added wolf self-explosion handling for eligible AI responses.
- Expanded public record, claim, vote, and memory context used in AI decisions.
- Refined the web game interface layout and related styling.
- Expanded engine and AI decision tests for the new reasoning and self-explosion behavior.

## v0.1.1 - 2026-05-28

- Improved AI decision handling and LLM gateway provider behavior.
- Expanded server, engine, gateway, and readiness test coverage.
- Updated web client API configuration, provider setup UI, and styling.
- Changed local web/server ports and preview host configuration.

## v0.1.0 - 2026-05-26

- Initial AI Werewolf workspace release.
- Added monorepo packages for shared types, game engine, prompts, and LLM gateway.
- Added Fastify server for game state, AI configuration, and AI decision endpoints.
- Added React/Vite web client for creating and running Werewolf games.
- Added local-only AI provider configuration support with encrypted secrets excluded from Git.
