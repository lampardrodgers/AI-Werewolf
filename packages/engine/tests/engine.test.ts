import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_MODE, STANDARD_PRESET, type RulePreset } from "@langrensha/shared";
import { applyAgentMemoryUpdate, applyCommand, applyMockStep, createGame, createSnapshotFixture, generateMarkdownLog, getPlayerVisibleEvents, getVisibleEvents, restoreSnapshotFixture, runMockBatch, runUntilBlocked } from "../src/index";

describe("werewolf engine", () => {
  it("allocates the standard 12-player role table", () => {
    const state = createGame({
      totalPlayers: 12,
      humanPlayers: 0,
      aiPlayers: 12,
      seed: "roles",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    const counts = state.players.reduce<Record<string, number>>((acc, player) => {
      acc[player.role] = (acc[player.role] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts.werewolf).toBe(4);
    expect(counts.villager).toBe(4);
    expect(counts.seer).toBe(1);
    expect(counts.witch).toBe(1);
    expect(counts.hunter).toBe(1);
    expect(counts.guard).toBe(1);
  });

  it("can run a full all-AI game to an end state", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "full-run",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    const finished = runUntilBlocked(state, 400);

    expect(finished.status).toBe("ended");
    expect(finished.winner === "good" || finished.winner === "wolves").toBe(true);
    expect(finished.events.some((event) => event.type === "GameEnded")).toBe(true);
  });

  it("can batch-run mock all-AI games for debug mode", () => {
    const result = runMockBatch(
      {
        totalPlayers: 8,
        humanPlayers: 1,
        aiPlayers: 7,
        seed: "batch-run",
        rulePresetId: STANDARD_PRESET.id,
        debugMode: DEFAULT_DEBUG_MODE
      },
      10,
      400
    );

    expect(result.totalGames).toBe(10);
    expect(result.endedGames).toBe(10);
    expect(result.blockedGames).toBe(0);
    expect(result.goodWins + result.wolfWins).toBe(10);
    expect(result.seeds[0]).toBe("batch-run:1");
    expect(result.averageEvents).toBeGreaterThan(0);
    expect(result.averageCalls).toBeGreaterThan(0);
  });

  it("uses wolf discussion before the seer phase", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-chat",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 8 && state.phase.type !== "night_seer"; index += 1) {
      state = applyMockStep(state);
    }

    expect(state.events.some((event) => event.type === "WolfDiscussionMessage")).toBe(true);
    expect(state.events.some((event) => event.type === "WolfKillLocked")).toBe(true);
  });

  it("follows custom night order from the rule preset", () => {
    const seerFirstPreset: RulePreset = {
      ...STANDARD_PRESET,
      id: "seer-first",
      nightOrder: ["seer_check", "wolf_discussion", "witch_action", "resolve_deaths"]
    };
    let state = createGame(
      {
        totalPlayers: 6,
        humanPlayers: 0,
        aiPlayers: 6,
        seed: "seer-first",
        rulePresetId: seerFirstPreset.id,
        debugMode: DEFAULT_DEBUG_MODE
      },
      seerFirstPreset
    );
    const pending = state.pendingActions[0];
    if (!pending || pending.kind !== "seer_check") throw new Error("expected seer to act first");

    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: pending.seatId,
      action: "seer_check",
      targetId: pending.legalTargets[0],
      privateReason: "测试自定义夜晚顺序。"
    });

    expect(state.phase.type).toBe("night_wolves");
    expect(state.pendingActions[0]).toMatchObject({ kind: "wolf_discussion" });
  });

  it("rejects illegal command targets instead of silently replacing them", () => {
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "illegal-target",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const pending = state.pendingActions[0];
    if (pending.kind !== "wolf_discussion") throw new Error("expected wolf discussion as first pending action");

    expect(() =>
      applyCommand(state, {
        type: "SubmitWolfDiscussionMessage",
        seatId: pending.seatId,
        messageToWolves: "我先测试一个非法刀口。",
        proposedTargetId: "player_999",
        agreeCurrentProposal: true,
        privateReason: "验证非法目标不会被静默替换。"
      })
    ).toThrow("非法目标 player_999");
  });

  it("allows wolves to propose any alive player, including self and wolf teammates", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-self-target",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const firstPending = state.pendingActions[0];
    if (firstPending.kind !== "wolf_discussion") throw new Error("expected wolf discussion as first pending action");

    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    expect(firstPending.legalTargets.sort()).toEqual(aliveIds.sort());
    expect(firstPending.legalTargets).toContain(firstPending.seatId);

    const teammateId = state.players.find((player) => player.role === "werewolf" && player.id !== firstPending.seatId)?.id;
    if (!teammateId) throw new Error("expected a wolf teammate");
    expect(firstPending.legalTargets).toContain(teammateId);

    state = applyCommand(state, {
      type: "SubmitWolfDiscussionMessage",
      seatId: firstPending.seatId,
      messageToWolves: "我测试自刀合法性。",
      proposedTargetId: firstPending.seatId,
      agreeCurrentProposal: true,
      privateReason: "自刀应是合法狼刀目标。"
    });

    const message = state.events.find((event) => event.type === "WolfDiscussionMessage" && event.seatId === firstPending.seatId);
    expect(message?.payload).toMatchObject({ proposedTarget: firstPending.seatId });
  });

  it("honors rule presets that forbid vote abstentions", () => {
    const noAbstainPreset = {
      ...STANDARD_PRESET,
      id: "standard-no-abstain",
      voteRules: { ...STANDARD_PRESET.voteRules, allowAbstain: false }
    };
    const state = createGame(
      {
        totalPlayers: 6,
        humanPlayers: 0,
        aiPlayers: 6,
        seed: "no-abstain",
        rulePresetId: noAbstainPreset.id,
        debugMode: DEFAULT_DEBUG_MODE
      },
      noAbstainPreset
    );
    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    const voterId = aliveIds[0];
    state.day = 1;
    state.phase = { type: "day_vote", day: 1, label: "白天投票" };
    state.round.day = { speechQueue: [], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds }));

    expect(() =>
      applyCommand(state, {
        type: "SubmitVote",
        seatId: voterId,
        targetId: "abstain",
        privateReason: "测试禁用弃票。",
        confidence: 0
      })
    ).toThrow("当前规则不允许弃票");

    const timedOut = applyCommand(state, { type: "ResolveTimeout", seatId: voterId });
    const timeoutVote = timedOut.events.find((event) => event.type === "VoteCast" && event.seatId === voterId);
    expect(timeoutVote?.payload).toMatchObject({ targetId: aliveIds[0] });
  });

  it("uses the random second-tie policy for day PK votes", () => {
    const randomTiePreset = {
      ...STANDARD_PRESET,
      id: "standard-random-second-tie",
      voteRules: { ...STANDARD_PRESET.voteRules, secondTiePolicy: "random" as const }
    };
    let state = createGame(
      {
        totalPlayers: 6,
        humanPlayers: 0,
        aiPlayers: 6,
        seed: "random-second-tie",
        rulePresetId: randomTiePreset.id,
        debugMode: DEFAULT_DEBUG_MODE
      },
      randomTiePreset
    );
    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    const pkCandidates = aliveIds.slice(0, 2);
    const voters = aliveIds.slice(2, 4);
    state.day = 1;
    state.phase = { type: "day_pk_vote", day: 1, label: "PK 投票" };
    state.round.day = { speechQueue: [], votes: {}, pkCandidates, pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = voters.map((seatId) => ({ kind: "vote", seatId, voteType: "day_pk", legalTargets: pkCandidates }));

    state = applyCommand(state, { type: "SubmitVote", seatId: voters[0], targetId: pkCandidates[0], privateReason: "测试二次平票随机策略。", confidence: 1 });
    state = applyCommand(state, { type: "SubmitVote", seatId: voters[1], targetId: pkCandidates[1], privateReason: "测试二次平票随机策略。", confidence: 1 });

    const exiledCandidates = pkCandidates.filter((id) => state.players.find((player) => player.id === id)?.death?.reason === "exile");
    expect(exiledCandidates).toHaveLength(1);
    expect(state.events.some((event) => event.type === "PlayerExiled" && exiledCandidates.includes((event.payload as { targetId?: string }).targetId ?? ""))).toBe(true);
    expect(state.events.some((event) => event.type === "NoExile")).toBe(false);
  });

  it("exports a markdown replay with roles and token stats", () => {
    const state = runUntilBlocked(
      createGame({
        totalPlayers: 6,
        humanPlayers: 0,
        aiPlayers: 6,
        seed: "markdown",
        rulePresetId: STANDARD_PRESET.id,
        debugMode: DEFAULT_DEBUG_MODE
      }),
      200
    );

    const markdown = generateMarkdownLog(state);
    expect(markdown).toContain("## 身份分配");
    expect(markdown).toContain("## Token 统计");
    expect(markdown).toContain("### 调用概览");
    expect(markdown).toContain("失败调用");
    expect(markdown).toContain("重试次数");
    expect(markdown).toContain("平均每次调用费用");
    expect(markdown).toContain("最贵调用");
    expect(markdown).toContain("### 调用明细");
    expect(markdown).toContain("| 项目 | 调用 | 失败 | 重试 | 输入 | 输出 | 推理 | 费用 |");
    expect(markdown).toContain("### 按玩家");
    expect(markdown).toContain("### 按供应商");
    expect(markdown).toContain("### 按模型");
    expect(markdown).toContain("### 按阶段");
    expect(markdown).toContain("## AI 调用记录");
    expect(markdown).toContain("Prompt Hash");
    expect(markdown).toContain("## 结局");
  });

  it("exports a reproducible snapshot fixture for the current game state", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    state = applyMockStep(state);

    const fixture = createSnapshotFixture(state);

    expect(fixture.version).toBe("langrensha-snapshot-v1");
    expect(fixture.gameId).toBe(state.id);
    expect(fixture.phase).toEqual(state.phase);
    expect(fixture.setup.seed).toBe("snapshot");
    expect(fixture.summary.events).toBe(state.events.length);
    expect(fixture.summary.pendingActions).toBe(state.pendingActions.length);
    expect(fixture.state).toEqual(state);
    expect(fixture.state).not.toBe(state);
  });

  it("restores a snapshot fixture as an independent playable state", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-restore",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    state = applyMockStep(state);
    const restored = restoreSnapshotFixture(JSON.parse(JSON.stringify(createSnapshotFixture(state))));

    expect(restored).toEqual(state);
    expect(restored).not.toBe(state);
    expect(restored.pendingActions).not.toBe(state.pendingActions);
    const advanced = applyMockStep(restored);
    expect(advanced.events.length).toBeGreaterThan(state.events.length);
  });

  it("does not leak private reasons through public event payloads", () => {
    const state = runUntilBlocked(
      createGame({
        totalPlayers: 8,
        humanPlayers: 0,
        aiPlayers: 8,
        seed: "public-visibility",
        rulePresetId: STANDARD_PRESET.id,
        debugMode: DEFAULT_DEBUG_MODE
      }),
      400
    );

    const publicPayloads = state.events.filter((event) => event.visibility === "public").map((event) => event.payload);
    expect(JSON.stringify(publicPayloads)).not.toContain("privateReason");
  });

  it("does not leak wolf private reasons through wolf-visible chat events", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-private-reason",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 4 && !state.events.some((event) => event.type === "WolfDiscussionMessage"); index += 1) {
      state = applyMockStep(state);
    }

    const wolfChatEvents = state.events.filter((event) => event.type === "WolfDiscussionMessage");
    const adminReasonEvents = state.events.filter((event) => event.type === "WolfDiscussionPrivateReason");
    expect(wolfChatEvents.length).toBeGreaterThan(0);
    expect(adminReasonEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(wolfChatEvents.map((event) => event.payload))).not.toContain("privateReason");
    expect(JSON.stringify(adminReasonEvents.map((event) => event.payload))).toContain("privateReason");
  });

  it("shows wolf chat to wolf viewers without exposing it to non-wolves", () => {
    const normalMode = {
      ...DEFAULT_DEBUG_MODE,
      revealRoles: false,
      revealPrivateRationales: false,
      revealWolfChat: false
    };
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-viewer",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: normalMode
    });

    for (let index = 0; index < 4 && state.events.filter((event) => event.type === "WolfDiscussionMessage").length < 2; index += 1) {
      state = applyMockStep(state);
    }

    const wolfViewer = state.players.find((player) => player.role === "werewolf")?.id;
    const nonWolfViewer = state.players.find((player) => player.role !== "werewolf")?.id;
    if (!wolfViewer || !nonWolfViewer) throw new Error("expected wolf and non-wolf viewers");

    expect(getVisibleEvents(state, wolfViewer).some((event) => event.type === "WolfDiscussionMessage")).toBe(true);
    expect(getVisibleEvents(state, nonWolfViewer).some((event) => event.type === "WolfDiscussionMessage")).toBe(false);
    expect(JSON.stringify(getVisibleEvents(state, wolfViewer).map((event) => event.payload))).not.toContain("privateReason");
  });

  it("keeps strict player visibility independent from debug reveal wolf chat", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "strict-visibility",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: { ...DEFAULT_DEBUG_MODE, revealRoles: false, revealPrivateRationales: false, revealWolfChat: true }
    });

    for (let index = 0; index < 4 && !state.events.some((event) => event.type === "WolfDiscussionMessage"); index += 1) {
      state = applyMockStep(state);
    }
    const nonWolfViewer = state.players.find((player) => player.role !== "werewolf")?.id;
    if (!nonWolfViewer) throw new Error("expected non-wolf viewer");

    expect(getVisibleEvents(state, nonWolfViewer).some((event) => event.type === "WolfDiscussionMessage")).toBe(true);
    expect(getPlayerVisibleEvents(state, nonWolfViewer).some((event) => event.type === "WolfDiscussionMessage")).toBe(false);
  });

  it("shows locked wolf kill facts only to wolves without backend reasons", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-lock-visibility",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 8 && !state.events.some((event) => event.type === "WolfKillLocked"); index += 1) {
      state = applyMockStep(state);
    }

    const wolfViewer = state.players.find((player) => player.role === "werewolf")?.id;
    const nonWolfViewer = state.players.find((player) => player.role !== "werewolf")?.id;
    if (!wolfViewer || !nonWolfViewer) throw new Error("expected wolf and non-wolf viewers");

    const wolfEvents = getPlayerVisibleEvents(state, wolfViewer);
    const nonWolfEvents = getPlayerVisibleEvents(state, nonWolfViewer);
    const adminReasonEvent = state.events.find((event) => event.type === "WolfKillLockedPrivateReason");

    expect(wolfEvents.some((event) => event.type === "WolfKillLocked")).toBe(true);
    expect(nonWolfEvents.some((event) => event.type === "WolfKillLocked")).toBe(false);
    expect(JSON.stringify(wolfEvents.map((event) => event.payload))).not.toContain("privateReason");
    expect(adminReasonEvent?.visibility).toBe("admin");
    expect(JSON.stringify(adminReasonEvent?.payload)).toContain("privateReason");
  });

  it("shows private night action facts to actors without exposing backend reasons", () => {
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "private-night-actions",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const guardPending = state.pendingActions.find((action) => action.kind === "guard_protect");
    if (!guardPending || !("legalTargets" in guardPending)) throw new Error("expected guard pending action");

    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: guardPending.seatId,
      action: "guard_protect",
      targetId: guardPending.legalTargets[0],
      privateReason: "SECRET_GUARD_REASON"
    });

    const guardEvents = getPlayerVisibleEvents(state, guardPending.seatId);
    expect(guardEvents.some((event) => event.type === "NightActionSubmitted")).toBe(true);
    expect(JSON.stringify(guardEvents.map((event) => event.payload))).not.toContain("SECRET_GUARD_REASON");
    expect(JSON.stringify(guardEvents.map((event) => event.payload))).not.toContain("privateReason");
    expect(state.events.some((event) => event.type === "NightActionPrivateReason" && event.visibility === "admin")).toBe(true);
  });

  it("only allows debug force kill when manual override is enabled", () => {
    const targetId = "player_1";
    const disabled = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "debug-kill-disabled",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: { ...DEFAULT_DEBUG_MODE, allowManualOverride: false }
    });
    const enabled = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "debug-kill-enabled",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: { ...DEFAULT_DEBUG_MODE, allowManualOverride: true }
    });

    const blocked = applyCommand(disabled, { type: "DebugForceKill", seatId: targetId, reason: "test" });
    const killed = applyCommand(enabled, { type: "DebugForceKill", seatId: targetId, reason: "test" });

    expect(blocked.players.find((player) => player.id === targetId)?.alive).toBe(true);
    expect(killed.players.find((player) => player.id === targetId)?.alive).toBe(false);
    expect(killed.events.some((event) => event.type === "DebugForceKill" && event.visibility === "admin")).toBe(true);
  });

  it("lets a sheriff candidate withdraw and advances the election", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "sheriff-withdraw",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 20 && state.phase.type !== "sheriff_candidacy"; index += 1) {
      state = applyMockStep(state);
    }
    expect(state.phase.type).toBe("sheriff_candidacy");

    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    const candidates = aliveIds.slice(0, 2);
    for (const seatId of aliveIds) {
      state = applyCommand(state, {
        type: "SubmitSheriffCandidacy",
        seatId,
        runForSheriff: candidates.includes(seatId),
        publicSpeech: candidates.includes(seatId) ? "我上警争警徽。" : "我警下投票。",
        privateReason: "测试警长竞选。"
      });
    }

    expect(state.phase.type).toBe("sheriff_speech");
    state = applyCommand(state, { type: "WithdrawSheriffCandidacy", seatId: candidates[0], privateReason: "测试退水。" });

    expect(state.sheriffSeatId).toBe(candidates[1]);
    expect(state.events.some((event) => event.type === "SheriffCandidateWithdrawn" && event.seatId === candidates[0])).toBe(true);
    expect(state.events.some((event) => event.type === "SheriffElected" && (event.payload as { sheriffId?: string }).sheriffId === candidates[1])).toBe(true);
  });

  it("lets a dead sheriff pass the badge before the game continues", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "badge-pass",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const sheriffId = state.players.find((player) => player.role === "werewolf")?.id;
    const recipientId = state.players.find((player) => player.id !== sheriffId && player.role !== "werewolf")?.id;
    if (!sheriffId || !recipientId) throw new Error("expected sheriff and recipient");

    for (const player of state.players) player.isSheriff = player.id === sheriffId;
    state.sheriffSeatId = sheriffId;
    state.day = 1;
    state.phase = { type: "day_vote", day: 1, label: "白天投票" };
    state.round.day = { speechQueue: [], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds }));

    for (const voterId of aliveIds) {
      state = applyCommand(state, { type: "SubmitVote", seatId: voterId, targetId: sheriffId, privateReason: "测试出掉警长。", confidence: 1 });
    }

    expect(state.phase.type).toBe("badge_decision");
    expect(state.pendingActions[0]).toMatchObject({ kind: "badge_decision", seatId: sheriffId });
    state = applyCommand(state, { type: "SubmitBadgeDecision", seatId: sheriffId, targetId: recipientId, privateReason: "测试移交警徽。" });

    expect(state.sheriffSeatId).toBe(recipientId);
    expect(state.players.find((player) => player.id === recipientId)?.isSheriff).toBe(true);
    expect(state.badgeDestroyed).toBe(false);
    expect(state.events.some((event) => event.type === "BadgePassed" && (event.payload as { toSeatId?: string }).toSeatId === recipientId)).toBe(true);
    expect(state.events.some((event) => event.type === "BadgeDecisionPrivateReason" && event.visibility === "admin")).toBe(true);
    expect(state.phase.type).toBe("night_wolves");
  });

  it("applies structured AI memory updates to one seat", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "memory-update",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const seatId = state.players[0].id;
    const targetId = state.players[1].id;

    const next = applyAgentMemoryUpdate(state, seatId, {
      publicSummaryDelta: "2号警上发言偏冲。",
      privateNotes: "后续优先观察2号票型。",
      suspicionChanges: [{ playerId: targetId, delta: 18, reason: "强行带票但理由不足" }],
      newClaims: [{ playerId: targetId, claim: "seer" }],
      knownFacts: ["2号声称自己是预言家"]
    });

    expect(next.memories[seatId].publicTimelineSummary).toContain("2号警上发言偏冲。");
    expect(next.memories[seatId].privateObservations).toContain("后续优先观察2号票型。");
    expect(next.memories[seatId].suspicionScores[targetId]).toBe(68);
    expect(next.memories[seatId].claimedRoles[targetId]).toContain("seer");
    expect(next.events.some((event) => event.type === "AgentMemoryUpdated" && event.visibility === "private" && event.seatId === seatId)).toBe(true);
    expect(state.memories[seatId].publicTimelineSummary).not.toContain("2号警上发言偏冲。");
  });
});
