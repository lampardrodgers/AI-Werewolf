import {
  DEFAULT_PERSONAS,
  GameEvent,
  GameSetup,
  LLMCallLog,
  PlayerId,
  PlayerProfile,
  ROLE_DEFINITIONS,
  RoleId,
  RulePreset,
  STANDARD_PRESET,
  createPromptHash
} from "@langrensha/shared";

export type PhaseType =
  | "lobby"
  | "night_guard"
  | "night_wolves"
  | "night_seer"
  | "night_witch"
  | "night_resolve"
  | "sheriff_candidacy"
  | "sheriff_speech"
  | "sheriff_withdrawal"
  | "sheriff_vote"
  | "sheriff_pk_speech"
  | "sheriff_pk_vote"
  | "death_announcement"
  | "last_words"
  | "day_speech"
  | "day_vote"
  | "day_pk_speech"
  | "day_pk_vote"
  | "badge_decision"
  | "hunter_shot"
  | "ended";

export interface PlayerState extends PlayerProfile {
  role: RoleId;
  alive: boolean;
  isSheriff: boolean;
  isSheriffCandidate: boolean;
  hasWithdrawnSheriff: boolean;
  hasVoted: boolean;
  hasActed: boolean;
  death?: {
    day: number;
    phase: string;
    reason: "wolf" | "poison" | "exile" | "hunter" | "self_explosion" | "debug";
  };
}

export interface GamePhase {
  type: PhaseType;
  day: number;
  label: string;
  actingSeatId?: PlayerId;
  progressLabel?: string;
}

export type PendingAction =
  | { kind: "guard_protect"; seatId: PlayerId; legalTargets: PlayerId[] }
  | { kind: "wolf_discussion"; seatId: PlayerId; legalTargets: PlayerId[]; round: number; currentProposal?: PlayerId }
  | { kind: "seer_check"; seatId: PlayerId; legalTargets: PlayerId[] }
  | {
      kind: "witch_action";
      seatId: PlayerId;
      wolfTarget?: PlayerId;
      canSave: boolean;
      canPoison: boolean;
      legalTargets: PlayerId[];
    }
  | { kind: "sheriff_candidacy"; seatId: PlayerId }
  | { kind: "sheriff_withdrawal"; seatId: PlayerId; voteType: "sheriff" | "sheriff_pk" }
  | { kind: "speech"; seatId: PlayerId; speechType: "sheriff" | "last_words" | "day" | "pk" }
  | { kind: "vote"; seatId: PlayerId; voteType: "sheriff" | "sheriff_pk" | "day" | "day_pk"; legalTargets: PlayerId[] }
  | { kind: "badge_decision"; seatId: PlayerId; legalTargets: PlayerId[]; canDestroy: boolean; returnTo: BadgeReturnTo; deathIds: PlayerId[] }
  | { kind: "hunter_shot"; seatId: PlayerId; legalTargets: PlayerId[]; canSkip: boolean };

type VoteAction = Extract<PendingAction, { kind: "vote" }>;
type SpeechAction = Extract<PendingAction, { kind: "speech" }>;
type DeathReason = NonNullable<PlayerState["death"]>["reason"];
type BadgeReturnTo = "after_death_announcement" | "after_day_exile" | "after_hunter_last_words" | "after_hunter_day" | "debug";
type ConfiguredNightStep = RulePreset["nightOrder"][number];

export interface NightState {
  nightNumber: number;
  protectedTarget?: PlayerId;
  wolfTarget?: PlayerId;
  seerCheck?: {
    seerId: PlayerId;
    targetId: PlayerId;
    result: "werewolf" | "good";
  };
  witchSave: boolean;
  witchPoisonTarget?: PlayerId;
  wolfDiscussion?: {
    speakerOrder: PlayerId[];
    currentIndex: number;
    turnCount: number;
    maxTurns: number;
    proposals: Record<PlayerId, PlayerId>;
    agreements: Record<PlayerId, PlayerId>;
    messages: WolfDiscussionMessage[];
    lockedTarget?: PlayerId;
  };
}

export interface WolfDiscussionMessage {
  seatId: PlayerId;
  round: number;
  messageToWolves: string;
  proposedTarget?: PlayerId;
  agreeCurrentProposal: boolean;
  privateReason: string;
}

export interface SheriffState {
  completed: boolean;
  candidacy: Record<PlayerId, { run: boolean; publicSpeech: string; privateReason: string }>;
  candidates: PlayerId[];
  speechQueue: PlayerId[];
  votes: Record<PlayerId, PlayerId | "abstain">;
  pkCandidates: PlayerId[];
  pkVotes: Record<PlayerId, PlayerId | "abstain">;
}

export interface DayState {
  speechQueue: PlayerId[];
  votes: Record<PlayerId, PlayerId | "abstain">;
  pkCandidates: PlayerId[];
  pkSpeechQueue: PlayerId[];
  pkVotes: Record<PlayerId, PlayerId | "abstain">;
}

export interface PlayerResources {
  antidote: boolean;
  poison: boolean;
  hunterCanShoot: boolean;
}

export interface AgentMemory {
  publicTimelineSummary: string;
  privateObservations: string;
  suspicionScores: Record<PlayerId, number>;
  trustScores: Record<PlayerId, number>;
  claimedRoles: Record<PlayerId, string[]>;
  voteHistoryNotes: string;
  contradictions: string[];
  promisesAndCommitments: string[];
  knownFacts: string[];
  privateRoleFacts: string[];
}

export interface AgentMemoryUpdate {
  publicSummaryDelta?: string;
  privateNotes?: string;
  suspicionChanges?: Array<{ playerId: PlayerId; delta: number; reason?: string }>;
  trustChanges?: Array<{ playerId: PlayerId; delta: number; reason?: string }>;
  newClaims?: Array<{ playerId: PlayerId; claim: string }>;
  contradictions?: string[];
  promisesAndCommitments?: string[];
  knownFacts?: string[];
  privateRoleFacts?: string[];
}

export interface GameState {
  id: string;
  setup: GameSetup;
  rulePreset: RulePreset;
  players: PlayerState[];
  phase: GamePhase;
  pendingActions: PendingAction[];
  day: number;
  sheriffSeatId?: PlayerId;
  badgeDestroyed: boolean;
  status: "running" | "ended";
  winner?: "good" | "wolves";
  endReason?: string;
  events: GameEvent[];
  llmCalls: LLMCallLog[];
  resources: Record<PlayerId, PlayerResources>;
  memories: Record<PlayerId, AgentMemory>;
  round: {
    night?: NightState;
    sheriff: SheriffState;
    day?: DayState;
    lastWordsQueue: PlayerId[];
    lastWordsReturn?: "day_speech" | "night";
    lastDeaths: PlayerId[];
    hunterReturn?: "last_words" | "after_day";
    pendingBadgeSeatId?: PlayerId;
  };
}

export type GameCommand =
  | { type: "SubmitNightAction"; seatId: PlayerId; action: "guard_protect" | "seer_check"; targetId: PlayerId; privateReason?: string }
  | {
      type: "SubmitWitchAction";
      seatId: PlayerId;
      save: boolean;
      poisonTargetId?: PlayerId;
      privateReason?: string;
    }
  | {
      type: "SubmitWolfDiscussionMessage";
      seatId: PlayerId;
      messageToWolves: string;
      proposedTargetId?: PlayerId;
      agreeCurrentProposal: boolean;
      privateReason: string;
    }
  | { type: "SubmitSheriffCandidacy"; seatId: PlayerId; runForSheriff: boolean; publicSpeech: string; privateReason: string }
  | { type: "SubmitSheriffWithdrawalDecision"; seatId: PlayerId; withdraw: boolean; privateReason: string }
  | { type: "WithdrawSheriffCandidacy"; seatId: PlayerId; privateReason?: string }
  | { type: "SubmitSpeech"; seatId: PlayerId; text: string; privateReason?: string }
  | { type: "SubmitVote"; seatId: PlayerId; targetId: PlayerId | "abstain"; privateReason: string; confidence?: number }
  | { type: "SubmitBadgeDecision"; seatId: PlayerId; targetId: PlayerId | "destroy"; privateReason?: string }
  | { type: "SubmitHunterShot"; seatId: PlayerId; targetId: PlayerId | "skip"; privateReason: string }
  | { type: "SubmitWolfSelfExplosion"; seatId: PlayerId; privateReason?: string }
  | { type: "ResolveTimeout"; seatId?: PlayerId }
  | { type: "DebugForceKill"; seatId: PlayerId; reason: string };

export interface MockDecision {
  command: GameCommand;
  parsedJson: unknown;
  publicSpeech?: string;
  privateRationale: string;
}

export interface MockBatchRunResult {
  totalGames: number;
  endedGames: number;
  blockedGames: number;
  goodWins: number;
  wolfWins: number;
  maxSteps: number;
  seeds: string[];
  blockedSeeds: string[];
  averageEvents: number;
  averageCalls: number;
}

export interface GameSnapshotFixture {
  version: "langrensha-snapshot-v1";
  createdAt: string;
  gameId: string;
  status: GameState["status"];
  phase: GamePhase;
  setup: GameSetup;
  summary: {
    players: number;
    alivePlayers: number;
    pendingActions: number;
    events: number;
    llmCalls: number;
    winner?: GameState["winner"];
  };
  state: GameState;
}

const AI_NAMES = ["青岚", "观棋", "白石", "夜航", "南枝", "北辰", "听雨", "折光", "云起", "归鸿", "星河", "墨衡"];

export function createGame(setup: GameSetup, preset: RulePreset = STANDARD_PRESET): GameState {
  validateSetup(setup, preset);
  const rng = createRng(setup.seed);
  const roles = shuffle([...preset.roleTable[setup.totalPlayers]], rng);
  const players = roles.map((role, index): PlayerState => {
    const seatNumber = index + 1;
    const isHuman = seatNumber <= setup.humanPlayers;
    const persona = DEFAULT_PERSONAS[index % DEFAULT_PERSONAS.length];
    return {
      id: `player_${seatNumber}`,
      seatNumber,
      name: isHuman ? (setup.humanPlayers === 1 ? "你" : `真人${seatNumber}`) : AI_NAMES[(seatNumber - 1) % AI_NAMES.length],
      avatar: isHuman ? "你" : persona.avatar,
      controller: isHuman ? "human" : "ai",
      personaId: isHuman ? undefined : persona.id,
      role,
      alive: true,
      isSheriff: false,
      isSheriffCandidate: false,
      hasWithdrawnSheriff: false,
      hasVoted: false,
      hasActed: false
    };
  });

  const resources = Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        antidote: player.role === "witch",
        poison: player.role === "witch",
        hunterCanShoot: player.role === "hunter"
      }
    ])
  ) as Record<PlayerId, PlayerResources>;

  const state: GameState = {
    id: `game_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    setup,
    rulePreset: preset,
    players,
    phase: { type: "lobby", day: 0, label: "创建房间" },
    pendingActions: [],
    day: 0,
    badgeDestroyed: false,
    status: "running",
    events: [],
    llmCalls: [],
    resources,
    memories: Object.fromEntries(players.map((player) => [player.id, createInitialMemory(player, players)])),
    round: {
      sheriff: createEmptySheriffState(),
      lastWordsQueue: [],
      lastDeaths: []
    }
  };

  pushEvent(state, "GameStarted", "public", {
    totalPlayers: setup.totalPlayers,
    humanPlayers: setup.humanPlayers,
    aiPlayers: setup.aiPlayers,
    rulePreset: preset.name,
    seed: setup.seed,
    debugMode: setup.debugMode
  });
  for (const player of players) {
    pushEvent(
      state,
      "RoleAssigned",
      player.controller === "human" ? "private" : "admin",
      {
        seatId: player.id,
        seatNumber: player.seatNumber,
        playerName: player.name,
        role: player.role,
        roleName: ROLE_DEFINITIONS[player.role].name
      },
      player.id
    );
  }

  enterNight(state, 0);
  return state;
}

export function applyCommand(input: GameState, command: GameCommand): GameState {
  const state = clone(input);
  if (state.status === "ended" && command.type !== "DebugForceKill") {
    return state;
  }

  switch (command.type) {
    case "SubmitNightAction":
      handleNightAction(state, command);
      break;
    case "SubmitWitchAction":
      handleWitchAction(state, command);
      break;
    case "SubmitWolfDiscussionMessage":
      handleWolfDiscussion(state, command);
      break;
    case "SubmitSheriffCandidacy":
      handleSheriffCandidacy(state, command);
      break;
    case "SubmitSheriffWithdrawalDecision":
      handleSheriffWithdrawalDecision(state, command);
      break;
    case "WithdrawSheriffCandidacy":
      handleSheriffWithdrawal(state, command);
      break;
    case "SubmitSpeech":
      handleSpeech(state, command);
      break;
    case "SubmitVote":
      handleVote(state, command);
      break;
    case "SubmitBadgeDecision":
      handleBadgeDecision(state, command);
      break;
    case "SubmitHunterShot":
      handleHunterShot(state, command);
      break;
    case "SubmitWolfSelfExplosion":
      handleWolfSelfExplosion(state, command);
      break;
    case "ResolveTimeout":
      handleTimeout(state, command.seatId);
      break;
    case "DebugForceKill":
      handleDebugForceKill(state, command);
      break;
  }

  return state;
}

export function createMockDecision(state: GameState): MockDecision | undefined {
  const action = state.pendingActions.find((pending) => getPlayer(state, pending.seatId)?.controller !== "human");
  if (!action) return undefined;

  const player = requirePlayer(state, action.seatId);
  const persona = DEFAULT_PERSONAS.find((item) => item.id === player.personaId) ?? DEFAULT_PERSONAS[0];
  const privateRationale = buildMockRationale(state, player.id);

  switch (action.kind) {
    case "guard_protect": {
      const targetId = chooseGuardTarget(state, action.legalTargets);
      return {
        command: {
          type: "SubmitNightAction",
          seatId: player.id,
          action: "guard_protect",
          targetId,
          privateReason: `守卫优先保护疑似关键好人位，本轮选择${formatSeat(state, targetId)}。`
        },
        parsedJson: { target: targetId, private_reason: privateRationale },
        privateRationale
      };
    }
    case "wolf_discussion": {
      const proposedTargetId = chooseWolfTarget(state, action.legalTargets);
      const agree = !action.currentProposal || action.currentProposal === proposedTargetId || action.round >= 2;
      const messageToWolves = `我建议刀${formatSeat(state, proposedTargetId)}，这个位置白天信息量偏高，留着容易带队。`;
      return {
        command: {
          type: "SubmitWolfDiscussionMessage",
          seatId: player.id,
          messageToWolves,
          proposedTargetId,
          agreeCurrentProposal: agree,
          privateReason: `狼人夜聊优先压制高信息好人位，当前提案是${formatSeat(state, proposedTargetId)}。`
        },
        parsedJson: {
          message_to_wolves: messageToWolves,
          proposed_target: proposedTargetId,
          agree_current_proposal: agree,
          private_reason: privateRationale
        },
        publicSpeech: messageToWolves,
        privateRationale
      };
    }
    case "seer_check": {
      const targetId = chooseSeerTarget(state, player.id, action.legalTargets);
      return {
        command: {
          type: "SubmitNightAction",
          seatId: player.id,
          action: "seer_check",
          targetId,
          privateReason: `预言家优先查验发言和票型不清晰的位置：${formatSeat(state, targetId)}。`
        },
        parsedJson: { check_target: targetId, private_reason: privateRationale },
        privateRationale
      };
    }
    case "witch_action": {
      const save = action.canSave && state.round.night?.nightNumber === 0 && Boolean(action.wolfTarget);
      const poisonTargetId = !save && action.canPoison ? choosePoisonTarget(state, action.legalTargets) : undefined;
      return {
        command: {
          type: "SubmitWitchAction",
          seatId: player.id,
          save,
          poisonTargetId,
          privateReason: save
            ? `首夜有刀口，女巫保守使用解药保护${formatSeat(state, action.wolfTarget)}。`
            : poisonTargetId
              ? `没有使用解药，毒药用于处理高狼面位置${formatSeat(state, poisonTargetId)}。`
              : "本轮女巫选择保留药。"
        },
        parsedJson: { save, poison_target: poisonTargetId ?? null, private_reason: privateRationale },
        privateRationale
      };
    }
    case "sheriff_candidacy": {
      const runForSheriff = shouldRunForSheriff(state, player.id, persona);
      const publicSpeech = runForSheriff
        ? `${persona.catchphrase} 我选择上警，后面正式警上发言再给站边和警徽流。`
        : "我先不上警，警下听发言和票型，再决定站边。";
      return {
        command: {
          type: "SubmitSheriffCandidacy",
          seatId: player.id,
          runForSheriff,
          publicSpeech,
          privateReason: runForSheriff ? "身份或风格适合争警徽并主导白天归票。" : "当前收益不高，保留警下投票信息。"
        },
        parsedJson: { run_for_sheriff: runForSheriff, public_speech: publicSpeech, private_reason: privateRationale },
        publicSpeech,
        privateRationale
      };
    }
    case "sheriff_withdrawal": {
      const withdraw = shouldWithdrawBeforeSheriffVote(state, player.id, action.voteType, persona);
      return {
        command: {
          type: "SubmitSheriffWithdrawalDecision",
          seatId: player.id,
          withdraw,
          privateReason: withdraw ? "听完警上发言后继续竞选收益不足，退水保留警下票型空间。" : "听完警上发言后仍需要保留竞选资格参与警徽归属。"
        },
        parsedJson: {
          run_for_sheriff: !withdraw,
          public_speech: withdraw ? "我退水，警下看票型。" : "我不退水，警徽票继续看发言质量。",
          private_reason: privateRationale
        },
        publicSpeech: withdraw ? "我退水，警下看票型。" : "我不退水，警徽票继续看发言质量。",
        privateRationale
      };
    }
    case "speech": {
      const text = createMockSpeech(state, player.id, action.speechType);
      return {
        command: {
          type: "SubmitSpeech",
          seatId: player.id,
          text,
          privateReason: privateRationale
        },
        parsedJson: {
          stance: "neutral",
          main_claims: [text],
          players_to_pressure: choosePressureTargets(state, player.id).slice(0, 2),
          players_to_protect: [],
          public_speech: text,
          private_reason: privateRationale,
          memory_update: {}
        },
        publicSpeech: text,
        privateRationale
      };
    }
    case "vote": {
      const targetId = chooseVoteTarget(state, player.id, action.legalTargets, action.voteType);
      return {
        command: {
          type: "SubmitVote",
          seatId: player.id,
          targetId,
          privateReason: targetId === "abstain" ? "没有形成稳定多数，选择弃票保留信息。" : `根据当前公开发言和阵营收益，投给${formatSeat(state, targetId)}。`,
          confidence: targetId === "abstain" ? 0.35 : 0.66
        },
        parsedJson: {
          vote_target: targetId,
          private_reason: privateRationale,
          confidence: targetId === "abstain" ? 0.35 : 0.66,
          public_optional_comment: ""
        },
        privateRationale
      };
    }
    case "badge_decision": {
      const targetId = chooseBadgeTarget(state, action.legalTargets);
      return {
        command: {
          type: "SubmitBadgeDecision",
          seatId: player.id,
          targetId,
          privateReason: targetId === "destroy" ? "没有明确可信的移交对象，选择撕毁警徽。" : `警徽移交给当前更适合归票的${formatSeat(state, targetId)}。`
        },
        parsedJson: { target_id: targetId, private_reason: privateRationale },
        privateRationale
      };
    }
    case "hunter_shot": {
      const targetId = chooseHunterTarget(state, action.legalTargets);
      return {
        command: {
          type: "SubmitHunterShot",
          seatId: player.id,
          targetId,
          privateReason: targetId === "skip" ? "没有足够确定的目标，避免误伤。" : `猎人带走当前狼面最高的${formatSeat(state, targetId)}。`
        },
        parsedJson: { shot_target: targetId, private_reason: privateRationale },
        privateRationale
      };
    }
  }
}

export function applyMockStep(state: GameState): GameState {
  const decision = createMockDecision(state);
  if (!decision) return state;
  const next = applyCommand(state, decision.command);
  const seatId = "seatId" in decision.command ? decision.command.seatId : undefined;
  next.llmCalls.push(createMockCallLog(next, decision, seatId));
  return next;
}

export function applyAgentMemoryUpdate(input: GameState, seatId: PlayerId, update: AgentMemoryUpdate | undefined): GameState {
  if (!update) return input;
  const state = clone(input);
  const memory = state.memories[seatId];
  if (!memory) return state;

  if (update.publicSummaryDelta) {
    memory.publicTimelineSummary = appendText(memory.publicTimelineSummary, update.publicSummaryDelta);
  }
  if (update.privateNotes) {
    memory.privateObservations = appendText(memory.privateObservations, update.privateNotes);
  }
  for (const change of update.suspicionChanges ?? []) {
    if (!state.players.some((player) => player.id === change.playerId)) continue;
    memory.suspicionScores[change.playerId] = clampScore((memory.suspicionScores[change.playerId] ?? 50) + change.delta);
    if (change.reason) appendUnique(memory.knownFacts, `${formatSeat(state, change.playerId)} 嫌疑变化 ${change.delta}: ${change.reason}`);
  }
  for (const change of update.trustChanges ?? []) {
    if (!state.players.some((player) => player.id === change.playerId)) continue;
    memory.trustScores[change.playerId] = clampScore((memory.trustScores[change.playerId] ?? 50) + change.delta);
    if (change.reason) appendUnique(memory.knownFacts, `${formatSeat(state, change.playerId)} 信任变化 ${change.delta}: ${change.reason}`);
  }
  for (const claim of update.newClaims ?? []) {
    if (!state.players.some((player) => player.id === claim.playerId)) continue;
    const claims = memory.claimedRoles[claim.playerId] ?? [];
    appendUnique(claims, claim.claim);
    memory.claimedRoles[claim.playerId] = claims;
  }
  for (const item of update.contradictions ?? []) appendUnique(memory.contradictions, item);
  for (const item of update.promisesAndCommitments ?? []) appendUnique(memory.promisesAndCommitments, item);
  for (const item of update.knownFacts ?? []) appendUnique(memory.knownFacts, item);
  for (const item of update.privateRoleFacts ?? []) appendUnique(memory.privateRoleFacts, item);

  pushEvent(state, "AgentMemoryUpdated", "private", { update }, seatId);
  return state;
}

export function runUntilBlocked(state: GameState, maxSteps = 500): GameState {
  let current = state;
  for (let index = 0; index < maxSteps; index += 1) {
    if (current.status === "ended") return current;
    const next = applyMockStep(current);
    if (next === current || JSON.stringify(next.pendingActions) === JSON.stringify(current.pendingActions)) {
      const hasAutomatable = current.pendingActions.some((action) => getPlayer(current, action.seatId)?.controller !== "human");
      if (!hasAutomatable) return current;
    }
    current = next;
  }
  return current;
}

export function runMockBatch(setup: GameSetup, games = 100, maxSteps = 500): MockBatchRunResult {
  const totalGames = Math.max(1, Math.floor(games));
  const seeds: string[] = [];
  const blockedSeeds: string[] = [];
  let endedGames = 0;
  let goodWins = 0;
  let wolfWins = 0;
  let totalEvents = 0;
  let totalCalls = 0;

  for (let index = 0; index < totalGames; index += 1) {
    const seed = `${setup.seed || "batch"}:${index + 1}`;
    seeds.push(seed);
    const game = createGame({
      ...setup,
      humanPlayers: 0,
      aiPlayers: setup.totalPlayers,
      seed
    });
    const finished = runUntilBlocked(game, maxSteps);
    totalEvents += finished.events.length;
    totalCalls += finished.llmCalls.length;
    if (finished.status === "ended") {
      endedGames += 1;
      if (finished.winner === "good") goodWins += 1;
      if (finished.winner === "wolves") wolfWins += 1;
    } else {
      blockedSeeds.push(seed);
    }
  }

  return {
    totalGames,
    endedGames,
    blockedGames: totalGames - endedGames,
    goodWins,
    wolfWins,
    maxSteps,
    seeds,
    blockedSeeds,
    averageEvents: Math.round(totalEvents / totalGames),
    averageCalls: Math.round(totalCalls / totalGames)
  };
}

export function createSnapshotFixture(state: GameState): GameSnapshotFixture {
  return {
    version: "langrensha-snapshot-v1",
    createdAt: new Date().toISOString(),
    gameId: state.id,
    status: state.status,
    phase: clone(state.phase),
    setup: clone(state.setup),
    summary: {
      players: state.players.length,
      alivePlayers: state.players.filter((player) => player.alive).length,
      pendingActions: state.pendingActions.length,
      events: state.events.length,
      llmCalls: state.llmCalls.length,
      winner: state.winner
    },
    state: clone(state)
  };
}

export function restoreSnapshotFixture(value: unknown): GameState {
  if (!isRecord(value) || value.version !== "langrensha-snapshot-v1" || !isRecord(value.state)) {
    throw new Error("无效的测试用例快照。");
  }
  const fixture = value as unknown as GameSnapshotFixture;
  const state = clone(fixture.state);
  if (fixture.gameId !== state.id) {
    throw new Error("快照 gameId 与局面状态不一致。");
  }
  if (!Array.isArray(state.players) || !Array.isArray(state.pendingActions) || !Array.isArray(state.events) || !Array.isArray(state.llmCalls)) {
    throw new Error("快照缺少必要的游戏状态字段。");
  }
  if (state.setup.totalPlayers !== state.players.length) {
    throw new Error("快照人数与玩家列表不一致。");
  }
  if (state.status !== "running" && state.status !== "ended") {
    throw new Error("快照游戏状态非法。");
  }
  return state;
}

export function generateMarkdownLog(state: GameState): string {
  const roleRows = state.players
    .map((player) => `| ${player.seatNumber} | ${player.name} | ${player.controller} | ${player.personaId ?? "-"} | ${ROLE_DEFINITIONS[player.role].name} |`)
    .join("\n");
  const eventRows = state.events
    .map((event) => {
      const actor = event.seatId ? formatSeat(state, event.seatId) : "系统";
      return `- **#${event.seq} ${event.type}** (${event.visibility}, ${actor})：${renderPayload(event.payload)}`;
    })
    .join("\n");
  const tokenRows = state.llmCalls
    .map(
      (call) =>
        `| ${call.seatId ? formatSeat(state, call.seatId) : "-"} | ${call.provider} | ${call.model} | ${call.inputTokens} | ${call.outputTokens} | ${call.reasoningTokens} | ${call.estimatedCost.toFixed(6)} |`
    )
    .join("\n");
  const totalInputTokens = state.llmCalls.reduce((sum, call) => sum + call.inputTokens, 0);
  const totalOutputTokens = state.llmCalls.reduce((sum, call) => sum + call.outputTokens, 0);
  const totalReasoningTokens = state.llmCalls.reduce((sum, call) => sum + call.reasoningTokens, 0);
  const totalCachedTokens = state.llmCalls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const totalEstimatedCost = state.llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);
  const failedCalls = state.llmCalls.filter((call) => call.error).length;
  const totalRetries = state.llmCalls.reduce((sum, call) => sum + call.retryCount, 0);
  const averageCallCost = state.llmCalls.length > 0 ? totalEstimatedCost / state.llmCalls.length : 0;
  const mostExpensiveCall = state.llmCalls.reduce<LLMCallLog | undefined>(
    (current, call) => (!current || call.estimatedCost > current.estimatedCost ? call : current),
    undefined
  );
  const tokenByPlayerRows = renderCallSummaryRows(summarizeCallLogs(state.llmCalls, (call) => (call.seatId ? formatSeat(state, call.seatId) : "-")));
  const tokenByProviderRows = renderCallSummaryRows(summarizeCallLogs(state.llmCalls, (call) => call.provider));
  const tokenByModelRows = renderCallSummaryRows(summarizeCallLogs(state.llmCalls, (call) => `${call.provider} / ${call.model}`));
  const tokenByPhaseRows = renderCallSummaryRows(summarizeCallLogs(state.llmCalls, (call) => call.phase));
  const callRows = state.llmCalls
    .map((call) => {
      const actor = call.seatId ? formatSeat(state, call.seatId) : "-";
      return [
        `### ${call.id} · ${actor} · ${call.phase}`,
        "",
        `- 供应商：${call.provider}`,
        `- 模型：${call.model}`,
        `- Prompt Hash：${call.promptHash}`,
        `- Token：输入 ${call.inputTokens} / 输出 ${call.outputTokens} / 推理 ${call.reasoningTokens} / 缓存 ${call.cachedTokens}`,
        `- 费用估算：${call.estimatedCost.toFixed(6)}`,
        `- 耗时：${call.latencyMs}ms`,
        call.error ? `- 错误：${call.error}` : "- 错误：无",
        call.publicSpeech ? `- 公开内容：${call.publicSpeech}` : "- 公开内容：无",
        call.privateRationale ? `- 后台理由：${call.privateRationale}` : "- 后台理由：无",
        "",
        "<details>",
        "<summary>Prompt</summary>",
        "",
        "```text",
        call.promptTextRedacted,
        "```",
        "</details>",
        "",
        "<details>",
        "<summary>Parsed JSON</summary>",
        "",
        "```json",
        JSON.stringify(call.parsedJson, null, 2),
        "```",
        "</details>",
        "",
        "<details>",
        "<summary>Raw Response</summary>",
        "",
        "```text",
        call.rawResponse,
        "```",
        "</details>"
      ].join("\n");
    })
    .join("\n\n");

  return [
    `# 狼人杀对局记录：${state.id}`,
    "",
    "## 基本信息",
    `- 人数：${state.setup.totalPlayers}`,
    `- 真人：${state.setup.humanPlayers}`,
    `- AI：${state.setup.aiPlayers}`,
    `- 规则包：${state.rulePreset.name}`,
    `- 暴露模式：${state.setup.debugMode.revealRoles ? "开启" : "关闭"}`,
    `- 随机种子：${state.setup.seed}`,
    "",
    "## 身份分配（后台）",
    "| 座位 | 玩家 | 控制器 | AI 角色卡 | 身份 |",
    "|---:|---|---|---|---|",
    roleRows,
    "",
    "## 事件流",
    eventRows || "- 暂无事件",
    "",
    "## Token 统计",
    "### 调用概览",
    `- 调用次数：${state.llmCalls.length}`,
    `- 失败调用：${failedCalls}`,
    `- 重试次数：${totalRetries}`,
    `- 输入 Token：${totalInputTokens}`,
    `- 输出 Token：${totalOutputTokens}`,
    `- 推理 Token：${totalReasoningTokens}`,
    `- 缓存 Token：${totalCachedTokens}`,
    `- 总费用估算：${totalEstimatedCost.toFixed(6)}`,
    `- 平均每次调用费用：${averageCallCost.toFixed(6)}`,
    `- 最贵调用：${mostExpensiveCall ? `${mostExpensiveCall.id} (${mostExpensiveCall.estimatedCost.toFixed(6)})` : "无"}`,
    "",
    "### 调用明细",
    "| AI | 供应商 | 模型 | 输入 | 输出 | 推理 | 费用 |",
    "|---|---|---|---:|---:|---:|---:|",
    tokenRows || "| - | - | - | 0 | 0 | 0 | 0 |",
    "",
    "### 按玩家",
    "| 项目 | 调用 | 失败 | 重试 | 输入 | 输出 | 推理 | 费用 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    tokenByPlayerRows || "| - | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "### 按供应商",
    "| 项目 | 调用 | 失败 | 重试 | 输入 | 输出 | 推理 | 费用 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    tokenByProviderRows || "| - | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "### 按模型",
    "| 项目 | 调用 | 失败 | 重试 | 输入 | 输出 | 推理 | 费用 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    tokenByModelRows || "| - | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "### 按阶段",
    "| 项目 | 调用 | 失败 | 重试 | 输入 | 输出 | 推理 | 费用 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    tokenByPhaseRows || "| - | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "## AI 调用记录",
    callRows || "- 暂无 AI 调用",
    "",
    "## 结局",
    state.status === "ended" ? `${state.winner === "wolves" ? "狼人胜利" : "好人胜利"}：${state.endReason}` : "对局仍在进行"
  ].join("\n");
}

export function getPublicEvents(state: GameState): GameEvent[] {
  return state.events.filter((event) => event.visibility === "public");
}

export function getVisibleEvents(state: GameState, viewerId?: PlayerId): GameEvent[] {
  if (state.setup.debugMode.revealPrivateRationales || state.setup.debugMode.revealRoles) return state.events;
  const visible = getPlayerVisibleEvents(state, viewerId);
  if (!state.setup.debugMode.revealWolfChat) return visible;
  const seen = new Set(visible.map((event) => event.id));
  return state.events.filter((event) => seen.has(event.id) || event.type === "WolfDiscussionMessage");
}

export function getPlayerVisibleEvents(state: GameState, viewerId?: PlayerId): GameEvent[] {
  const viewer = viewerId ? state.players.find((player) => player.id === viewerId) : undefined;
  const isDeadViewer = Boolean(viewer && !viewer.alive);
  const canSeeWolfChat = viewer?.role === "werewolf" || isDeadViewer;
  return state.events.flatMap((event) => {
    const visible =
      event.visibility === "public" ||
      (event.visibility === "private" && viewerId && event.seatId === viewerId) ||
      (canSeeWolfChat && (event.type === "WolfDiscussionMessage" || event.type === "WolfKillLocked")) ||
      (isDeadViewer && isDeadViewerObservableNightEvent(event));
    return visible ? [redactVisibleEventForViewer(event, viewer)] : [];
  });
}

function redactVisibleEventForViewer(event: GameEvent, viewer: PlayerState | undefined): GameEvent {
  if (event.type !== "PhaseStarted" || !isRecord(event.payload) || !shouldRedactPhaseStartedPayload(event.payload, viewer)) {
    return event;
  }
  return {
    ...event,
    payload: {
      phase: "night_hidden",
      day: event.payload.day,
      label: "夜晚行动"
    }
  };
}

function shouldRedactPhaseStartedPayload(payload: Record<string, unknown>, viewer: PlayerState | undefined): boolean {
  if (viewer && !viewer.alive) return false;
  const phase = String(payload.phase ?? "");
  if (!isPrivateNightPhase(phase)) return false;
  const actingSeatId = typeof payload.actingSeatId === "string" ? payload.actingSeatId : undefined;
  if (phase === "night_wolves" && viewer?.role === "werewolf") return false;
  if (viewer && actingSeatId === viewer.id) return false;
  return true;
}

function isDeadViewerObservableNightEvent(event: GameEvent): boolean {
  return [
    "NightActionSubmitted",
    "SeerChecked",
    "WitchActionSubmitted",
    "WolfDiscussionMessage",
    "WolfKillLocked",
    "NightDeathsResolved"
  ].includes(event.type);
}

function isPrivateNightPhase(phase: string): boolean {
  return phase === "night_guard" || phase === "night_wolves" || phase === "night_seer" || phase === "night_witch";
}

function isNightPhaseType(phase: PhaseType): boolean {
  return phase === "night_guard" || phase === "night_wolves" || phase === "night_seer" || phase === "night_witch" || phase === "night_resolve";
}

export function getLegalTargetsForPending(state: GameState, pending: PendingAction): PlayerState[] {
  if (!("legalTargets" in pending)) return [];
  return pending.legalTargets.map((id: PlayerId) => requirePlayer(state, id));
}

export function canWolfSelfExplode(state: GameState, seatId: PlayerId): boolean {
  const player = getPlayer(state, seatId);
  if (state.status !== "running" || !player?.alive || player.role !== "werewolf") return false;
  return state.phase.type !== "lobby" && !isNightPhaseType(state.phase.type);
}

function validateSetup(setup: GameSetup, preset: RulePreset): void {
  if (setup.totalPlayers < preset.minPlayers || setup.totalPlayers > preset.maxPlayers) {
    throw new Error(`总人数必须在 ${preset.minPlayers}-${preset.maxPlayers} 之间。`);
  }
  if (setup.humanPlayers < 0 || setup.humanPlayers > setup.totalPlayers) {
    throw new Error("真人数量必须介于 0 和总人数之间。");
  }
  if (setup.aiPlayers !== setup.totalPlayers - setup.humanPlayers) {
    throw new Error("AI 数量必须等于总人数减真人数量。");
  }
  if (!preset.roleTable[setup.totalPlayers]) {
    throw new Error("当前规则包没有对应人数的身份配置。");
  }
}

function createEmptySheriffState(): SheriffState {
  return {
    completed: false,
    candidacy: {},
    candidates: [],
    speechQueue: [],
    votes: {},
    pkCandidates: [],
    pkVotes: {}
  };
}

function createInitialMemory(player: PlayerState, players: PlayerState[]): AgentMemory {
  const scores = Object.fromEntries(players.map((item) => [item.id, item.id === player.id ? 0 : 50])) as Record<PlayerId, number>;
  return {
    publicTimelineSummary: "游戏刚开始，暂无公开信息。",
    privateObservations: `${ROLE_DEFINITIONS[player.role].name}身份已确认。`,
    suspicionScores: scores,
    trustScores: { ...scores },
    claimedRoles: {},
    voteHistoryNotes: "",
    contradictions: [],
    promisesAndCommitments: [],
    knownFacts: [],
    privateRoleFacts: [ROLE_DEFINITIONS[player.role].privateDescription]
  };
}

function enterNight(state: GameState, nightNumber: number): void {
  state.day = nightNumber;
  state.round.night = {
    nightNumber,
    witchSave: false
  };
  state.round.day = undefined;
  state.round.lastDeaths = [];
  enterNextNightStep(state);
}

function enterNextNightStep(state: GameState, completedStep?: ConfiguredNightStep): void {
  const order = state.rulePreset.nightOrder.length > 0 ? state.rulePreset.nightOrder : STANDARD_PRESET.nightOrder;
  const completedIndex = completedStep ? order.indexOf(completedStep) : -1;
  const nextStep = order.slice(completedIndex + 1)[0] ?? "resolve_deaths";
  enterNightStep(state, nextStep);
}

function enterNightStep(state: GameState, step: ConfiguredNightStep): void {
  const night = requireNight(state);
  clearActionFlags(state);

  if (step === "resolve_deaths") {
    resolveNightDeaths(state);
    return;
  }

  if (step === "guard_protect") {
    const guard = findAliveRole(state, "guard");
    if (!guard) {
      enterNextNightStep(state, "guard_protect");
      return;
    }
    setPhase(state, "night_guard", night.nightNumber, `夜晚 ${night.nightNumber} · 守卫行动`, guard.id);
    state.pendingActions = [{ kind: "guard_protect", seatId: guard.id, legalTargets: aliveIds(state) }];
    return;
  }

  if (step === "wolf_discussion") {
    const wolves = alivePlayers(state).filter((player) => player.role === "werewolf");
    if (wolves.length === 0) {
      enterNextNightStep(state, "wolf_discussion");
      return;
    }
    const rng = createRng(`${state.setup.seed}:night:${night.nightNumber}:wolves`);
    night.wolfDiscussion = {
      speakerOrder: shuffle(
        wolves.map((wolf) => wolf.id),
        rng
      ),
      currentIndex: 0,
      turnCount: 0,
      maxTurns: wolves.length * 3,
      proposals: {},
      agreements: {},
      messages: []
    };
    const firstSpeaker = night.wolfDiscussion.speakerOrder[0];
    setPhase(state, "night_wolves", night.nightNumber, `夜晚 ${night.nightNumber} · 狼人私聊`, firstSpeaker);
    state.pendingActions = [
      {
        kind: "wolf_discussion",
        seatId: firstSpeaker,
        legalTargets: aliveIds(state),
        round: 1
      }
    ];
    return;
  }

  if (step === "seer_check") {
    const seer = findAliveRole(state, "seer");
    if (!seer) {
      enterNextNightStep(state, "seer_check");
      return;
    }
    setPhase(state, "night_seer", night.nightNumber, `夜晚 ${night.nightNumber} · 预言家查验`, seer.id);
    state.pendingActions = [
      {
        kind: "seer_check",
        seatId: seer.id,
        legalTargets: alivePlayers(state)
          .filter((player) => player.id !== seer.id)
          .map((player) => player.id)
      }
    ];
    return;
  }

  if (step === "witch_action") {
    const witch = findAliveRole(state, "witch");
    if (!witch) {
      enterNextNightStep(state, "witch_action");
      return;
    }
    const resource = state.resources[witch.id];
    const canSelfSave = state.rulePreset.witchRules.allowSelfSaveFirstNight || night.nightNumber > 0 || night.wolfTarget !== witch.id;
    setPhase(state, "night_witch", night.nightNumber, `夜晚 ${night.nightNumber} · 女巫行动`, witch.id);
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: night.wolfTarget,
        canSave: resource.antidote && Boolean(night.wolfTarget) && canSelfSave,
        canPoison: resource.poison,
        legalTargets: alivePlayers(state)
          .filter((player) => player.id !== witch.id)
          .map((player) => player.id)
      }
    ];
    return;
  }

  enterNextNightStep(state, step);
}

function handleNightAction(
  state: GameState,
  command: Extract<GameCommand, { type: "SubmitNightAction" }>
): void {
  const pending = findPending(state, command.seatId, command.action);
  if (!pending) return;
  const targetId = ensureLegalTarget(command.targetId, pending.legalTargets);
  const night = requireNight(state);
  const actor = requirePlayer(state, command.seatId);

  if (command.action === "guard_protect") {
    night.protectedTarget = targetId;
    actor.hasActed = true;
    pushEvent(
      state,
      "NightActionSubmitted",
      "private",
      {
        action: "guard_protect",
        targetId
      },
      command.seatId
    );
    pushEvent(
      state,
      "NightActionPrivateReason",
      "admin",
      {
        action: "guard_protect",
        targetId,
        privateReason: command.privateReason ?? ""
      },
      command.seatId
    );
    enterNextNightStep(state, "guard_protect");
    return;
  }

  night.seerCheck = {
    seerId: command.seatId,
    targetId,
    result: requirePlayer(state, targetId).role === "werewolf" ? "werewolf" : "good"
  };
  actor.hasActed = true;
  pushEvent(
    state,
    "SeerChecked",
    "private",
    {
      targetId,
      result: night.seerCheck.result
    },
    command.seatId
  );
  pushEvent(
    state,
    "SeerCheckPrivateReason",
    "admin",
    {
      targetId,
      result: night.seerCheck.result,
      privateReason: command.privateReason ?? ""
    },
    command.seatId
  );
  enterNextNightStep(state, "seer_check");
}

function handleWolfDiscussion(
  state: GameState,
  command: Extract<GameCommand, { type: "SubmitWolfDiscussionMessage" }>
): void {
  const pending = findPending(state, command.seatId, "wolf_discussion");
  const night = requireNight(state);
  const discussion = night.wolfDiscussion;
  if (!pending || !discussion) return;

  const legalTarget = command.proposedTargetId ? ensureLegalTarget(command.proposedTargetId, pending.legalTargets) : undefined;
  const round = Math.floor(discussion.turnCount / Math.max(discussion.speakerOrder.length, 1)) + 1;
  const message: WolfDiscussionMessage = {
    seatId: command.seatId,
    round,
    messageToWolves: command.messageToWolves.trim() || "我暂时没有新的信息，先跟当前刀口。",
    proposedTarget: legalTarget,
    agreeCurrentProposal: command.agreeCurrentProposal,
    privateReason: command.privateReason
  };
  discussion.messages.push(message);
  if (legalTarget) {
    discussion.proposals[command.seatId] = legalTarget;
    if (command.agreeCurrentProposal) {
      discussion.agreements[command.seatId] = legalTarget;
    } else {
      delete discussion.agreements[command.seatId];
    }
  }
  pushEvent(
    state,
    "WolfDiscussionMessage",
    "private",
    {
      seatId: message.seatId,
      round: message.round,
      messageToWolves: message.messageToWolves,
      proposedTarget: message.proposedTarget,
      agreeCurrentProposal: message.agreeCurrentProposal
    },
    command.seatId
  );
  pushEvent(state, "WolfDiscussionPrivateReason", "admin", { privateReason: command.privateReason }, command.seatId);

  const aliveWolfIds = alivePlayers(state)
    .filter((player) => player.role === "werewolf")
    .map((player) => player.id);
  const agreedTargets = aliveWolfIds.map((wolfId) => discussion.agreements[wolfId]).filter(Boolean);
  const allAgree = agreedTargets.length === aliveWolfIds.length && new Set(agreedTargets).size === 1;

  discussion.turnCount += 1;
  if (allAgree || discussion.turnCount >= discussion.maxTurns) {
    const targetId = allAgree ? agreedTargets[0] : chooseByProposalTally(state, discussion.proposals, pending.legalTargets);
    discussion.lockedTarget = targetId;
    night.wolfTarget = targetId;
    pushEvent(
      state,
      "WolfKillLocked",
      "private",
      {
        targetId
      },
      command.seatId
    );
    pushEvent(
      state,
      "WolfKillLockedPrivateReason",
      "admin",
      {
        targetId,
        privateReason: allAgree ? "所有存活狼人同意同一目标" : "三轮讨论后按提案票数结算"
      },
      command.seatId
    );
    enterNextNightStep(state, "wolf_discussion");
    return;
  }

  discussion.currentIndex = (discussion.currentIndex + 1) % discussion.speakerOrder.length;
  const nextSpeaker = discussion.speakerOrder[discussion.currentIndex];
  const nextRound = Math.floor(discussion.turnCount / discussion.speakerOrder.length) + 1;
  setPhase(state, "night_wolves", night.nightNumber, `夜晚 ${night.nightNumber} · 狼人私聊`, nextSpeaker, `第 ${nextRound}/3 轮`);
  state.pendingActions = [
    {
      kind: "wolf_discussion",
      seatId: nextSpeaker,
      legalTargets: pending.legalTargets,
      round: nextRound,
      currentProposal: legalTarget ?? pending.currentProposal
    }
  ];
}

function handleWitchAction(state: GameState, command: Extract<GameCommand, { type: "SubmitWitchAction" }>): void {
  const pending = findPending(state, command.seatId, "witch_action");
  if (!pending) return;
  const night = requireNight(state);
  const resource = state.resources[command.seatId];
  const save = pending.canSave && command.save;
  const poisonTarget = pending.canPoison && command.poisonTargetId ? ensureLegalTarget(command.poisonTargetId, pending.legalTargets) : undefined;
  const finalPoisonTarget = save && !state.rulePreset.witchRules.allowSaveAndPoisonSameNight ? undefined : poisonTarget;

  if (save) resource.antidote = false;
  if (finalPoisonTarget) resource.poison = false;
  night.witchSave = save;
  night.witchPoisonTarget = finalPoisonTarget;

  pushEvent(
    state,
    "WitchActionSubmitted",
    "private",
    {
      wolfTarget: night.wolfTarget,
      save,
      poisonTargetId: finalPoisonTarget
    },
    command.seatId
  );
  pushEvent(
    state,
    "WitchActionPrivateReason",
    "admin",
    {
      wolfTarget: night.wolfTarget,
      save,
      poisonTargetId: finalPoisonTarget,
      privateReason: command.privateReason ?? ""
    },
    command.seatId
  );
  enterNextNightStep(state, "witch_action");
}

function resolveNightDeaths(state: GameState): void {
  const night = requireNight(state);
  setPhase(state, "night_resolve", night.nightNumber, `夜晚 ${night.nightNumber} · 结算死亡`);
  state.pendingActions = [];
  const deaths: PlayerId[] = [];
  const wolfTarget = night.wolfTarget;
  if (wolfTarget) {
    const guarded = night.protectedTarget === wolfTarget;
    const saved = night.witchSave;
    const guardSaveClash = guarded && saved && state.rulePreset.witchRules.guardSaveSameTargetDies;
    if ((!guarded && !saved) || guardSaveClash) {
      deaths.push(wolfTarget);
    }
  }
  if (night.witchPoisonTarget && !deaths.includes(night.witchPoisonTarget)) {
    deaths.push(night.witchPoisonTarget);
  }
  for (const targetId of deaths) {
    markDead(state, targetId, night.witchPoisonTarget === targetId ? "poison" : "wolf");
  }
  state.round.lastDeaths = deaths;
  pushEvent(state, "NightDeathsResolved", "admin", {
    deaths,
    protectedTarget: night.protectedTarget,
    wolfTarget: night.wolfTarget,
    witchSave: night.witchSave,
    witchPoisonTarget: night.witchPoisonTarget
  });

  if (finishIfWon(state)) return;
  if (night.nightNumber === 0 && state.rulePreset.sheriffEnabled && !state.round.sheriff.completed) {
    enterSheriffCandidacy(state);
  } else {
    enterDeathAnnouncement(state);
  }
}

function enterSheriffCandidacy(state: GameState): void {
  setPhase(state, "sheriff_candidacy", state.day, "警长竞选 · 是否上警");
  state.pendingActions = aliveIds(state).map((seatId) => ({ kind: "sheriff_candidacy", seatId }));
}

function handleSheriffCandidacy(
  state: GameState,
  command: Extract<GameCommand, { type: "SubmitSheriffCandidacy" }>
): void {
  if (!state.pendingActions.some((action) => action.kind === "sheriff_candidacy" && action.seatId === command.seatId)) return;
  const player = requirePlayer(state, command.seatId);
  player.isSheriffCandidate = command.runForSheriff;
  state.round.sheriff.candidacy[command.seatId] = {
    run: command.runForSheriff,
    publicSpeech: command.publicSpeech,
    privateReason: command.privateReason
  };
  pushEvent(
    state,
    "SheriffCandidacySubmitted",
    "admin",
    {
      runForSheriff: command.runForSheriff,
      publicSpeech: command.publicSpeech,
      privateReason: command.privateReason
    },
    command.seatId
  );
  state.pendingActions = state.pendingActions.filter((action) => action.seatId !== command.seatId);

  if (state.pendingActions.length > 0) return;
  const candidates = alivePlayers(state)
    .filter((candidate) => state.round.sheriff.candidacy[candidate.id]?.run)
    .map((candidate) => candidate.id);
  state.round.sheriff.candidates = candidates;
  pushEvent(state, "SheriffCandidatesAnnounced", "public", { candidates, speechOrder: orderedSheriffCandidatesForSpeech(state, candidates) });
  if (candidates.length === 0) {
    state.round.sheriff.completed = true;
    pushEvent(state, "SheriffSkipped", "public", { reason: "无人上警" });
    enterDeathAnnouncement(state);
    return;
  }
  if (candidates.length === 1) {
    electSheriff(state, candidates[0], "单人上警自动当选");
    enterDeathAnnouncement(state);
    return;
  }
  enterSheriffSpeech(state, candidates);
}

function handleSheriffWithdrawal(
  state: GameState,
  command: Extract<GameCommand, { type: "WithdrawSheriffCandidacy" }>
): void {
  const player = requirePlayer(state, command.seatId);
  if (!player.isSheriffCandidate || state.phase.type !== "sheriff_speech") return;
  player.hasWithdrawnSheriff = true;
  player.isSheriffCandidate = false;
  state.round.sheriff.candidates = state.round.sheriff.candidates.filter((id) => id !== command.seatId);
  state.round.sheriff.speechQueue = state.round.sheriff.speechQueue.filter((id) => id !== command.seatId);
  pushEvent(state, "SheriffCandidateWithdrawn", "public", {}, command.seatId);

  const candidates = state.round.sheriff.candidates.filter((id) => !requirePlayer(state, id).hasWithdrawnSheriff);
  if (candidates.length === 0) {
    state.round.sheriff.completed = true;
    pushEvent(state, "SheriffSkipped", "public", { reason: "全部候选人退水" });
    enterDeathAnnouncement(state);
    return;
  }
  if (candidates.length === 1) {
    electSheriff(state, candidates[0], "其他候选人退水");
    enterDeathAnnouncement(state);
    return;
  }
  if (state.round.sheriff.speechQueue.length === 0) {
    enterSheriffWithdrawalRound(state, "sheriff", candidates);
    return;
  }
  const current = state.round.sheriff.speechQueue[0];
  setPhase(state, "sheriff_speech", state.day, "警长竞选 · 上警发言", current, `${candidates.length - state.round.sheriff.speechQueue.length + 1}/${candidates.length}`);
  state.pendingActions = [{ kind: "speech", seatId: current, speechType: "sheriff" }];
}

function handleSheriffWithdrawalDecision(
  state: GameState,
  command: Extract<GameCommand, { type: "SubmitSheriffWithdrawalDecision" }>
): void {
  const pending = findPending(state, command.seatId, "sheriff_withdrawal");
  if (!pending) return;
  const player = requirePlayer(state, command.seatId);
  if (command.withdraw && player.isSheriffCandidate && !player.hasWithdrawnSheriff) {
    withdrawSheriffCandidate(state, command.seatId);
  }
  state.pendingActions = state.pendingActions.filter((action) => action.seatId !== command.seatId);
  if (state.pendingActions.length > 0) return;
  resolveSheriffWithdrawalRound(state, pending.voteType);
}

function withdrawSheriffCandidate(state: GameState, seatId: PlayerId): void {
  const player = requirePlayer(state, seatId);
  player.hasWithdrawnSheriff = true;
  player.isSheriffCandidate = false;
  state.round.sheriff.candidates = state.round.sheriff.candidates.filter((id) => id !== seatId);
  state.round.sheriff.pkCandidates = state.round.sheriff.pkCandidates.filter((id) => id !== seatId);
  state.round.sheriff.speechQueue = state.round.sheriff.speechQueue.filter((id) => id !== seatId);
  pushEvent(state, "SheriffCandidateWithdrawn", "public", {}, seatId);
}

function enterSheriffSpeech(state: GameState, candidates: PlayerId[]): void {
  state.round.sheriff.speechQueue = orderedSheriffCandidatesForSpeech(state, candidates);
  const current = state.round.sheriff.speechQueue[0];
  setPhase(state, "sheriff_speech", state.day, "警长竞选 · 上警发言", current, `1/${candidates.length}`);
  state.pendingActions = [{ kind: "speech", seatId: current, speechType: "sheriff" }];
}

function enterSheriffWithdrawalRound(state: GameState, voteType: "sheriff" | "sheriff_pk", candidates: PlayerId[]): void {
  const activeCandidates = candidates.filter((id) => {
    const player = getPlayer(state, id);
    return Boolean(player?.alive && player.isSheriffCandidate && !player.hasWithdrawnSheriff);
  });
  if (activeCandidates.length <= 1) {
    resolveSheriffWithdrawalRound(state, voteType);
    return;
  }
  setPhase(
    state,
    "sheriff_withdrawal",
    state.day,
    voteType === "sheriff" ? "警长竞选 · 退水确认" : "警长竞选 · PK 退水确认"
  );
  state.pendingActions = activeCandidates.map((seatId) => ({ kind: "sheriff_withdrawal", seatId, voteType }));
}

function resolveSheriffWithdrawalRound(state: GameState, voteType: "sheriff" | "sheriff_pk"): void {
  const source = voteType === "sheriff" ? state.round.sheriff.candidates : state.round.sheriff.pkCandidates;
  const candidates = source.filter((id) => {
    const player = getPlayer(state, id);
    return Boolean(player?.alive && player.isSheriffCandidate && !player.hasWithdrawnSheriff);
  });
  if (voteType === "sheriff") state.round.sheriff.candidates = candidates;
  if (voteType === "sheriff_pk") state.round.sheriff.pkCandidates = candidates;
  if (candidates.length === 0) {
    state.round.sheriff.completed = true;
    pushEvent(state, "SheriffSkipped", "public", { reason: "全部候选人退水" });
    enterDeathAnnouncement(state);
    return;
  }
  if (candidates.length === 1) {
    electSheriff(state, candidates[0], "其他候选人退水");
    enterDeathAnnouncement(state);
    return;
  }
  enterSheriffVote(state, voteType, candidates);
}

function enterSheriffVote(state: GameState, voteType: "sheriff" | "sheriff_pk", candidates: PlayerId[]): void {
  const eligible = alivePlayers(state)
    .filter((player) => !candidates.includes(player.id))
    .map((player) => player.id);
  if (eligible.length === 0) {
    electSheriff(state, chooseDeterministic(state, candidates, "sheriff-no-voters"), "无警下投票者，按种子随机当选");
    enterDeathAnnouncement(state);
    return;
  }
  const type = voteType === "sheriff" ? "sheriff_vote" : "sheriff_pk_vote";
  setPhase(state, type, state.day, voteType === "sheriff" ? "警长竞选 · 警下投票" : "警长竞选 · PK 投票");
  if (voteType === "sheriff") state.round.sheriff.votes = {};
  if (voteType === "sheriff_pk") state.round.sheriff.pkVotes = {};
  state.pendingActions = eligible.map((seatId) => ({ kind: "vote", seatId, voteType, legalTargets: candidates }));
}

function electSheriff(state: GameState, seatId: PlayerId, reason: string): void {
  for (const player of state.players) player.isSheriff = player.id === seatId;
  state.sheriffSeatId = seatId;
  state.round.sheriff.completed = true;
  pushEvent(state, "SheriffElected", "public", { sheriffId: seatId, reason });
}

function enterDeathAnnouncement(state: GameState): void {
  setPhase(state, "death_announcement", state.day, state.day === 0 ? "公布昨夜死亡" : `第 ${state.day} 天 · 公布昨夜死亡`);
  state.pendingActions = [];
  pushEvent(state, "NightDeathsAnnounced", "public", { deaths: state.round.lastDeaths });
  const pendingBadgeSeatId = takePendingBadgeSeatId(state);
  if (pendingBadgeSeatId) {
    enterBadgeDecision(state, pendingBadgeSeatId, "after_death_announcement", state.round.lastDeaths);
    return;
  }
  const hunter = findPendingHunter(state, state.round.lastDeaths);
  if (hunter) {
    enterHunterShot(state, hunter, "last_words");
    return;
  }
  enterLastWordsOrDaySpeech(state);
}

function enterLastWordsOrDaySpeech(state: GameState): void {
  state.round.lastWordsReturn = "day_speech";
  state.round.lastWordsQueue = state.round.lastDeaths.filter((id) => {
    const player = getPlayer(state, id);
    return Boolean(player?.death && player.death.day === state.day);
  });
  if (state.round.lastWordsQueue.length === 0) {
    enterDaySpeech(state);
    return;
  }
  const current = state.round.lastWordsQueue[0];
  setPhase(state, "last_words", state.day, "遗言阶段", current, `1/${state.round.lastWordsQueue.length}`);
  state.pendingActions = [{ kind: "speech", seatId: current, speechType: "last_words" }];
}

function enterDayLastWordsOrNight(state: GameState, deathIds: PlayerId[]): void {
  state.round.lastWordsReturn = "night";
  state.round.lastWordsQueue = deathIds.filter((id) => {
    const player = getPlayer(state, id);
    return Boolean(player?.death && player.death.day === state.day);
  });
  if (state.round.lastWordsQueue.length === 0) {
    afterDayDeaths(state);
    return;
  }
  const current = state.round.lastWordsQueue[0];
  setPhase(state, "last_words", state.day, "遗言阶段", current, `1/${state.round.lastWordsQueue.length}`);
  state.pendingActions = [{ kind: "speech", seatId: current, speechType: "last_words" }];
}

function enterDaySpeech(state: GameState): void {
  const queue = orderedAliveForSpeech(state);
  state.round.day = {
    speechQueue: queue,
    votes: {},
    pkCandidates: [],
    pkSpeechQueue: [],
    pkVotes: {}
  };
  if (queue.length === 0) {
    finishIfWon(state);
    return;
  }
  const current = queue[0];
  setPhase(state, "day_speech", state.day, `第 ${state.day + 1} 天 · 白天发言`, current, `1/${queue.length}`);
  state.pendingActions = [{ kind: "speech", seatId: current, speechType: "day" }];
}

function enterDayVote(state: GameState, voteType: "day" | "day_pk", candidates?: PlayerId[]): void {
  const legalTargets = candidates ?? aliveIds(state);
  const eligible = aliveIds(state).filter((id) => !candidates?.includes(id));
  const voters = eligible.length > 0 ? eligible : aliveIds(state);
  setPhase(state, voteType === "day" ? "day_vote" : "day_pk_vote", state.day, voteType === "day" ? "白天投票" : "PK 投票");
  state.pendingActions = voters.map((seatId) => ({ kind: "vote", seatId, voteType, legalTargets: legalTargets.filter((id) => id !== seatId) }));
}

function handleSpeech(state: GameState, command: Extract<GameCommand, { type: "SubmitSpeech" }>): void {
  const pending = findPending(state, command.seatId, "speech");
  if (!pending) return;
  const text = command.text.trim() || "我暂时跳过发言。";
  pushEvent(
    state,
    pending.speechType === "last_words" ? "LastWordsPublished" : "SpeechPublished",
    "public",
    {
      speechType: pending.speechType,
      text
    },
    command.seatId
  );

  if (state.phase.type === "sheriff_speech") {
    state.round.sheriff.speechQueue.shift();
    const queue = state.round.sheriff.speechQueue;
    if (queue.length === 0) {
      const candidates = state.round.sheriff.candidates.filter((id) => !requirePlayer(state, id).hasWithdrawnSheriff);
      if (candidates.length === 1) {
        electSheriff(state, candidates[0], "其他候选人退水");
        enterDeathAnnouncement(state);
      } else {
        enterSheriffWithdrawalRound(state, "sheriff", candidates);
      }
      return;
    }
    const current = queue[0];
    const total = state.round.sheriff.candidates.length;
    setPhase(state, "sheriff_speech", state.day, "警长竞选 · 上警发言", current, `${total - queue.length + 1}/${total}`);
    state.pendingActions = [{ kind: "speech", seatId: current, speechType: "sheriff" }];
    return;
  }

  if (state.phase.type === "sheriff_pk_speech") {
    state.round.sheriff.speechQueue.shift();
    const queue = state.round.sheriff.speechQueue;
    if (queue.length === 0) {
      enterSheriffWithdrawalRound(state, "sheriff_pk", state.round.sheriff.pkCandidates);
      return;
    }
    setPhase(state, "sheriff_pk_speech", state.day, "警长竞选 · PK 发言", queue[0]);
    state.pendingActions = [{ kind: "speech", seatId: queue[0], speechType: "pk" }];
    return;
  }

  if (state.phase.type === "last_words") {
    state.round.lastWordsQueue.shift();
    if (state.round.lastWordsQueue.length === 0) {
      const returnTo = state.round.lastWordsReturn ?? "day_speech";
      state.round.lastWordsReturn = undefined;
      if (returnTo === "night") {
        afterDayDeaths(state);
      } else {
        enterDaySpeech(state);
      }
      return;
    }
    const current = state.round.lastWordsQueue[0];
    setPhase(state, "last_words", state.day, "遗言阶段", current);
    state.pendingActions = [{ kind: "speech", seatId: current, speechType: "last_words" }];
    return;
  }

  if (state.phase.type === "day_speech") {
    const day = requireDay(state);
    day.speechQueue.shift();
    if (day.speechQueue.length === 0) {
      enterDayVote(state, "day");
      return;
    }
    const total = aliveIds(state).length;
    const current = day.speechQueue[0];
    setPhase(state, "day_speech", state.day, `第 ${state.day + 1} 天 · 白天发言`, current, `${total - day.speechQueue.length + 1}/${total}`);
    state.pendingActions = [{ kind: "speech", seatId: current, speechType: "day" }];
    return;
  }

  if (state.phase.type === "day_pk_speech") {
    const day = requireDay(state);
    day.pkSpeechQueue.shift();
    if (day.pkSpeechQueue.length === 0) {
      enterDayVote(state, "day_pk", day.pkCandidates);
      return;
    }
    setPhase(state, "day_pk_speech", state.day, "放逐 PK 发言", day.pkSpeechQueue[0]);
    state.pendingActions = [{ kind: "speech", seatId: day.pkSpeechQueue[0], speechType: "pk" }];
  }
}

function handleVote(state: GameState, command: Extract<GameCommand, { type: "SubmitVote" }>): void {
  const pending = findPending(state, command.seatId, "vote");
  if (!pending) return;
  if (command.targetId === command.seatId) {
    throw new Error("不能投票给自己");
  }
  const targetId = command.targetId === "abstain" ? "abstain" : ensureLegalTarget(command.targetId, pending.legalTargets);
  if (targetId === "abstain" && !state.rulePreset.voteRules.allowAbstain) {
    throw new Error("当前规则不允许弃票");
  }
  pushEvent(
    state,
    "VoteCast",
    "admin",
    {
      voteType: pending.voteType,
      targetId,
      privateReason: command.privateReason,
      confidence: command.confidence ?? 0.5
    },
    command.seatId
  );
  if (pending.voteType === "sheriff") state.round.sheriff.votes[command.seatId] = targetId;
  if (pending.voteType === "sheriff_pk") state.round.sheriff.pkVotes[command.seatId] = targetId;
  if (pending.voteType === "day") requireDay(state).votes[command.seatId] = targetId;
  if (pending.voteType === "day_pk") requireDay(state).pkVotes[command.seatId] = targetId;
  state.pendingActions = state.pendingActions.filter((action) => action.seatId !== command.seatId);
  if (state.pendingActions.length > 0) return;

  if (pending.voteType === "sheriff" || pending.voteType === "sheriff_pk") {
    resolveSheriffVote(state, pending.voteType);
    return;
  }
  resolveDayVote(state, pending.voteType);
}

function resolveSheriffVote(state: GameState, voteType: "sheriff" | "sheriff_pk"): void {
  const votes = voteType === "sheriff" ? state.round.sheriff.votes : state.round.sheriff.pkVotes;
  const candidates = voteType === "sheriff" ? state.round.sheriff.candidates : state.round.sheriff.pkCandidates;
  const result = tallyVotes(state, votes, candidates, false);
  pushEvent(state, "SheriffVoteResolved", "public", { voteType, votes, tally: result.tally, top: result.top });
  if (result.top.length === 1) {
    electSheriff(state, result.top[0], "投票最高");
    enterDeathAnnouncement(state);
    return;
  }
  if (voteType === "sheriff") {
    state.round.sheriff.pkCandidates = result.top;
    state.round.sheriff.speechQueue = orderedSheriffCandidatesForSpeech(state, result.top);
    const current = state.round.sheriff.speechQueue[0];
    setPhase(state, "sheriff_pk_speech", state.day, "警长竞选 · PK 发言", current);
    state.pendingActions = [{ kind: "speech", seatId: current, speechType: "pk" }];
    return;
  }
  if (state.rulePreset.voteRules.secondTiePolicy === "random") {
    const winner = chooseDeterministic(state, result.top, "sheriff-pk-second-tie");
    electSheriff(state, winner, "PK 后仍然平票，按种子随机当选");
    enterDeathAnnouncement(state);
    return;
  }
  state.round.sheriff.completed = true;
  pushEvent(state, "SheriffSkipped", "public", { reason: "PK 后仍然平票，本局无警长" });
  enterDeathAnnouncement(state);
}

function resolveDayVote(state: GameState, voteType: "day" | "day_pk"): void {
  const day = requireDay(state);
  const votes = voteType === "day" ? day.votes : day.pkVotes;
  const candidates = voteType === "day" ? aliveIds(state) : day.pkCandidates;
  const result = tallyVotes(state, votes, candidates, true);
  pushEvent(state, "DayVoteResolved", "public", { voteType, votes, tally: result.tally, top: result.top });
  if (result.top.length === 1) {
    exilePlayer(state, result.top[0]);
    return;
  }
  if (voteType === "day") {
    day.pkCandidates = result.top;
    day.pkSpeechQueue = [...result.top];
    setPhase(state, "day_pk_speech", state.day, "放逐 PK 发言", result.top[0]);
    state.pendingActions = [{ kind: "speech", seatId: result.top[0], speechType: "pk" }];
    return;
  }
  if (state.rulePreset.voteRules.secondTiePolicy === "random") {
    const targetId = chooseDeterministic(state, result.top, "day-pk-second-tie");
    exilePlayer(state, targetId);
    return;
  }
  pushEvent(state, "NoExile", "public", { reason: "PK 后仍然平票，当天无人出局" });
  afterDayDeaths(state);
}

function exilePlayer(state: GameState, targetId: PlayerId): void {
  markDead(state, targetId, "exile");
  state.round.lastDeaths = [targetId];
  pushEvent(state, "PlayerExiled", "public", { targetId });
  if (finishIfWon(state)) return;
  const pendingBadgeSeatId = takePendingBadgeSeatId(state, targetId);
  if (pendingBadgeSeatId) {
    enterBadgeDecision(state, pendingBadgeSeatId, "after_day_exile", [targetId]);
    return;
  }
  const hunter = findPendingHunter(state, [targetId]);
  if (hunter) {
    enterHunterShot(state, hunter, "after_day");
    return;
  }
  enterDayLastWordsOrNight(state, [targetId]);
}

function enterHunterShot(state: GameState, hunterId: PlayerId, returnTo: "last_words" | "after_day"): void {
  state.round.hunterReturn = returnTo;
  const legalTargets = aliveIds(state).filter((id) => id !== hunterId);
  setPhase(state, "hunter_shot", state.day, "猎人开枪", hunterId);
  state.pendingActions = [{ kind: "hunter_shot", seatId: hunterId, legalTargets, canSkip: true }];
}

function enterBadgeDecision(state: GameState, sheriffId: PlayerId, returnTo: BadgeReturnTo, deathIds: PlayerId[]): void {
  const legalTargets = aliveIds(state);
  if (legalTargets.length === 0) {
    destroyBadge(state, sheriffId, "警长死亡时没有可移交的存活玩家。");
    resumeAfterBadgeDecision(state, { returnTo, deathIds });
    return;
  }
  setPhase(state, "badge_decision", state.day, "警长死亡 · 移交警徽", sheriffId);
  state.pendingActions = [{ kind: "badge_decision", seatId: sheriffId, legalTargets, canDestroy: true, returnTo, deathIds }];
}

function handleBadgeDecision(
  state: GameState,
  command: Extract<GameCommand, { type: "SubmitBadgeDecision" }>
): void {
  const pending = findPending(state, command.seatId, "badge_decision");
  if (!pending) return;
  if (command.targetId === "destroy") {
    destroyBadge(state, command.seatId, command.privateReason ?? "警长选择撕毁警徽。");
  } else {
    const targetId = ensureLegalTarget(command.targetId, pending.legalTargets);
    for (const player of state.players) player.isSheriff = player.id === targetId;
    state.sheriffSeatId = targetId;
    state.badgeDestroyed = false;
    pushEvent(state, "BadgePassed", "public", { fromSeatId: command.seatId, toSeatId: targetId }, command.seatId);
    pushEvent(
      state,
      "BadgeDecisionPrivateReason",
      "admin",
      { action: "pass", targetId, privateReason: command.privateReason ?? "" },
      command.seatId
    );
  }
  state.pendingActions = [];
  resumeAfterBadgeDecision(state, pending);
}

function handleHunterShot(state: GameState, command: Extract<GameCommand, { type: "SubmitHunterShot" }>): void {
  const pending = findPending(state, command.seatId, "hunter_shot");
  if (!pending) return;
  state.resources[command.seatId].hunterCanShoot = false;
  let shotDeathId: PlayerId | undefined;
  if (command.targetId !== "skip" && pending.legalTargets.includes(command.targetId)) {
    markDead(state, command.targetId, "hunter");
    shotDeathId = command.targetId;
    pushEvent(
      state,
      "HunterShotResolved",
      "public",
      {
        targetId: command.targetId
      },
      command.seatId
    );
  } else {
    pushEvent(state, "HunterShotSkipped", "public", {}, command.seatId);
  }
  state.pendingActions = [];
  if (finishIfWon(state)) return;
  const pendingBadgeSeatId = takePendingBadgeSeatId(state, shotDeathId);
  if (pendingBadgeSeatId) {
    enterBadgeDecision(
      state,
      pendingBadgeSeatId,
      state.round.hunterReturn === "last_words" ? "after_hunter_last_words" : "after_hunter_day",
      shotDeathId ? [shotDeathId] : []
    );
    return;
  }
  if (state.round.hunterReturn === "last_words") {
    enterLastWordsOrDaySpeech(state);
  } else {
    enterDayLastWordsOrNight(state, [command.seatId]);
  }
}

function afterDayDeaths(state: GameState): void {
  if (finishIfWon(state)) return;
  enterNight(state, state.day + 1);
}

function handleWolfSelfExplosion(state: GameState, command: Extract<GameCommand, { type: "SubmitWolfSelfExplosion" }>): void {
  if (!canWolfSelfExplode(state, command.seatId)) return;

  pushEvent(state, "WolfSelfExploded", "public", { seatId: command.seatId }, command.seatId);
  markDead(state, command.seatId, "self_explosion");
  pushEvent(state, "WolfSelfExplosionPrivateReason", "admin", { privateReason: command.privateReason ?? "" }, command.seatId);

  const pendingBadgeSeatId = takePendingBadgeSeatId(state, command.seatId);
  if (pendingBadgeSeatId) {
    destroyBadge(state, pendingBadgeSeatId, "狼人自爆后直接进入夜晚，警徽自动撕毁。");
  }

  state.pendingActions = [];
  state.round.lastDeaths = [command.seatId];
  if (finishIfWon(state)) return;
  enterNight(state, state.day + 1);
}

function handleDebugForceKill(state: GameState, command: Extract<GameCommand, { type: "DebugForceKill" }>): void {
  if (!state.setup.debugMode.allowManualOverride) return;
  markDead(state, command.seatId, "debug");
  pushEvent(state, "DebugForceKill", "admin", { targetId: command.seatId, reason: command.reason });
  if (finishIfWon(state)) return;
  const pendingBadgeSeatId = takePendingBadgeSeatId(state, command.seatId);
  if (pendingBadgeSeatId) {
    enterBadgeDecision(state, pendingBadgeSeatId, "debug", [command.seatId]);
  }
}

function handleTimeout(state: GameState, seatId?: PlayerId): void {
  const pending = seatId ? state.pendingActions.find((action) => action.seatId === seatId) : state.pendingActions[0];
  if (!pending) return;
  if (pending.kind === "speech") {
    handleSpeech(state, { type: "SubmitSpeech", seatId: pending.seatId, text: "时间到，跳过发言。", privateReason: "超时兜底" });
    return;
  }
  if (pending.kind === "vote") {
    const fallbackTargets = pending.legalTargets.filter((id) => id !== pending.seatId);
    const targetId = state.rulePreset.voteRules.allowAbstain ? "abstain" : fallbackTargets[0];
    if (!targetId) return;
    handleVote(state, {
      type: "SubmitVote",
      seatId: pending.seatId,
      targetId,
      privateReason: targetId === "abstain" ? "超时自动弃票" : "超时自动投给默认合法目标",
      confidence: 0
    });
    return;
  }
  if (pending.kind === "badge_decision") {
    handleBadgeDecision(state, { type: "SubmitBadgeDecision", seatId: pending.seatId, targetId: "destroy", privateReason: "超时自动撕毁警徽。" });
    return;
  }
  if (pending.kind === "sheriff_withdrawal") {
    handleSheriffWithdrawalDecision(state, {
      type: "SubmitSheriffWithdrawalDecision",
      seatId: pending.seatId,
      withdraw: false,
      privateReason: "超时默认继续留警。"
    });
    return;
  }
  const decision = createMockDecision(state);
  if (decision) {
    const next = applyCommand(state, decision.command);
    Object.assign(state, next);
  }
}

function tallyVotes(
  state: GameState,
  votes: Record<PlayerId, PlayerId | "abstain">,
  candidates: PlayerId[],
  useSheriffWeight: boolean
): { tally: Record<PlayerId, number>; top: PlayerId[] } {
  const tally = Object.fromEntries(candidates.map((id) => [id, 0])) as Record<PlayerId, number>;
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (targetId === "abstain" || !candidates.includes(targetId)) continue;
    const weight = useSheriffWeight && state.sheriffSeatId === voterId ? state.rulePreset.voteRules.sheriffVoteWeight : 1;
    tally[targetId] = (tally[targetId] ?? 0) + weight;
  }
  const max = Math.max(...Object.values(tally), 0);
  return {
    tally,
    top: candidates.filter((candidate) => tally[candidate] === max)
  };
}

function markDead(state: GameState, targetId: PlayerId, reason: DeathReason): void {
  const player = requirePlayer(state, targetId);
  if (!player.alive) return;
  player.alive = false;
  player.isSheriffCandidate = false;
  player.hasVoted = false;
  player.hasActed = false;
  player.death = { day: state.day, phase: state.phase.type, reason };
  if (player.isSheriff) {
    player.isSheriff = false;
    state.sheriffSeatId = undefined;
    state.round.pendingBadgeSeatId = targetId;
    pushEvent(state, "BadgeDecisionPending", "public", { seatId: targetId });
  }
  if (reason === "debug") {
    pushEvent(state, "PlayerKilled", "admin", { targetId, reason });
  } else {
    if (reason === "wolf" || reason === "poison") {
      pushEvent(state, "PlayerKilled", "public", { targetId });
    }
    pushEvent(state, "PlayerDeathCauseRecorded", "admin", { targetId, reason });
  }
}

function takePendingBadgeSeatId(state: GameState, expectedSeatId?: PlayerId): PlayerId | undefined {
  const seatId = state.round.pendingBadgeSeatId;
  if (!seatId) return undefined;
  if (expectedSeatId && seatId !== expectedSeatId) return undefined;
  state.round.pendingBadgeSeatId = undefined;
  return seatId;
}

function destroyBadge(state: GameState, seatId: PlayerId, privateReason: string): void {
  for (const player of state.players) player.isSheriff = false;
  state.sheriffSeatId = undefined;
  state.badgeDestroyed = true;
  pushEvent(state, "BadgeDestroyed", "public", { seatId });
  pushEvent(state, "BadgeDecisionPrivateReason", "admin", { action: "destroy", privateReason }, seatId);
}

function resumeAfterBadgeDecision(
  state: GameState,
  pending: Pick<Extract<PendingAction, { kind: "badge_decision" }>, "returnTo" | "deathIds">
): void {
  if (pending.returnTo === "after_death_announcement") {
    const hunter = findPendingHunter(state, pending.deathIds);
    if (hunter) {
      enterHunterShot(state, hunter, "last_words");
      return;
    }
    enterLastWordsOrDaySpeech(state);
    return;
  }
  if (pending.returnTo === "after_day_exile") {
    const hunter = findPendingHunter(state, pending.deathIds);
    if (hunter) {
      enterHunterShot(state, hunter, "after_day");
      return;
    }
    enterDayLastWordsOrNight(state, pending.deathIds);
    return;
  }
  if (pending.returnTo === "after_hunter_last_words") {
    enterLastWordsOrDaySpeech(state);
    return;
  }
  if (pending.returnTo === "after_hunter_day") {
    enterDayLastWordsOrNight(state, pending.deathIds);
  }
}

function findPendingHunter(state: GameState, deaths: PlayerId[]): PlayerId | undefined {
  return deaths.find((id) => {
    const player = getPlayer(state, id);
    if (!player || player.role !== "hunter") return false;
    if (player.death?.reason === "poison" && !state.rulePreset.witchRules.poisonedHunterCanShoot) return false;
    return state.resources[id]?.hunterCanShoot;
  });
}

function finishIfWon(state: GameState): boolean {
  const alive = alivePlayers(state);
  const wolves = alive.filter((player) => player.role === "werewolf").length;
  const gods = alive.filter((player) => ROLE_DEFINITIONS[player.role].category === "god").length;
  const villagers = alive.filter((player) => player.role === "villager").length;
  const good = alive.length - wolves;

  if (wolves === 0) {
    endGame(state, "good", "所有狼人死亡");
    return true;
  }
  if (state.rulePreset.winCondition === "slay_all_good" && good === 0) {
    endGame(state, "wolves", "所有好人死亡");
    return true;
  }
  if (state.rulePreset.winCondition === "slay_side" && (gods === 0 || villagers === 0)) {
    endGame(state, "wolves", gods === 0 ? "所有神职死亡" : "所有平民死亡");
    return true;
  }
  return false;
}

function endGame(state: GameState, winner: "good" | "wolves", reason: string): void {
  state.status = "ended";
  state.winner = winner;
  state.endReason = reason;
  state.pendingActions = [];
  setPhase(state, "ended", state.day, winner === "wolves" ? "狼人胜利" : "好人胜利");
  pushEvent(state, "GameEnded", "public", { winner, reason });
}

function setPhase(state: GameState, type: PhaseType, day: number, label: string, actingSeatId?: PlayerId, progressLabel?: string): void {
  state.phase = { type, day, label, actingSeatId, progressLabel };
  pushEvent(state, "PhaseStarted", "public", { phase: type, day, label, actingSeatId, progressLabel });
}

function clearActionFlags(state: GameState): void {
  for (const player of state.players) {
    player.hasActed = false;
    player.hasVoted = false;
  }
}

function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.alive);
}

function aliveIds(state: GameState): PlayerId[] {
  return alivePlayers(state).map((player) => player.id);
}

function findAliveRole(state: GameState, role: RoleId): PlayerState | undefined {
  return alivePlayers(state).find((player) => player.role === role);
}

function orderedAliveForSpeech(state: GameState): PlayerId[] {
  const ids = alivePlayers(state)
    .sort((a, b) => a.seatNumber - b.seatNumber)
    .map((player) => player.id);
  if (ids.length <= 1) return ids;
  if (!state.sheriffSeatId || !ids.includes(state.sheriffSeatId)) {
    return rotateSeatOrder(state, ids, `day:${state.day}:no-sheriff`);
  }
  const sheriffIndex = ids.indexOf(state.sheriffSeatId);
  const clockwise = chooseSpeechDirection(state, `day:${state.day}:sheriff:${state.sheriffSeatId}`);
  const ordered: PlayerId[] = [];
  for (let offset = 1; offset < ids.length; offset += 1) {
    const index = clockwise ? (sheriffIndex + offset) % ids.length : (sheriffIndex - offset + ids.length) % ids.length;
    ordered.push(ids[index]);
  }
  ordered.push(state.sheriffSeatId);
  return ordered;
}

function requireNight(state: GameState): NightState {
  if (!state.round.night) throw new Error("当前没有夜晚状态。");
  return state.round.night;
}

function requireDay(state: GameState): DayState {
  if (!state.round.day) throw new Error("当前没有白天状态。");
  return state.round.day;
}

function getPlayer(state: GameState, id: PlayerId): PlayerState | undefined {
  return state.players.find((player) => player.id === id);
}

function requirePlayer(state: GameState, id: PlayerId): PlayerState {
  const player = getPlayer(state, id);
  if (!player) throw new Error(`找不到玩家 ${id}`);
  return player;
}

function findPending<K extends PendingAction["kind"]>(
  state: GameState,
  seatId: PlayerId,
  kind: K
): Extract<PendingAction, { kind: K }> | undefined {
  return state.pendingActions.find(
    (action): action is Extract<PendingAction, { kind: K }> => action.seatId === seatId && action.kind === kind
  );
}

function ensureLegalTarget(targetId: PlayerId, legalTargets: PlayerId[]): PlayerId {
  if (!legalTargets.includes(targetId)) {
    throw new Error(`非法目标 ${targetId}，合法目标：${legalTargets.join(", ")}`);
  }
  return targetId;
}

function chooseByProposalTally(state: GameState, proposals: Record<PlayerId, PlayerId>, legalTargets: PlayerId[]): PlayerId {
  const tally = new Map<PlayerId, number>();
  for (const target of Object.values(proposals)) {
    if (legalTargets.includes(target)) tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  const max = Math.max(0, ...tally.values());
  const top = [...tally.entries()].filter(([, count]) => count === max).map(([id]) => id);
  return top.length > 0 ? chooseDeterministic(state, top, "wolf-proposal-tie") : chooseDeterministic(state, legalTargets, "wolf-no-proposal");
}

function chooseDeterministic<T>(state: GameState, items: T[], salt: string): T {
  const rng = createRng(`${state.setup.seed}:${state.day}:${state.events.length}:${salt}`);
  return items[Math.floor(rng() * items.length)];
}

function orderedSheriffCandidatesForSpeech(state: GameState, candidates: PlayerId[]): PlayerId[] {
  const sorted = [...candidates].sort((left, right) => requirePlayer(state, left).seatNumber - requirePlayer(state, right).seatNumber);
  return rotateSeatOrder(state, sorted, `sheriff:${state.day}:${state.id}`);
}

function rotateSeatOrder(state: GameState, ids: PlayerId[], salt: string): PlayerId[] {
  if (ids.length <= 1) return [...ids];
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${salt}`);
  const clockwise = rng() >= 0.5;
  const ordered = clockwise ? [...ids] : [...ids].reverse();
  const startIndex = Math.floor(rng() * ordered.length);
  return [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)];
}

function chooseSpeechDirection(state: GameState, salt: string): boolean {
  return createRng(`${state.setup.seed}:${state.id}:${state.day}:${salt}`)() >= 0.5;
}

function chooseGuardTarget(state: GameState, legalTargets: PlayerId[]): PlayerId {
  return choosePublicAttentionTarget(state, legalTargets, "guard") ?? legalTargets[0];
}

function chooseWolfTarget(state: GameState, legalTargets: PlayerId[]): PlayerId {
  return choosePublicAttentionTarget(state, legalTargets, "wolf-target") ?? legalTargets[0];
}

function chooseSeerTarget(state: GameState, seerId: PlayerId, legalTargets: PlayerId[]): PlayerId {
  const checked = state.events
    .filter((event) => event.type === "SeerChecked" && event.seatId === seerId)
    .map((event) => String((event.payload as { targetId?: string }).targetId));
  const unchecked = legalTargets.filter((id) => !checked.includes(id));
  return chooseDeterministic(state, unchecked.length > 0 ? unchecked : legalTargets, "seer");
}

function choosePoisonTarget(state: GameState, legalTargets: PlayerId[]): PlayerId | undefined {
  if (state.day <= 1) return undefined;
  return choosePublicSuspicionTarget(state, legalTargets, "witch-poison", 3);
}

function choosePressureTargets(state: GameState, selfId: PlayerId): PlayerId[] {
  const self = requirePlayer(state, selfId);
  if (self.role === "werewolf") {
    const teammates = knownWolfTeammates(state, selfId);
    return aliveIds(state).filter((id) => id !== selfId && !teammates.includes(id));
  }
  return aliveIds(state).filter((id) => id !== selfId);
}

function chooseVoteTarget(state: GameState, voterId: PlayerId, legalTargets: PlayerId[], voteType: VoteAction["voteType"]): PlayerId | "abstain" {
  const voter = requirePlayer(state, voterId);
  const targetPool = legalTargets.filter((id) => id !== voterId);
  if (targetPool.length === 0) return state.rulePreset.voteRules.allowAbstain ? "abstain" : legalTargets[0];
  if (voteType === "sheriff" || voteType === "sheriff_pk") {
    return chooseSheriffVoteTarget(state, voterId, targetPool);
  }
  if (voter.role === "werewolf") {
    const teammates = knownWolfTeammates(state, voterId);
    const preferred = choosePublicSuspicionTarget(state, targetPool.filter((id) => !teammates.includes(id)), `${voterId}:wolf-vote`, 1);
    return preferred ?? chooseDeterministic(state, targetPool, `${voterId}:wolf-vote`);
  }
  return choosePublicSuspicionTarget(state, targetPool, `${voterId}:good-vote`, 1) ?? chooseDeterministic(state, targetPool, `${voterId}:good-vote`);
}

function chooseHunterTarget(state: GameState, legalTargets: PlayerId[]): PlayerId | "skip" {
  return choosePublicSuspicionTarget(state, legalTargets, "hunter-shot", 2) ?? "skip";
}

function chooseBadgeTarget(state: GameState, legalTargets: PlayerId[]): PlayerId | "destroy" {
  return choosePublicAttentionTarget(state, legalTargets, "badge-pass") ?? legalTargets[0] ?? "destroy";
}

function shouldRunForSheriff(state: GameState, seatId: PlayerId, persona: (typeof DEFAULT_PERSONAS)[number]): boolean {
  const player = requirePlayer(state, seatId);
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${seatId}:sheriff-candidacy`);
  if (player.role === "seer") return rng() < 0.9;
  if (player.role === "werewolf") {
    const aliveWolves = alivePlayers(state)
      .filter((item) => item.role === "werewolf")
      .map((item) => item.id);
    const designatedBluffer = chooseDeterministic(state, aliveWolves, "wolf-sheriff-bluffer");
    const pressure = (persona.claimTendency + persona.deceptionSkill + persona.riskTolerance) / 300;
    return seatId === designatedBluffer || rng() < 0.2 + pressure * 0.45;
  }
  const roleBase: Record<RoleId, number> = {
    werewolf: 0,
    seer: 0.9,
    witch: 0.18,
    hunter: 0.22,
    guard: 0.12,
    villager: 0.1
  };
  const style = (persona.aggression + persona.voteIndependence - persona.conservatism) / 300;
  return rng() < Math.max(0.04, roleBase[player.role] + style * 0.18);
}

function shouldWithdrawBeforeSheriffVote(
  state: GameState,
  seatId: PlayerId,
  voteType: "sheriff" | "sheriff_pk",
  persona: (typeof DEFAULT_PERSONAS)[number]
): boolean {
  const player = requirePlayer(state, seatId);
  const candidates = (voteType === "sheriff" ? state.round.sheriff.candidates : state.round.sheriff.pkCandidates).filter((id) => {
    const candidate = getPlayer(state, id);
    return Boolean(candidate?.alive && candidate.isSheriffCandidate && !candidate.hasWithdrawnSheriff);
  });
  if (candidates.length <= 2 || player.role === "seer") return false;

  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${state.events.length}:${seatId}:sheriff-withdraw`);
  const publicCase = scoreSheriffCandidatePublicCase(state, seatId);
  if (player.role === "werewolf") {
    const teammateStillOnPolice = knownWolfTeammates(state, seatId).some((id) => id !== seatId && candidates.includes(id));
    const pressure = (persona.deceptionSkill + persona.riskTolerance + persona.bussingTendency) / 300;
    return teammateStillOnPolice && publicCase < 2.2 && rng() < 0.25 + pressure * 0.35;
  }
  const caution = (persona.conservatism + 100 - persona.aggression) / 200;
  return publicCase < 1.8 && rng() < Math.min(0.7, 0.25 + caution * 0.35);
}

function choosePublicAttentionTarget(state: GameState, legalTargets: PlayerId[], salt: string): PlayerId | undefined {
  if (legalTargets.length === 0) return undefined;
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${state.events.length}:${salt}`);
  const scored = legalTargets.map((id) => ({
    id,
    score: scorePublicAttention(state, id) + scorePublicSuspicion(state, id) * 0.35 + rng() * 0.4
  }));
  scored.sort((left, right) => right.score - left.score || requirePlayer(state, left.id).seatNumber - requirePlayer(state, right.id).seatNumber);
  return scored[0]?.id ?? chooseDeterministic(state, legalTargets, salt);
}

function choosePublicSuspicionTarget(
  state: GameState,
  legalTargets: PlayerId[],
  salt: string,
  minimumScore: number
): PlayerId | undefined {
  if (legalTargets.length === 0) return undefined;
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${state.events.length}:${salt}`);
  const scored = legalTargets.map((id) => ({
    id,
    baseScore: scorePublicSuspicion(state, id),
    score: scorePublicSuspicion(state, id) + rng() * 0.35
  }));
  scored.sort((left, right) => right.score - left.score || requirePlayer(state, left.id).seatNumber - requirePlayer(state, right.id).seatNumber);
  const best = scored[0];
  return best && best.baseScore >= minimumScore ? best.id : undefined;
}

function chooseSheriffVoteTarget(state: GameState, voterId: PlayerId, targetPool: PlayerId[]): PlayerId | "abstain" {
  const voter = requirePlayer(state, voterId);
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${state.events.length}:${voterId}:sheriff-vote`);
  const scored = targetPool.map((id) => ({
    id,
    score: scoreSheriffCandidatePublicCase(state, id) + scoreSheriffCandidateRelationToVoter(state, id, voterId) + rng() * 0.3
  }));
  if (voter.role === "werewolf") {
    const teammates = knownWolfTeammates(state, voterId);
    const teammate = scored
      .filter((item) => teammates.includes(item.id))
      .sort((left, right) => right.score - left.score)[0];
    if (teammate && rng() >= 0.25) return teammate.id;
  }
  scored.sort((left, right) => right.score - left.score || requirePlayer(state, left.id).seatNumber - requirePlayer(state, right.id).seatNumber);
  const best = scored[0];
  if (!best) return state.rulePreset.voteRules.allowAbstain ? "abstain" : targetPool[0];
  if (best.score < 1.1 && state.rulePreset.voteRules.allowAbstain && rng() < 0.45) return "abstain";
  return best.id;
}

function scorePublicAttention(state: GameState, targetId: PlayerId): number {
  let score = state.sheriffSeatId === targetId ? 2 : 0;
  for (const event of getPublicEvents(state).slice(-36)) {
    if (event.type === "SheriffCandidatesAnnounced") {
      const candidates = (event.payload as { candidates?: PlayerId[] }).candidates ?? [];
      if (candidates.includes(targetId)) score += 1.2;
    }
    if ((event.type === "SpeechPublished" || event.type === "LastWordsPublished") && event.seatId === targetId) score += 0.7;
    if ((event.type === "DayVoteResolved" || event.type === "SheriffVoteResolved") && isRecord(event.payload)) {
      const tally = event.payload.tally as Record<PlayerId, number> | undefined;
      score += (tally?.[targetId] ?? 0) * 0.35;
    }
  }
  return score;
}

function scorePublicSuspicion(state: GameState, targetId: PlayerId): number {
  const events = getPublicEvents(state).slice(-40);
  let score = 0;
  for (const event of events) {
    const text = eventText(event);
    if (!mentionsPlayer(state, text, targetId)) continue;
    if (/(查杀|狼面|像狼|狼人|出掉|归票|抗推|冲票|倒钩|解释|不认|压力|爆点|匪)/.test(text)) score += 1.4;
    if (/(金水|好人|认下|可信|保下|偏好|银水)/.test(text)) score -= 1.2;
  }
  return score;
}

function scoreSheriffCandidatePublicCase(state: GameState, candidateId: PlayerId): number {
  let score = 0;
  for (const event of getPublicEvents(state).slice(-32)) {
    const text = eventText(event);
    if (event.type === "SpeechPublished" && event.seatId === candidateId) {
      if (/(预言家|查验|警徽流|金水|查杀|验人)/.test(text)) score += 2.6;
      if (/(警下票型|对跳|退水|站边|归票)/.test(text)) score += 0.9;
      if (text.length >= 32) score += 0.5;
    }
    if (event.type === "SheriffCandidateWithdrawn" && event.seatId === candidateId) score -= 99;
  }
  return score;
}

function scoreSheriffCandidateRelationToVoter(state: GameState, candidateId: PlayerId, voterId: PlayerId): number {
  let score = 0;
  for (const event of getPublicEvents(state).slice(-32)) {
    if (event.type !== "SpeechPublished" || event.seatId !== candidateId) continue;
    const text = eventText(event);
    if (!mentionsPlayer(state, text, voterId)) continue;
    if (/(查杀|狼|狼人|狼面|出掉|归票|抗推|不认|打死)/.test(text)) score -= 4;
    if (/(金水|好人|认下|保下|偏好|银水)/.test(text)) score += 1.6;
  }
  return score;
}

function knownWolfTeammates(state: GameState, wolfId: PlayerId): PlayerId[] {
  const actor = getPlayer(state, wolfId);
  if (actor?.role !== "werewolf") return [];
  return alivePlayers(state)
    .filter((player) => player.role === "werewolf")
    .map((player) => player.id);
}

function eventText(event: GameEvent): string {
  if (!isRecord(event.payload)) return "";
  const payload = event.payload as Record<string, unknown>;
  return [payload.text, payload.publicSpeech, payload.messageToWolves]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function mentionsPlayer(state: GameState, text: string, playerId: PlayerId): boolean {
  const player = getPlayer(state, playerId);
  if (!player || !text) return false;
  if (text.includes(playerId)) return true;
  if (new RegExp(`(?:^|[^0-9])${player.seatNumber}\\s*号`).test(text)) return true;
  return Boolean(player.name.trim() && text.includes(player.name));
}

function createMockSpeech(state: GameState, seatId: PlayerId, speechType: SpeechAction["speechType"]): string {
  const player = requirePlayer(state, seatId);
  const pressureTargets = choosePublicPressureTargets(state, seatId).slice(0, 2);
  const pressure = pressureTargets.map((id) => formatSeat(state, id)).join("、");
  const publicContext = summarizePublicSpeechContext(state);
  const sheriffCandidateText = publicContext.sheriffCandidates.map((id) => formatSeat(state, id)).join("、");
  if (speechType === "last_words") {
    const review = publicContext.hasDayVote ? "白天票型" : publicContext.hasSheriffVote ? "警长票型" : "已经公开的发言";
    return `遗言我只留两点：先复盘${review}，不要把死亡当验身份。${pressure ? `我更想让场上继续压${pressure}的发言逻辑。` : "后面按发言断层和投票动机找狼。"}`;
  }
  if (speechType === "sheriff") {
    if (player.role === "seer") {
      const check = latestSeerCheck(state, seatId);
      const checkText = check ? `${formatSeat(state, check.targetId)}是${check.result === "werewolf" ? "查杀" : "金水"}` : "昨晚验人结果我会先压住半轮";
      const flow = pressureTargets
        .slice(0, 2)
        .map((id) => formatSeat(state, id))
        .join("、");
      return `我竞选警长，身份我先明跳预言家。${checkText}。警徽流先留${flow || "后置发言里逻辑最拧的位置"}，后续投票重点看谁只站边不交理由。`;
    }
    if (player.role === "werewolf") {
      return `我上警不是认预言家，先抢一个发言视角。今天重点看警上谁有验人、警徽流和退水逻辑，警徽不要轻易给只报结论的人。`;
    }
    return `我上警是为了争取发言视角。现阶段不拍身份，先听对跳、验人和退水，后面按发言质量决定警徽归属。`;
  }
  if (speechType === "pk") {
    return `PK 我先表清楚：我不是靠情绪抗推。${pressure ? `如果要二选一，我认为先压${pressure.split("、")[0]}的发言矛盾。` : "请看我和对方谁的验人、警徽流和投票理由更完整。"}`;
  }
  if (player.role === "werewolf") {
    const voteCue = publicContext.hasSheriffVote || publicContext.hasDayVote ? "票型里有没有倒钩和冲票。" : "没有票型前先别编票型，主要听发言有没有身份硬贴和逻辑跳步。";
    return `${pressure ? `我不太认${pressure}这两张牌的发言闭环。` : "我先不硬归票，等后置位补齐逻辑。"} 今天别只跟预言家标签走，重点看${voteCue}`;
  }
  if (player.role === "seer") {
    const check = latestSeerCheck(state, seatId);
    if (check) {
      const nextFlow = pressureTargets
        .filter((id) => id !== check.targetId)
        .slice(0, 2)
        .map((id) => formatSeat(state, id))
        .join("、");
      const cue = publicContext.hasSheriffVote ? "警长票型" : "警上发言";
      return `我报验人：${formatSeat(state, check.targetId)}是${check.result === "werewolf" ? "查杀" : "金水"}。今天围绕这个信息和${cue}盘，警徽流继续留${nextFlow || "发言最拧巴的位置"}。`;
    }
  }
  if (pressure) {
    const voteCue = publicContext.hasSheriffVote || publicContext.hasDayVote ? "票型" : "后续票型";
    return `我现在更想听${pressure}把具体发言矛盾讲清楚。我的判断只看公开信息，先对齐警上发言，再结合${voteCue}和死亡信息。`;
  }
  if (sheriffCandidateText && !publicContext.hasSheriffVote) {
    return `现在公开焦点主要是上警的${sheriffCandidateText}，没上警的位置先不要被硬拉站边。先听他们报验人、警徽流和退水情况。`;
  }
  return "现在公开信息还不够，我先不强行归边。先听后置位补充发言，再结合后续票型和死亡信息判断。";
}

function latestSeerCheck(state: GameState, seatId: PlayerId): { targetId: PlayerId; result: "werewolf" | "good" } | undefined {
  const event = [...state.events].reverse().find((item) => item.type === "SeerChecked" && item.seatId === seatId);
  if (!event || !isRecord(event.payload)) return undefined;
  const targetId = typeof event.payload.targetId === "string" ? event.payload.targetId : undefined;
  const result = event.payload.result === "werewolf" || event.payload.result === "good" ? event.payload.result : undefined;
  return targetId && result ? { targetId, result } : undefined;
}

function choosePublicPressureTargets(state: GameState, selfId: PlayerId): PlayerId[] {
  const legalTargets = aliveIds(state).filter((id) => id !== selfId);
  const rng = createRng(`${state.setup.seed}:${state.id}:${state.day}:${state.events.length}:${selfId}:pressure`);
  return legalTargets
    .map((id) => ({ id, score: scorePublicSuspicion(state, id) }))
    .filter((item) => item.score >= 1)
    .map((item) => ({ ...item, score: item.score + rng() * 0.1 }))
    .sort((left, right) => right.score - left.score || requirePlayer(state, left.id).seatNumber - requirePlayer(state, right.id).seatNumber)
    .map((item) => item.id);
}

function summarizePublicSpeechContext(state: GameState): { sheriffCandidates: PlayerId[]; hasSheriffVote: boolean; hasDayVote: boolean } {
  const publicEvents = getPublicEvents(state);
  const candidateEvent = [...publicEvents].reverse().find((event) => event.type === "SheriffCandidatesAnnounced" && isRecord(event.payload));
  const candidates =
    candidateEvent && isRecord(candidateEvent.payload) && Array.isArray(candidateEvent.payload.candidates)
      ? candidateEvent.payload.candidates.filter((id): id is PlayerId => typeof id === "string")
      : [];
  return {
    sheriffCandidates: candidates,
    hasSheriffVote: publicEvents.some((event) => event.type === "SheriffVoteResolved"),
    hasDayVote: publicEvents.some((event) => event.type === "DayVoteResolved")
  };
}

function buildMockRationale(state: GameState, seatId: PlayerId): string {
  const player = requirePlayer(state, seatId);
  return `${formatSeat(state, seatId)}是${ROLE_DEFINITIONS[player.role].name}，Mock 决策根据当前阶段、存活列表、公开事件和简单阵营目标生成，不读取真实模型。`;
}

function createMockCallLog(state: GameState, decision: MockDecision, seatId?: PlayerId): LLMCallLog {
  const rawResponse = JSON.stringify(decision.parsedJson);
  return {
    id: `call_${state.llmCalls.length + 1}`,
    gameId: state.id,
    phase: state.phase.type,
    seatId,
    personaId: seatId ? getPlayer(state, seatId)?.personaId : undefined,
    provider: "mock",
    model: "deterministic-mock",
    promptVersion: "mock-v1",
    promptHash: createPromptHash("Mock AI uses deterministic local heuristics. No API key or external prompt was sent."),
    promptTextRedacted: "Mock AI uses deterministic local heuristics. No API key or external prompt was sent.",
    rawResponse,
    parsedJson: decision.parsedJson,
    publicSpeech: decision.publicSpeech,
    privateRationale: decision.privateRationale,
    inputTokens: Math.max(40, Math.round(rawResponse.length / 2)),
    outputTokens: Math.max(20, Math.round(rawResponse.length / 4)),
    reasoningTokens: 0,
    cachedTokens: 0,
    estimatedCost: 0,
    latencyMs: 5,
    retryCount: 0
  };
}

function renderPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 0);
}

function appendText(current: string, delta: string): string {
  const cleanDelta = delta.trim();
  if (!cleanDelta) return current;
  return current.trim() ? `${current.trim()}\n${cleanDelta}` : cleanDelta;
}

function appendUnique(items: string[], item: string): void {
  const clean = item.trim();
  if (clean && !items.includes(clean)) items.push(clean);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

interface CallSummary {
  key: string;
  calls: number;
  failedCalls: number;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCost: number;
}

function summarizeCallLogs(calls: LLMCallLog[], keyOf: (call: LLMCallLog) => string): CallSummary[] {
  const groups = new Map<string, CallSummary>();
  for (const call of calls) {
    const key = keyOf(call);
    const summary = groups.get(key) ?? {
      key,
      calls: 0,
      failedCalls: 0,
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCost: 0
    };
    summary.calls += 1;
    summary.failedCalls += call.error ? 1 : 0;
    summary.retryCount += call.retryCount;
    summary.inputTokens += call.inputTokens;
    summary.outputTokens += call.outputTokens;
    summary.reasoningTokens += call.reasoningTokens;
    summary.estimatedCost += call.estimatedCost;
    groups.set(key, summary);
  }
  return [...groups.values()].sort(
    (left, right) => right.estimatedCost - left.estimatedCost || right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens)
  );
}

function renderCallSummaryRows(rows: CallSummary[]): string {
  return rows
    .map(
      (row) =>
        `| ${row.key} | ${row.calls} | ${row.failedCalls} | ${row.retryCount} | ${row.inputTokens} | ${row.outputTokens} | ${row.reasoningTokens} | ${row.estimatedCost.toFixed(6)} |`
    )
    .join("\n");
}

function formatSeat(state: GameState, id: PlayerId | undefined): string {
  if (!id) return "未知玩家";
  const player = getPlayer(state, id);
  return player ? `${player.seatNumber}号${player.name}` : id;
}

function pushEvent<TPayload extends Record<string, unknown>>(
  state: GameState,
  type: string,
  visibility: "public" | "private" | "admin",
  payload: TPayload,
  seatId?: PlayerId
): void {
  state.events.push({
    id: `event_${state.events.length + 1}`,
    gameId: state.id,
    seq: state.events.length + 1,
    type,
    visibility,
    seatId,
    payload,
    createdAt: new Date().toISOString()
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function createRng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}
