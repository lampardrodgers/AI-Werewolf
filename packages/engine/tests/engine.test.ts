import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_MODE, STANDARD_PRESET, type RulePreset } from "@langrensha/shared";
import { applyAgentMemoryUpdate, applyCommand, applyMockStep, canWolfSelfExplode, createGame, createMockDecision, createSnapshotFixture, generateMarkdownLog, getPlayerVisibleEvents, getVisibleEvents, restoreSnapshotFixture, runMockBatch, runUntilBlocked } from "../src/index";

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

  it("does not invent stand-side pressure targets when public sheriff information is sparse", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "sparse-sheriff-context",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const candidates = [state.players[0].id, state.players[2].id];
    const speaker = state.players.find((player) => player.role === "villager" && !candidates.includes(player.id)) ?? state.players[4];
    state.phase = { type: "day_speech", day: 1, label: "第 1 天 · 白天发言", actingSeatId: speaker.id };
    state.pendingActions = [{ kind: "speech", seatId: speaker.id, speechType: "day" }];
    state.events.push({
      id: "event_sparse_sheriff_candidates",
      gameId: state.id,
      seq: state.events.length + 1,
      type: "SheriffCandidatesAnnounced",
      visibility: "public",
      payload: { candidates, speechOrder: candidates },
      createdAt: new Date().toISOString()
    });

    const decision = createMockDecision(state);

    expect(decision?.publicSpeech).toContain("上警的");
    expect(decision?.publicSpeech).not.toContain("把站边理由讲完整");
    expect(decision?.publicSpeech).not.toContain("警下票");
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

  it("reveals night actions to dead viewers without exposing them to living bystanders", () => {
    const hiddenDebugMode = {
      ...DEFAULT_DEBUG_MODE,
      revealRoles: false,
      revealPrompts: false,
      revealPrivateRationales: false,
      revealWolfChat: false,
      revealNightActions: false
    };
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "dead-viewer-night-actions",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: hiddenDebugMode
    });
    const deadViewer = state.players.find((player) => player.role === "hunter" || player.role === "villager") ?? state.players[0];
    const livingViewer = state.players.find((player) => player.id !== deadViewer.id && player.role === "villager") ?? state.players.find((player) => player.id !== deadViewer.id && player.role !== "werewolf" && player.role !== "seer") ?? state.players[1];
    const wolf = state.players.find((player) => player.role === "werewolf");
    const seer = state.players.find((player) => player.role === "seer");
    if (!wolf || !seer) throw new Error("expected wolf and seer");
    deadViewer.alive = false;
    deadViewer.death = { day: 1, phase: "day_vote", reason: "exile" };
    const createdAt = new Date().toISOString();
    state.events.push(
      {
        id: "event_dead_viewer_wolf_chat",
        gameId: state.id,
        seq: state.events.length + 1,
        type: "WolfDiscussionMessage",
        visibility: "private",
        seatId: wolf.id,
        payload: { messageToWolves: "今晚先统一刀口。" },
        createdAt
      },
      {
        id: "event_dead_viewer_seer_check",
        gameId: state.id,
        seq: state.events.length + 2,
        type: "SeerChecked",
        visibility: "private",
        seatId: seer.id,
        payload: { targetId: wolf.id, result: "werewolf" },
        createdAt
      }
    );

    const deadEvents = getPlayerVisibleEvents(state, deadViewer.id);
    const livingEvents = getPlayerVisibleEvents(state, livingViewer.id);

    expect(deadEvents.some((event) => event.type === "WolfDiscussionMessage")).toBe(true);
    expect(deadEvents.some((event) => event.type === "SeerChecked")).toBe(true);
    expect(livingEvents.some((event) => event.type === "WolfDiscussionMessage")).toBe(false);
    expect(livingEvents.some((event) => event.type === "SeerChecked")).toBe(false);
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

  it("allows wolves to self-kill or kill teammates", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "wolf-non-wolf-targets",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const firstPending = state.pendingActions[0];
    if (firstPending.kind !== "wolf_discussion") throw new Error("expected wolf discussion as first pending action");

    const livingIds = state.players.filter((player) => player.alive).map((player) => player.id);
    expect(firstPending.legalTargets.sort()).toEqual(livingIds.sort());
    expect(firstPending.legalTargets).toContain(firstPending.seatId);

    const teammateId = state.players.find((player) => player.role === "werewolf" && player.id !== firstPending.seatId)?.id;
    if (!teammateId) throw new Error("expected a wolf teammate");
    expect(firstPending.legalTargets).toContain(teammateId);

    state = applyCommand(state, {
      type: "SubmitWolfDiscussionMessage",
      seatId: firstPending.seatId,
      messageToWolves: "我测试自刀可行性。",
      proposedTargetId: firstPending.seatId,
      agreeCurrentProposal: true,
      privateReason: "自刀可以制造银水和身份迷惑。"
    });

    expect(state.round.night?.wolfDiscussion?.proposals[firstPending.seatId]).toBe(firstPending.seatId);
  });

  it("lets living wolves self-explode during public rounds and immediately enter night", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "wolf-self-explosion",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const wolfId = state.players.find((player) => player.role === "werewolf")?.id;
    const nonWolfId = state.players.find((player) => player.role !== "werewolf")?.id;
    if (!wolfId || !nonWolfId) throw new Error("expected wolf and non-wolf players");

    expect(canWolfSelfExplode(state, wolfId)).toBe(false);

    state.day = 1;
    state.phase = { type: "day_speech", day: 1, label: "第 2 天 · 白天发言", actingSeatId: nonWolfId };
    state.round.day = { speechQueue: [nonWolfId], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = [{ kind: "speech", seatId: nonWolfId, speechType: "day" }];

    expect(canWolfSelfExplode(state, wolfId)).toBe(true);
    expect(canWolfSelfExplode(state, nonWolfId)).toBe(false);

    const next = applyCommand(state, {
      type: "SubmitWolfSelfExplosion",
      seatId: wolfId,
      privateReason: "测试狼人公开自爆后直接结束当前白天并进入夜晚。"
    });

    expect(next.players.find((player) => player.id === wolfId)?.alive).toBe(false);
    expect(next.players.find((player) => player.id === wolfId)?.death?.reason).toBe("self_explosion");
    expect(next.events.some((event) => event.type === "WolfSelfExploded" && event.visibility === "public" && event.seatId === wolfId)).toBe(true);
    expect(next.pendingActions.some((action) => action.kind === "speech" || action.kind === "vote")).toBe(false);
    expect(next.phase.type.startsWith("night_")).toBe(true);
    expect(next.day).toBe(2);
  });

  it("ends the game when the last wolf self-explodes", () => {
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "last-wolf-self-explosion",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const wolves = state.players.filter((player) => player.role === "werewolf");
    const lastWolf = wolves[0];
    const speaker = state.players.find((player) => player.role !== "werewolf");
    if (!lastWolf || !speaker) throw new Error("expected wolf and speaker");

    for (const wolf of wolves.slice(1)) {
      wolf.alive = false;
      wolf.death = { day: 1, phase: "day_vote", reason: "exile" };
    }
    state.day = 1;
    state.phase = { type: "day_speech", day: 1, label: "第 2 天 · 白天发言", actingSeatId: speaker.id };
    state.round.day = { speechQueue: [speaker.id], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = [{ kind: "speech", seatId: speaker.id, speechType: "day" }];

    const next = applyCommand(state, {
      type: "SubmitWolfSelfExplosion",
      seatId: lastWolf.id,
      privateReason: "测试最后一狼自爆后直接触发好人胜利。"
    });

    expect(next.status).toBe("ended");
    expect(next.winner).toBe("good");
    expect(next.endReason).toBe("所有狼人死亡");
    expect(next.pendingActions).toEqual([]);
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
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds.filter((id) => id !== seatId) }));

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
    expect(timeoutVote?.payload).toMatchObject({ targetId: aliveIds[1] });
  });

  it("does not allow day voters to vote for themselves", () => {
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "no-self-vote",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    const voterId = aliveIds[0];
    state.day = 1;
    state.phase = { type: "day_vote", day: 1, label: "白天投票" };
    state.round.day = { speechQueue: [], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds.filter((id) => id !== seatId) }));

    const pending = state.pendingActions.find((action) => action.seatId === voterId);
    if (!pending || pending.kind !== "vote") throw new Error("expected vote pending action");
    expect(pending.legalTargets).not.toContain(voterId);
    expect(() =>
      applyCommand(state, {
        type: "SubmitVote",
        seatId: voterId,
        targetId: voterId,
        privateReason: "测试不允许自投。",
        confidence: 1
      })
    ).toThrow("不能投票给自己");
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

    const wolfViewer = state.players.find((player) => player.role === "werewolf" && player.alive)?.id;
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

  it("redacts private night phase actors from non-eligible viewers", () => {
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "private-phase-redaction",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 8 && !state.events.some((event) => event.type === "PhaseStarted" && (event.payload as { phase?: string }).phase === "night_wolves"); index += 1) {
      state = applyMockStep(state);
    }

    const wolfViewer = state.players.find((player) => player.role === "werewolf")?.id;
    const nonWolfViewer = state.players.find((player) => player.role !== "werewolf")?.id;
    if (!wolfViewer || !nonWolfViewer) throw new Error("expected wolf and non-wolf viewers");

    const wolfPhasePayloads = JSON.stringify(getPlayerVisibleEvents(state, wolfViewer).filter((event) => event.type === "PhaseStarted").map((event) => event.payload));
    const nonWolfPhasePayloads = JSON.stringify(getPlayerVisibleEvents(state, nonWolfViewer).filter((event) => event.type === "PhaseStarted").map((event) => event.payload));

    expect(wolfPhasePayloads).toContain("night_wolves");
    expect(nonWolfPhasePayloads).not.toContain("night_wolves");
    expect(nonWolfPhasePayloads).not.toContain(wolfViewer);
    expect(nonWolfPhasePayloads).toContain("night_hidden");
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

  it("keeps every private night action invisible to unrelated players", () => {
    const hiddenDebugMode = {
      ...DEFAULT_DEBUG_MODE,
      revealRoles: false,
      revealPrompts: false,
      revealPrivateRationales: false,
      revealWolfChat: false,
      revealNightActions: false
    };
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "private-night-action-isolation",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: hiddenDebugMode
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
    for (let index = 0; index < 16 && state.phase.type !== "night_seer"; index += 1) {
      state = applyMockStep(state);
    }
    const seerPending = state.pendingActions.find((action) => action.kind === "seer_check");
    if (!seerPending || !("legalTargets" in seerPending)) throw new Error("expected seer pending action");
    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: seerPending.seatId,
      action: "seer_check",
      targetId: seerPending.legalTargets[0],
      privateReason: "SECRET_SEER_REASON"
    });
    const witchPending = state.pendingActions.find((action) => action.kind === "witch_action");
    if (!witchPending) throw new Error("expected witch pending action");
    state = applyCommand(state, {
      type: "SubmitWitchAction",
      seatId: witchPending.seatId,
      save: false,
      privateReason: "SECRET_WITCH_REASON"
    });

    const unrelatedViewer = state.players.find((player) => player.role === "villager" && player.alive)?.id;
    const wolfViewer = state.players.find((player) => player.role === "werewolf" && player.alive)?.id;
    if (!unrelatedViewer || !wolfViewer) throw new Error("expected unrelated and wolf viewers");

    const unrelatedEvents = getPlayerVisibleEvents(state, unrelatedViewer);
    const wolfEvents = getPlayerVisibleEvents(state, wolfViewer);

    expect(unrelatedEvents.some((event) => event.type === "NightActionSubmitted")).toBe(false);
    expect(unrelatedEvents.some((event) => event.type === "SeerChecked")).toBe(false);
    expect(unrelatedEvents.some((event) => event.type === "WitchActionSubmitted")).toBe(false);
    expect(unrelatedEvents.some((event) => event.type === "WolfDiscussionMessage")).toBe(false);
    expect(unrelatedEvents.some((event) => event.type === "WolfKillLocked")).toBe(false);
    expect(wolfEvents.some((event) => event.type === "WolfDiscussionMessage")).toBe(true);
    expect(wolfEvents.some((event) => event.type === "NightActionSubmitted" && event.seatId !== wolfViewer)).toBe(false);
    expect(wolfEvents.some((event) => event.type === "SeerChecked")).toBe(false);
    expect(wolfEvents.some((event) => event.type === "WitchActionSubmitted")).toBe(false);
  });

  it("does not expose night death causes to ordinary viewers", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "night-death-cause-hidden",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 120 && !state.events.some((event) => event.type === "PlayerKilled"); index += 1) {
      state = applyMockStep(state);
    }

    const viewer = state.players.find((player) => player.alive)?.id;
    if (!viewer) throw new Error("expected viewer");
    const publicKill = getPlayerVisibleEvents(state, viewer).find((event) => event.type === "PlayerKilled");

    expect(publicKill).toBeDefined();
    expect(publicKill?.payload).not.toHaveProperty("reason");
    expect(state.events.some((event) => event.type === "PlayerDeathCauseRecorded" && event.visibility === "admin")).toBe(true);
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
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds.filter((id) => id !== seatId) }));

    for (const voterId of aliveIds) {
      const targetId = voterId === sheriffId ? recipientId : sheriffId;
      state = applyCommand(state, { type: "SubmitVote", seatId: voterId, targetId, privateReason: "测试出掉警长。", confidence: 1 });
    }

    expect(state.phase.type).toBe("badge_decision");
    expect(state.pendingActions[0]).toMatchObject({ kind: "badge_decision", seatId: sheriffId });
    state = applyCommand(state, { type: "SubmitBadgeDecision", seatId: sheriffId, targetId: recipientId, privateReason: "测试移交警徽。" });

    expect(state.sheriffSeatId).toBe(recipientId);
    expect(state.players.find((player) => player.id === recipientId)?.isSheriff).toBe(true);
    expect(state.badgeDestroyed).toBe(false);
    expect(state.events.some((event) => event.type === "BadgePassed" && (event.payload as { toSeatId?: string }).toSeatId === recipientId)).toBe(true);
    expect(state.events.some((event) => event.type === "BadgeDecisionPrivateReason" && event.visibility === "admin")).toBe(true);
    expect(state.phase.type).toBe("last_words");
    expect(state.pendingActions[0]).toMatchObject({ kind: "speech", seatId: sheriffId, speechType: "last_words" });
    state = applyCommand(state, { type: "SubmitSpeech", seatId: sheriffId, text: "移交完警徽，我留完遗言。", privateReason: "测试警长遗言。" });
    expect(state.phase.type.startsWith("night_")).toBe(true);
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
