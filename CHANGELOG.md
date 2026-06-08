# Changelog

## v0.1.5 - 2026-06-08

- Added Chinese and English README files with installation, usage, AI configuration, feature, and project structure notes.
- Aligned root package metadata with the new documentation release version.

## v0.1.4 - 2026-06-08

- Changed real AI failures, cost limits, and context overflow handling to pause with explicit errors instead of silently falling back to mock decisions.
- Added DeepSeek thinking/reasoning controls, larger DeepSeek model context defaults, richer token usage accounting, and clearer LLM HTTP error details.
- Improved guard night actions with optional skip support and standard guard/witch same-target death behavior.
- Refined werewolf sheriff-planning behavior, wolf target selection, and role prompts for stronger public reasoning.
- Updated the web game flow for parallel AI actions, provider reasoning/thinking controls, and expanded human action controls.
- Expanded server, engine, gateway, and AI decision tests for the new AI/runtime behavior.

## v0.1.3 - 2026-06-03

- Added configurable AI context compression defaults and request plumbing.
- Improved AI decision prompt compaction, public reasoning boundaries, and related tests.
- Refined web controls and styling for the AI configuration/game flow.
- Updated engine behavior and tests for the revised AI decision context.
- Upgraded Vitest dependency metadata.

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
