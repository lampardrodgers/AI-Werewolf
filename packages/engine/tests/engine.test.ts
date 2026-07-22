import { describe, expect, it } from "vitest";
import { DEFAULT_DEBUG_MODE, STANDARD_PRESET, type RoleId, type RulePreset } from "@langrensha/shared";
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

  it("creates unique game ids for rapid consecutive games", () => {
    const setup = {
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "unique-game-id",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    };
    const ids = Array.from({ length: 32 }, () => createGame(setup).id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps gameplay deterministic for the same seed despite unique game ids", () => {
    const setup = {
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "same-seed-deterministic-gameplay",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    };
    let left = createGame(setup);
    let right = createGame(setup);
    expect(left.id).not.toBe(right.id);
    expect(left.players.map((player) => player.role)).toEqual(right.players.map((player) => player.role));

    for (let step = 0; step < 400; step += 1) {
      const leftDecision = createMockDecision(left);
      const rightDecision = createMockDecision(right);
      expect(leftDecision?.command).toEqual(rightDecision?.command);
      if (!leftDecision || !rightDecision) break;
      left = applyCommand(left, leftDecision.command);
      right = applyCommand(right, rightDecision.command);
      expect(left.phase).toEqual(right.phase);
      expect(left.pendingActions).toEqual(right.pendingActions);
      expect(left.players.map((player) => ({ alive: player.alive, isSheriff: player.isSheriff, death: player.death }))).toEqual(
        right.players.map((player) => ({ alive: player.alive, isSheriff: player.isSheriff, death: player.death }))
      );
      if (left.status === "ended" || right.status === "ended") break;
    }

    expect(left.status).toBe("ended");
    expect(right.status).toBe("ended");
    expect(left.winner).toBe(right.winner);
    expect(left.endReason).toBe(right.endReason);
  });

  it("uses test role overrides in seat order when provided", () => {
    const roleOverrides: RoleId[] = ["guard", "werewolf", "seer", "witch", "hunter", "villager"];
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "test-role-overrides",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides
    });

    expect(state.players.map((player) => player.role)).toEqual(roleOverrides);
    expect(state.events.some((event) => event.type === "RoleAssigned" && (event.payload as { role?: RoleId }).role === "guard")).toBe(true);
  });

  it("rejects multiple human players until private per-seat sessions are implemented", () => {
    expect(() =>
      createGame({
        totalPlayers: 6,
        humanPlayers: 2,
        aiPlayers: 4,
        seed: "multiple-humans-not-supported",
        rulePresetId: STANDARD_PRESET.id,
        debugMode: DEFAULT_DEBUG_MODE
      })
    ).toThrow("当前版本仅支持 0 或 1 名真人玩家");
  });

  it("rejects test role overrides that do not match the player count", () => {
    expect(() =>
      createGame({
        totalPlayers: 6,
        humanPlayers: 1,
        aiPlayers: 5,
        seed: "bad-test-role-overrides",
        rulePresetId: STANDARD_PRESET.id,
        debugMode: DEFAULT_DEBUG_MODE,
        roleOverrides: ["werewolf"]
      })
    ).toThrow("测试身份数量必须等于总人数");
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

  it("keeps mock sheriff candidacy aligned with the wolf night plan", () => {
    const state = createGame({
      totalPlayers: 12,
      humanPlayers: 0,
      aiPlayers: 12,
      seed: "mock-wolf-sheriff-plan",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const seat = (seatNumber: number) => {
      const player = state.players.find((item) => item.seatNumber === seatNumber);
      if (!player) throw new Error(`missing seat ${seatNumber}`);
      return player;
    };
    for (const player of state.players) player.role = "villager";
    for (const seatNumber of [1, 6, 9, 12]) seat(seatNumber).role = "werewolf";
    const seat6 = seat(6);
    state.day = 1;
    state.phase = { type: "sheriff_candidacy", day: 1, label: "警长竞选 · 是否上警" };
    state.pendingActions = [{ kind: "sheriff_candidacy", seatId: seat6.id }];
    state.events.push(
      {
        id: "event_mock_wolf_plan_runner",
        gameId: state.id,
        seq: state.events.length + 1,
        type: "WolfDiscussionMessage",
        visibility: "private",
        seatId: seat(1).id,
        payload: {
          seatId: seat(1).id,
          round: 1,
          messageToWolves: "我来一波自刀，骗一个银水，然后悍跳预言家，大家警下投我，你们都别上警我来上。",
          proposedTarget: seat(1).id,
          agreeCurrentProposal: true
        },
        createdAt: new Date().toISOString()
      },
      {
        id: "event_mock_wolf_plan_seat6_stay_down",
        gameId: state.id,
        seq: state.events.length + 2,
        type: "WolfDiscussionMessage",
        visibility: "private",
        seatId: seat6.id,
        payload: {
          seatId: seat6.id,
          round: 1,
          messageToWolves: "我同意1号自刀悍跳的方案。我明天不上警，警下直接冲票。",
          proposedTarget: seat(1).id,
          agreeCurrentProposal: true
        },
        createdAt: new Date().toISOString()
      }
    );

    const decision = createMockDecision(state);

    expect(decision?.command).toMatchObject({ type: "SubmitSheriffCandidacy", seatId: seat6.id, runForSheriff: false });
  });

  it("keeps mock wolf discussion from defaulting to teammates or exact repeated lines", () => {
    const humanWolfState = createGame({
      totalPlayers: 8,
      humanPlayers: 1,
      aiPlayers: 7,
      seed: "ui-wolf-0",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const decision = createMockDecision(humanWolfState);
    const command = decision?.command;
    if (!command || command.type !== "SubmitWolfDiscussionMessage") throw new Error("expected wolf discussion");
    expect(humanWolfState.players.find((player) => player.id === command.proposedTargetId)?.role).not.toBe("werewolf");

    let allAIState = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "mock-wolf-variety",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    for (let index = 0; index < 12 && allAIState.events.filter((event) => event.type === "WolfDiscussionMessage").length < 3; index += 1) {
      allAIState = applyMockStep(allAIState);
    }
    const messages = allAIState.events
      .filter((event) => event.type === "WolfDiscussionMessage")
      .map((event) => String((event.payload as { messageToWolves?: string }).messageToWolves));

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(messages).size).toBe(messages.length);
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

  it("lets the guard skip protection", () => {
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "guard-skip",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const pending = state.pendingActions.find((action) => action.kind === "guard_protect");
    if (!pending || pending.kind !== "guard_protect") throw new Error("expected guard pending action");

    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: pending.seatId,
      action: "guard_protect",
      targetId: "skip",
      privateReason: "测试守卫空守。"
    });

    const guardEvent = state.events.find((event) => event.type === "NightActionSubmitted" && event.seatId === pending.seatId);
    expect(state.round.night?.protectedTarget).toBeUndefined();
    expect(state.phase.type).toBe("night_wolves");
    expect(guardEvent?.payload).toMatchObject({ action: "guard_protect" });
    expect((guardEvent?.payload as { targetId?: string } | undefined)?.targetId).toBeUndefined();
  });

  it("prevents the guard from protecting the same target on consecutive nights", () => {
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "guard-repeat-target",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const firstPending = state.pendingActions.find((action) => action.kind === "guard_protect");
    if (!firstPending || firstPending.kind !== "guard_protect") throw new Error("expected guard pending action");
    const firstTargetId = firstPending.seatId;

    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: firstPending.seatId,
      action: "guard_protect",
      targetId: firstTargetId,
      privateReason: "测试首夜守卫自守。"
    });

    expect(state.round.lastGuardTarget).toBe(firstTargetId);

    for (let index = 0; index < 300 && !(state.phase.type === "night_guard" && state.round.night?.nightNumber === 1); index += 1) {
      state = applyMockStep(state);
    }

    expect(state.phase.type).toBe("night_guard");
    expect(state.round.night?.nightNumber).toBe(1);
    const secondPending = state.pendingActions.find((action) => action.kind === "guard_protect");
    if (!secondPending || secondPending.kind !== "guard_protect") throw new Error("expected second guard pending action");
    expect(secondPending.legalTargets).not.toContain(firstTargetId);
    expect(secondPending.legalTargets.every((id) => state.players.find((player) => player.id === id)?.alive)).toBe(true);
  });

  it("kills the wolf target when guard protection and witch save hit the same target", () => {
    let state = createGame({
      totalPlayers: 10,
      humanPlayers: 0,
      aiPlayers: 10,
      seed: "guard-witch-clash",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const guardPending = state.pendingActions.find((action) => action.kind === "guard_protect");
    if (!guardPending || guardPending.kind !== "guard_protect") throw new Error("expected guard pending action");
    const targetId = state.players.find((player) => player.alive && player.id !== guardPending.seatId && player.role !== "witch")?.id ?? guardPending.legalTargets[0];
    const witch = state.players.find((player) => player.role === "witch");
    if (!targetId || !witch) throw new Error("expected guard target and witch");

    state = applyCommand(state, {
      type: "SubmitNightAction",
      seatId: guardPending.seatId,
      action: "guard_protect",
      targetId,
      privateReason: "测试守卫守护刀口。"
    });
    state.round.night!.wolfTarget = targetId;
    state.phase = { type: "night_witch", day: 0, label: "夜晚 0 · 女巫行动", actingSeatId: witch.id };
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: targetId,
        canSave: true,
        canPoison: false,
        legalTargets: state.players.filter((player) => player.alive && player.id !== witch.id).map((player) => player.id)
      }
    ];

    state = applyCommand(state, {
      type: "SubmitWitchAction",
      seatId: witch.id,
      save: true,
      privateReason: "测试女巫解药同救刀口。"
    });

    expect(STANDARD_PRESET.witchRules.guardSaveSameTargetDies).toBe(true);
    expect(state.phase.type).toBe("sheriff_candidacy");
    expect(state.players.find((player) => player.id === targetId)?.alive).toBe(true);
    expect(state.round.lastDeaths).not.toContain(targetId);
    expect(state.round.pendingNightDeaths).toContainEqual({ seatId: targetId, reason: "wolf" });

    for (const action of [...state.pendingActions]) {
      state = applyCommand(state, {
        type: "SubmitSheriffCandidacy",
        seatId: action.seatId,
        runForSheriff: false,
        publicSpeech: "不上警。",
        privateReason: "测试首夜死亡延迟公布。"
      });
    }

    expect(state.players.find((player) => player.id === targetId)?.alive).toBe(false);
    expect(state.round.lastDeaths).toContain(targetId);
    expect(state.events.some((event) => event.type === "NightDeathsAnnounced")).toBe(true);
  });

  it("keeps first-night deaths alive and hidden through sheriff candidacy and voting", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "deferred-first-night-death",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"]
    });
    const witch = state.players[4];
    const nightDeath = state.players[7];
    state.round.night!.wolfTarget = nightDeath.id;
    state.phase = { type: "night_witch", day: 0, label: "夜晚 0 · 女巫行动", actingSeatId: witch.id };
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: nightDeath.id,
        canSave: true,
        canPoison: true,
        legalTargets: state.players.filter((player) => player.id !== witch.id).map((player) => player.id)
      }
    ];

    state = applyCommand(state, { type: "SubmitWitchAction", seatId: witch.id, save: false, privateReason: "测试延迟死亡。" });

    expect(state.phase.type).toBe("sheriff_candidacy");
    expect(state.players.find((player) => player.id === nightDeath.id)?.alive).toBe(true);
    expect(state.pendingActions.some((action) => action.kind === "sheriff_candidacy" && action.seatId === nightDeath.id)).toBe(true);
    expect(getPlayerVisibleEvents(state, state.players[6].id).some((event) => event.type === "PlayerKilled" || event.type === "NightDeathsAnnounced")).toBe(false);

    const candidates = [state.players[0].id, state.players[1].id];
    for (const action of [...state.pendingActions]) {
      state = applyCommand(state, {
        type: "SubmitSheriffCandidacy",
        seatId: action.seatId,
        runForSheriff: candidates.includes(action.seatId),
        publicSpeech: candidates.includes(action.seatId) ? "我上警。" : "我警下投票。",
        privateReason: "测试首夜死者参与警长流程。"
      });
    }
    while (state.phase.type === "sheriff_speech") {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "speech") throw new Error("expected sheriff speech");
      state = applyCommand(state, { type: "SubmitSpeech", seatId: pending.seatId, text: "警上测试发言。" });
    }
    while (state.phase.type === "sheriff_withdrawal") {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "sheriff_withdrawal") throw new Error("expected sheriff withdrawal");
      state = applyCommand(state, {
        type: "SubmitSheriffWithdrawalDecision",
        seatId: pending.seatId,
        withdraw: false,
        privateReason: "继续竞选。"
      });
    }

    expect(state.phase.type).toBe("sheriff_vote");
    expect(state.pendingActions.some((action) => action.kind === "vote" && action.seatId === nightDeath.id)).toBe(true);
    for (const action of [...state.pendingActions]) {
      state = applyCommand(state, {
        type: "SubmitVote",
        seatId: action.seatId,
        targetId: candidates[0],
        privateReason: "测试警徽票。"
      });
    }

    expect(state.players.find((player) => player.id === nightDeath.id)?.alive).toBe(false);
    expect(state.events.some((event) => event.type === "NightDeathsAnnounced" && (event.payload as { deaths?: string[] }).deaths?.includes(nightDeath.id))).toBe(true);
  });

  it("publishes simultaneous night deaths in stable seat order rather than cause order", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "stable-night-death-order",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"]
    });
    const witch = state.players[4];
    const poisoned = state.players[1];
    const wolfTarget = state.players[7];
    state.round.night!.wolfTarget = wolfTarget.id;
    state.phase = { type: "night_witch", day: 0, label: "夜晚 0 · 女巫行动", actingSeatId: witch.id };
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: wolfTarget.id,
        canSave: true,
        canPoison: true,
        legalTargets: state.players.filter((player) => player.id !== witch.id).map((player) => player.id)
      }
    ];
    state = applyCommand(state, {
      type: "SubmitWitchAction",
      seatId: witch.id,
      save: false,
      poisonTargetId: poisoned.id,
      privateReason: "测试死亡顺序。"
    });
    for (const action of [...state.pendingActions]) {
      state = applyCommand(state, {
        type: "SubmitSheriffCandidacy",
        seatId: action.seatId,
        runForSheriff: false,
        publicSpeech: "不上警。",
        privateReason: "测试死亡顺序。"
      });
    }

    const announced = state.events.find((event) => event.type === "NightDeathsAnnounced");
    const publicKills = state.events.filter((event) => event.type === "PlayerKilled" && event.visibility === "public");
    expect((announced?.payload as { deaths?: string[] }).deaths).toEqual([poisoned.id, wolfTarget.id]);
    expect(publicKills.map((event) => (event.payload as { targetId?: string }).targetId)).toEqual([poisoned.id, wolfTarget.id]);
  });

  it("allows witch self-save only on the first night when enabled", () => {
    const makeWitchPending = (nightNumber: number, allowSelfSaveFirstNight: boolean) => {
      const preset: RulePreset = {
        ...STANDARD_PRESET,
        id: `witch-self-save-${nightNumber}-${allowSelfSaveFirstNight}`,
        witchRules: { ...STANDARD_PRESET.witchRules, allowSelfSaveFirstNight }
      };
      let state = createGame(
        {
          totalPlayers: 6,
          humanPlayers: 0,
          aiPlayers: 6,
          seed: preset.id,
          rulePresetId: preset.id,
          debugMode: DEFAULT_DEBUG_MODE,
          roleOverrides: ["werewolf", "werewolf", "seer", "witch", "villager", "villager"]
        },
        preset
      );
      const seer = state.players[2];
      const witch = state.players[3];
      state.day = nightNumber;
      state.round.night = { nightNumber, wolfTarget: witch.id, witchSave: false };
      state.phase = { type: "night_seer", day: nightNumber, label: "预言家查验", actingSeatId: seer.id };
      state.pendingActions = [{ kind: "seer_check", seatId: seer.id, legalTargets: state.players.filter((player) => player.id !== seer.id).map((player) => player.id) }];
      state = applyCommand(state, {
        type: "SubmitNightAction",
        seatId: seer.id,
        action: "seer_check",
        targetId: witch.id,
        privateReason: "推进到女巫行动。"
      });
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "witch_action") throw new Error("expected witch action");
      return pending;
    };

    expect(makeWitchPending(0, true).canSave).toBe(true);
    expect(makeWitchPending(0, false).canSave).toBe(false);
    expect(makeWitchPending(1, true).canSave).toBe(false);
  });

  it("does not give last words to the player killed by a hunter shot", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "hunter-shot-last-words",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const hunter = state.players[0];
    const targetSheriff = state.players[1];
    const badgeRecipient = state.players[2];
    hunter.role = "hunter";
    targetSheriff.role = "villager";
    targetSheriff.isSheriff = true;
    state.sheriffSeatId = targetSheriff.id;
    state.day = 1;
    hunter.alive = false;
    hunter.death = { day: 1, phase: "day_vote", reason: "exile" };
    state.round.lastDeaths = [hunter.id];
    state.round.hunterReturn = "after_day";
    state.resources[hunter.id].hunterCanShoot = true;
    state.phase = { type: "hunter_shot", day: 1, label: "猎人开枪", actingSeatId: hunter.id };
    state.pendingActions = [{ kind: "hunter_shot", seatId: hunter.id, legalTargets: [targetSheriff.id, badgeRecipient.id], canSkip: true }];

    state = applyCommand(state, {
      type: "SubmitHunterShot",
      seatId: hunter.id,
      targetId: targetSheriff.id,
      privateReason: "测试猎人带走警长。"
    });
    expect(state.phase.type).toBe("badge_decision");

    state = applyCommand(state, {
      type: "SubmitBadgeDecision",
      seatId: targetSheriff.id,
      targetId: badgeRecipient.id,
      privateReason: "测试警徽移交。"
    });

    expect(state.phase.type).toBe("last_words");
    expect(state.pendingActions[0]).toMatchObject({ kind: "speech", seatId: hunter.id, speechType: "last_words" });
    expect(state.pendingActions[0]?.seatId).not.toBe(targetSheriff.id);
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

  it("blocks wolf self-explosion during settlement actions", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "wolf-self-explosion-phase-whitelist",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const wolf = state.players.find((player) => player.role === "werewolf");
    const hunter = state.players.find((player) => player.role === "hunter");
    const target = state.players.find((player) => player.id !== hunter?.id && player.role !== "werewolf");
    if (!wolf || !hunter || !target) throw new Error("expected wolf, hunter and target");
    hunter.alive = false;
    hunter.death = { day: 1, phase: "day_vote", reason: "exile" };
    state.day = 1;
    state.phase = { type: "hunter_shot", day: 1, label: "猎人开枪", actingSeatId: hunter.id };
    state.pendingActions = [{ kind: "hunter_shot", seatId: hunter.id, legalTargets: [target.id], canSkip: true }];

    expect(canWolfSelfExplode(state, wolf.id)).toBe(false);
    const next = applyCommand(state, { type: "SubmitWolfSelfExplosion", seatId: wolf.id, privateReason: "不得跳过猎人结算。" });
    expect(next.phase.type).toBe("hunter_shot");
    expect(next.pendingActions).toEqual(state.pendingActions);
    expect(next.players.find((player) => player.id === wolf.id)?.alive).toBe(true);

    for (const phase of ["badge_decision", "last_words", "death_announcement"] as const) {
      state.phase = { type: phase, day: 1, label: phase };
      expect(canWolfSelfExplode(state, wolf.id)).toBe(false);
    }
  });

  it("finishes the sheriff election and announces deferred night deaths after a wolf explodes", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "sheriff-self-explosion-cleanup",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"]
    });
    const witch = state.players[4];
    const wolf = state.players[0];
    const nightDeath = state.players[7];
    state.round.night!.wolfTarget = nightDeath.id;
    state.phase = { type: "night_witch", day: 0, label: "女巫行动", actingSeatId: witch.id };
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: nightDeath.id,
        canSave: true,
        canPoison: false,
        legalTargets: state.players.filter((player) => player.id !== witch.id).map((player) => player.id)
      }
    ];
    state = applyCommand(state, { type: "SubmitWitchAction", seatId: witch.id, save: false, privateReason: "测试自爆收尾。" });
    expect(state.phase.type).toBe("sheriff_candidacy");

    state = applyCommand(state, { type: "SubmitWolfSelfExplosion", seatId: wolf.id, privateReason: "竞选阶段自爆。" });

    expect(state.round.sheriff.completed).toBe(true);
    expect(state.sheriffSeatId).toBeUndefined();
    expect(state.players.find((player) => player.id === nightDeath.id)?.alive).toBe(false);
    expect(state.events.some((event) => event.type === "SheriffSkipped" && String((event.payload as { reason?: string }).reason).includes("自爆"))).toBe(true);
    expect(state.events.some((event) => event.type === "NightDeathsAnnounced" && (event.payload as { deaths?: string[] }).deaths?.includes(nightDeath.id))).toBe(true);
    expect(state.phase.type).toBe("last_words");

    state = applyCommand(state, { type: "ResolveTimeout", seatId: nightDeath.id });
    expect(state.phase.type.startsWith("night_")).toBe(true);
    expect(state.day).toBe(1);
  });

  it("does not announce or grant last words to a pending night-dead wolf that self-explodes", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "pending-night-dead-wolf-self-explosion",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager"]
    });
    const explodingWolf = state.players[0];
    const witch = state.players[4];
    state.round.night!.wolfTarget = explodingWolf.id;
    state.phase = { type: "night_witch", day: 0, label: "女巫行动", actingSeatId: witch.id };
    state.pendingActions = [
      {
        kind: "witch_action",
        seatId: witch.id,
        wolfTarget: explodingWolf.id,
        canSave: true,
        canPoison: false,
        legalTargets: state.players.filter((player) => player.id !== witch.id).map((player) => player.id)
      }
    ];
    state = applyCommand(state, { type: "SubmitWitchAction", seatId: witch.id, save: false, privateReason: "制造待公布夜死。" });
    expect(state.round.pendingNightDeaths).toContainEqual({ seatId: explodingWolf.id, reason: "wolf" });

    state = applyCommand(state, { type: "SubmitWolfSelfExplosion", seatId: explodingWolf.id, privateReason: "夜死公布前自爆。" });

    expect(state.players.find((player) => player.id === explodingWolf.id)?.death?.reason).toBe("self_explosion");
    expect(state.events.filter((event) => event.type === "WolfSelfExploded" && event.seatId === explodingWolf.id)).toHaveLength(1);
    const announcement = state.events.find((event) => event.type === "NightDeathsAnnounced");
    expect((announcement?.payload as { deaths?: string[] }).deaths).toEqual([]);
    expect(state.events.some((event) => event.type === "LastWordsPublished" && event.seatId === explodingWolf.id)).toBe(false);
    expect(state.round.lastWordsQueue).not.toContain(explodingWolf.id);
    expect(state.phase.type.startsWith("night_")).toBe(true);
    expect(state.day).toBe(1);
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

  it("resolves human night-action timeouts without selecting another AI pending action", () => {
    let guardState = createGame({
      totalPlayers: 10,
      humanPlayers: 1,
      aiPlayers: 9,
      seed: "human-guard-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["guard", "werewolf", "werewolf", "werewolf", "seer", "witch", "hunter", "villager", "villager", "villager"]
    });
    expect(guardState.pendingActions[0]).toMatchObject({ kind: "guard_protect", seatId: "player_1" });
    guardState = applyCommand(guardState, { type: "ResolveTimeout", seatId: "player_1" });
    expect(guardState.round.night?.protectedTarget).toBeUndefined();
    expect(guardState.phase.type).toBe("night_wolves");

    let wolfState = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "human-wolf-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["werewolf", "werewolf", "seer", "witch", "villager", "villager"]
    });
    const otherWolf = wolfState.players[1];
    wolfState.round.night!.wolfDiscussion = {
      speakerOrder: ["player_1", otherWolf.id],
      currentIndex: 0,
      turnCount: 0,
      maxTurns: 6,
      proposals: {},
      agreements: {},
      messages: []
    };
    wolfState.phase = { type: "night_wolves", day: 0, label: "狼人私聊", actingSeatId: "player_1" };
    wolfState.pendingActions = [{ kind: "wolf_discussion", seatId: "player_1", legalTargets: wolfState.players.map((player) => player.id), round: 1 }];
    wolfState = applyCommand(wolfState, { type: "ResolveTimeout", seatId: "player_1" });
    expect(wolfState.round.night?.wolfDiscussion?.messages[0]).toMatchObject({ seatId: "player_1" });
    expect(wolfState.pendingActions[0]?.seatId).toBe(otherWolf.id);

    let seerState = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "human-seer-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["seer", "werewolf", "werewolf", "witch", "villager", "villager"]
    });
    const seerTargets = seerState.players.slice(1).map((player) => player.id);
    seerState.phase = { type: "night_seer", day: 0, label: "预言家查验", actingSeatId: "player_1" };
    seerState.pendingActions = [{ kind: "seer_check", seatId: "player_1", legalTargets: seerTargets }];
    seerState = applyCommand(seerState, { type: "ResolveTimeout", seatId: "player_1" });
    expect(seerState.round.night?.seerCheck?.seerId).toBe("player_1");
    expect(seerState.phase.type).toBe("night_witch");

    let witchState = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "human-witch-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["witch", "werewolf", "werewolf", "seer", "villager", "villager"]
    });
    const wolfTarget = witchState.players[4].id;
    witchState.round.night!.wolfTarget = wolfTarget;
    witchState.phase = { type: "night_witch", day: 0, label: "女巫行动", actingSeatId: "player_1" };
    witchState.pendingActions = [
      {
        kind: "witch_action",
        seatId: "player_1",
        wolfTarget,
        canSave: true,
        canPoison: true,
        legalTargets: witchState.players.slice(1).map((player) => player.id)
      }
    ];
    witchState = applyCommand(witchState, { type: "ResolveTimeout", seatId: "player_1" });
    expect(witchState.round.night?.witchSave).toBe(false);
    expect(witchState.resources.player_1).toMatchObject({ antidote: true, poison: true });
    expect(witchState.phase.type).toBe("sheriff_candidacy");
  });

  it("resolves human sheriff, hunter, and badge timeouts with safe defaults", () => {
    let candidacyState = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "human-candidacy-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    candidacyState.phase = { type: "sheriff_candidacy", day: 0, label: "警长竞选" };
    candidacyState.pendingActions = [{ kind: "sheriff_candidacy", seatId: "player_1" }];
    candidacyState = applyCommand(candidacyState, { type: "ResolveTimeout", seatId: "player_1" });
    expect(candidacyState.round.sheriff.candidacy.player_1?.run).toBe(false);

    let hunterState = createGame({
      totalPlayers: 8,
      humanPlayers: 1,
      aiPlayers: 7,
      seed: "human-hunter-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE,
      roleOverrides: ["hunter", "werewolf", "werewolf", "werewolf", "seer", "witch", "villager", "villager"]
    });
    const hunter = hunterState.players[0];
    hunter.alive = false;
    hunter.death = { day: 1, phase: "day_vote", reason: "exile" };
    hunterState.day = 1;
    hunterState.round.lastDeaths = [hunter.id];
    hunterState.round.hunterReturn = "after_day";
    hunterState.phase = { type: "hunter_shot", day: 1, label: "猎人开枪", actingSeatId: hunter.id };
    hunterState.pendingActions = [{ kind: "hunter_shot", seatId: hunter.id, legalTargets: hunterState.players.filter((player) => player.alive).map((player) => player.id), canSkip: true }];
    hunterState = applyCommand(hunterState, { type: "ResolveTimeout", seatId: hunter.id });
    expect(hunterState.resources[hunter.id].hunterCanShoot).toBe(false);
    expect(hunterState.events.some((event) => event.type === "HunterShotSkipped" && event.seatId === hunter.id)).toBe(true);

    let badgeState = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "human-badge-timeout",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const deadSheriff = badgeState.players[0];
    deadSheriff.alive = false;
    deadSheriff.death = { day: 1, phase: "day_vote", reason: "exile" };
    badgeState.day = 1;
    badgeState.phase = { type: "badge_decision", day: 1, label: "警徽移交", actingSeatId: deadSheriff.id };
    badgeState.pendingActions = [
      {
        kind: "badge_decision",
        seatId: deadSheriff.id,
        legalTargets: badgeState.players.filter((player) => player.alive).map((player) => player.id),
        canDestroy: true,
        returnTo: "after_day_exile",
        deathIds: [deadSheriff.id]
      }
    ];
    badgeState = applyCommand(badgeState, { type: "ResolveTimeout", seatId: deadSheriff.id });
    expect(badgeState.badgeDestroyed).toBe(true);
    expect(badgeState.events.some((event) => event.type === "BadgeDestroyed")).toBe(true);
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

  it("accepts valid snapshots throughout a complete game", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-every-phase",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let step = 0; step < 400; step += 1) {
      expect(() => restoreSnapshotFixture(createSnapshotFixture(state))).not.toThrow();
      if (state.status === "ended") break;
      state = applyMockStep(state);
    }
    expect(state.status).toBe("ended");
  });

  it("rejects snapshots with ghost actors, targets, resources, or round references", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-deep-validation",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const fixture = createSnapshotFixture(state);
    const corrupt = (mutate: (value: ReturnType<typeof createSnapshotFixture>) => void) => {
      const value = JSON.parse(JSON.stringify(fixture)) as ReturnType<typeof createSnapshotFixture>;
      mutate(value);
      return value;
    };

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          value.state.pendingActions[0].seatId = "player_ghost";
        })
      )
    ).toThrow("待处理行动玩家不存在");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          const pending = value.state.pendingActions[0];
          if (!("legalTargets" in pending)) throw new Error("expected legal targets");
          pending.legalTargets.push("player_ghost");
        })
      )
    ).toThrow("合法目标");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          delete (value.state.pendingActions[0] as unknown as Record<string, unknown>).legalTargets;
        })
      )
    ).toThrow("缺少合法目标列表");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          value.state.pendingActions = [];
        })
      )
    ).toThrow("必须包含匹配的待处理行动");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          value.state.phase.actingSeatId = "player_ghost";
        })
      )
    ).toThrow("阶段行动玩家不存在");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          value.state.resources.player_ghost = { antidote: false, poison: false, hunterCanShoot: false };
        })
      )
    ).toThrow("资源引用了不存在的玩家");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          value.state.round.sheriff.speechQueue.push("player_ghost");
        })
      )
    ).toThrow("警上发言队列");

    expect(() =>
      restoreSnapshotFixture(
        corrupt((value) => {
          if (!value.state.round.night) throw new Error("expected night state");
          value.state.round.night.wolfTarget = "player_ghost";
        })
      )
    ).toThrow("狼人刀口不存在");
  });

  it("rejects pending actions whose kind-specific required fields are missing", () => {
    const base = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-pending-required-fields",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const actorId = base.players[0].id;
    const targetIds = base.players.slice(1).map((player) => player.id);
    const cases: Array<{
      phase: typeof base.phase.type;
      role: RoleId;
      dead?: boolean;
      pending: Record<string, unknown>;
    }> = [
      { phase: "night_guard", role: "guard", pending: { kind: "guard_protect", seatId: actorId } },
      { phase: "night_wolves", role: "werewolf", pending: { kind: "wolf_discussion", seatId: actorId, legalTargets: targetIds } },
      { phase: "night_seer", role: "seer", pending: { kind: "seer_check", seatId: actorId } },
      {
        phase: "night_witch",
        role: "witch",
        pending: { kind: "witch_action", seatId: actorId, legalTargets: targetIds, canPoison: true }
      },
      { phase: "sheriff_withdrawal", role: "villager", pending: { kind: "sheriff_withdrawal", seatId: actorId } },
      { phase: "day_speech", role: "villager", pending: { kind: "speech", seatId: actorId } },
      { phase: "day_vote", role: "villager", pending: { kind: "vote", seatId: actorId, legalTargets: targetIds } },
      {
        phase: "badge_decision",
        role: "villager",
        dead: true,
        pending: {
          kind: "badge_decision",
          seatId: actorId,
          legalTargets: targetIds,
          returnTo: "after_day_exile",
          deathIds: [actorId]
        }
      },
      {
        phase: "hunter_shot",
        role: "hunter",
        dead: true,
        pending: { kind: "hunter_shot", seatId: actorId, legalTargets: targetIds }
      }
    ];

    for (const testCase of cases) {
      const fixture = JSON.parse(JSON.stringify(createSnapshotFixture(base))) as ReturnType<typeof createSnapshotFixture>;
      const actor = fixture.state.players[0];
      actor.role = testCase.role;
      actor.alive = !testCase.dead;
      actor.death = testCase.dead ? { day: 1, phase: "day_vote", reason: "exile" } : undefined;
      fixture.state.phase = { type: testCase.phase, day: 1, label: testCase.phase, actingSeatId: actorId };
      fixture.state.pendingActions = [testCase.pending as never];

      expect(() => restoreSnapshotFixture(fixture), `${testCase.phase} should reject missing required fields`).toThrow();
    }
  });

  it("rejects stuck synchronous phases and inconsistent ended status snapshots", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-status-phase-consistency",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const makeFixture = () => JSON.parse(JSON.stringify(createSnapshotFixture(state))) as ReturnType<typeof createSnapshotFixture>;

    for (const phase of ["lobby", "night_resolve", "death_announcement"] as const) {
      const fixture = makeFixture();
      fixture.state.phase = { type: phase, day: 0, label: phase };
      fixture.state.pendingActions = [];
      expect(() => restoreSnapshotFixture(fixture)).toThrow("同步瞬时阶段");
    }

    const runningEnded = makeFixture();
    runningEnded.state.phase = { type: "ended", day: 0, label: "结束" };
    runningEnded.state.pendingActions = [];
    expect(() => restoreSnapshotFixture(runningEnded)).toThrow("运行中快照不能处于 ended 阶段");

    const endedInActionPhase = makeFixture();
    endedInActionPhase.state.status = "ended";
    endedInActionPhase.state.winner = "good";
    endedInActionPhase.state.endReason = "测试结束";
    endedInActionPhase.state.pendingActions = [];
    expect(() => restoreSnapshotFixture(endedInActionPhase)).toThrow("阶段必须为 ended");

    const endedWithoutWinner = makeFixture();
    endedWithoutWinner.state.status = "ended";
    endedWithoutWinner.state.phase = { type: "ended", day: 0, label: "结束" };
    endedWithoutWinner.state.pendingActions = [];
    endedWithoutWinner.state.winner = undefined;
    endedWithoutWinner.state.endReason = undefined;
    expect(() => restoreSnapshotFixture(endedWithoutWinner)).toThrow("缺少合法胜方");
  });

  it("rejects snapshots with incomplete or illegal nested rule presets", () => {
    const state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "snapshot-rule-preset-validation",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const corruptPreset = (mutate: (preset: Record<string, unknown>) => void) => {
      const fixture = JSON.parse(JSON.stringify(createSnapshotFixture(state))) as ReturnType<typeof createSnapshotFixture>;
      mutate(fixture.state.rulePreset as unknown as Record<string, unknown>);
      return fixture;
    };

    expect(() => restoreSnapshotFixture(corruptPreset((preset) => delete preset.nightOrder))).toThrow("nightOrder");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => (preset.nightOrder = [])))).toThrow("nightOrder");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => (preset.nightOrder = ["invalid_step"])))).toThrow("nightOrder");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => delete preset.voteRules))).toThrow("voteRules");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => delete preset.witchRules))).toThrow("witchRules");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => (preset.winCondition = "invalid")))).toThrow("基础字段");
    expect(() => restoreSnapshotFixture(corruptPreset((preset) => delete preset.roleTable))).toThrow("身份表");
  });

  it("rejects restored snapshots that bypass the single-human setup limit", () => {
    const state = createGame({
      totalPlayers: 6,
      humanPlayers: 1,
      aiPlayers: 5,
      seed: "snapshot-human-limit",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const fixture = createSnapshotFixture(state);
    fixture.state.setup.humanPlayers = 2;
    fixture.state.setup.aiPlayers = 4;

    expect(() => restoreSnapshotFixture(fixture)).toThrow("当前版本仅支持 0 或 1 名真人玩家");
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

  it("does not let withdrawn sheriff candidates vote for sheriff", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "sheriff-withdraw-no-vote",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });

    for (let index = 0; index < 20 && state.phase.type !== "sheriff_candidacy"; index += 1) {
      state = applyMockStep(state);
    }
    expect(state.phase.type).toBe("sheriff_candidacy");

    const aliveIds = state.players.filter((player) => player.alive).map((player) => player.id);
    const candidates = aliveIds.slice(0, 3);
    const withdrawnId = candidates[0];
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
    state = applyCommand(state, { type: "WithdrawSheriffCandidacy", seatId: withdrawnId, privateReason: "测试退水后无警长投票权。" });

    for (let guard = 0; guard < 8 && state.phase.type === "sheriff_speech"; guard += 1) {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "speech") throw new Error("expected sheriff speech pending action");
      state = applyCommand(state, {
        type: "SubmitSpeech",
        seatId: pending.seatId,
        text: "我继续留警，进入警下投票。",
        privateReason: "测试完成警上发言。"
      });
    }
    for (let guard = 0; guard < 8 && state.phase.type === "sheriff_withdrawal"; guard += 1) {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "sheriff_withdrawal") throw new Error("expected withdrawal pending action");
      state = applyCommand(state, {
        type: "SubmitSheriffWithdrawalDecision",
        seatId: pending.seatId,
        withdraw: false,
        privateReason: "测试继续留警。"
      });
    }

    expect(state.phase.type).toBe("sheriff_vote");
    expect(state.players.find((player) => player.id === withdrawnId)?.hasWithdrawnSheriff).toBe(true);
    expect(state.pendingActions.some((action) => action.seatId === withdrawnId)).toBe(false);
    expect(state.pendingActions.every((action) => action.kind === "vote" && !action.legalTargets.includes(withdrawnId))).toBe(true);
  });

  it("keeps every original sheriff candidate out of the PK vote", () => {
    let state = createGame({
      totalPlayers: 8,
      humanPlayers: 0,
      aiPlayers: 8,
      seed: "sheriff-pk-voter-eligibility",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const ids = state.players.map((player) => player.id);
    const candidates = ids.slice(0, 3);
    const voters = ids.slice(3);
    state.day = 0;
    state.round.sheriff.candidates = [...candidates];
    state.round.sheriff.candidacy = Object.fromEntries(
      ids.map((id) => [id, { run: candidates.includes(id), publicSpeech: "测试", privateReason: "测试" }])
    );
    for (const player of state.players) player.isSheriffCandidate = candidates.includes(player.id);
    state.phase = { type: "sheriff_vote", day: 0, label: "警长竞选 · 警下投票" };
    state.pendingActions = voters.map((seatId) => ({ kind: "vote", seatId, voteType: "sheriff", legalTargets: candidates }));

    const targets = [candidates[0], candidates[0], candidates[1], candidates[1], "abstain"] as const;
    voters.forEach((voterId, index) => {
      state = applyCommand(state, {
        type: "SubmitVote",
        seatId: voterId,
        targetId: targets[index],
        privateReason: "制造两人 PK。"
      });
    });
    expect(state.phase.type).toBe("sheriff_pk_speech");
    while (state.phase.type === "sheriff_pk_speech") {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "speech") throw new Error("expected PK speech");
      state = applyCommand(state, { type: "SubmitSpeech", seatId: pending.seatId, text: "PK 发言。" });
    }
    while (state.phase.type === "sheriff_withdrawal") {
      const pending = state.pendingActions[0];
      if (!pending || pending.kind !== "sheriff_withdrawal") throw new Error("expected PK withdrawal");
      state = applyCommand(state, {
        type: "SubmitSheriffWithdrawalDecision",
        seatId: pending.seatId,
        withdraw: false,
        privateReason: "继续 PK。"
      });
    }

    expect(state.phase.type).toBe("sheriff_pk_vote");
    expect(state.pendingActions.map((action) => action.seatId).sort()).toEqual(voters.sort());
    expect(state.pendingActions.some((action) => action.seatId === candidates[2])).toBe(false);
  });

  it("does not create a sheriff from zero votes or from a no-voter election", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "sheriff-zero-votes",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const ids = state.players.map((player) => player.id);
    const candidates = ids.slice(0, 2);
    const voters = ids.slice(2);
    state.round.sheriff.candidates = candidates;
    state.round.sheriff.candidacy = Object.fromEntries(
      ids.map((id) => [id, { run: candidates.includes(id), publicSpeech: "测试", privateReason: "测试" }])
    );
    for (const player of state.players) player.isSheriffCandidate = candidates.includes(player.id);
    state.phase = { type: "sheriff_vote", day: 0, label: "警长竞选 · 警下投票" };
    state.pendingActions = voters.map((seatId) => ({ kind: "vote", seatId, voteType: "sheriff", legalTargets: candidates }));
    for (const voterId of voters) {
      state = applyCommand(state, { type: "SubmitVote", seatId: voterId, targetId: "abstain", privateReason: "全员弃票。" });
    }
    expect(state.sheriffSeatId).toBeUndefined();
    expect(state.round.sheriff.completed).toBe(true);
    expect(state.events.some((event) => event.type === "SheriffElected")).toBe(false);
    expect(state.events.some((event) => event.type === "SheriffSkipped" && String((event.payload as { reason?: string }).reason).includes("有效票"))).toBe(true);
    expect(state.events.some((event) => event.type === "SheriffVoteResolved" && (event.payload as { top?: string[] }).top?.length === 0)).toBe(true);

    state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "sheriff-no-voters",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const allIds = state.players.map((player) => player.id);
    state.round.sheriff.candidates = [...allIds];
    state.round.sheriff.candidacy = Object.fromEntries(allIds.map((id) => [id, { run: true, publicSpeech: "测试", privateReason: "测试" }]));
    for (const player of state.players) player.isSheriffCandidate = true;
    state.phase = { type: "sheriff_withdrawal", day: 0, label: "警长竞选 · 退水确认" };
    state.pendingActions = allIds.map((seatId) => ({ kind: "sheriff_withdrawal", seatId, voteType: "sheriff" }));
    for (const seatId of allIds) {
      state = applyCommand(state, {
        type: "SubmitSheriffWithdrawalDecision",
        seatId,
        withdraw: false,
        privateReason: "全部留警。"
      });
    }
    expect(state.sheriffSeatId).toBeUndefined();
    expect(state.events.some((event) => event.type === "SheriffElected")).toBe(false);
    expect(state.events.some((event) => event.type === "SheriffSkipped" && String((event.payload as { reason?: string }).reason).includes("没有符合资格"))).toBe(true);
  });

  it("treats an all-abstain day vote as no exile instead of an all-player PK", () => {
    let state = createGame({
      totalPlayers: 6,
      humanPlayers: 0,
      aiPlayers: 6,
      seed: "day-all-abstain",
      rulePresetId: STANDARD_PRESET.id,
      debugMode: DEFAULT_DEBUG_MODE
    });
    const aliveIds = state.players.map((player) => player.id);
    state.day = 1;
    state.phase = { type: "day_vote", day: 1, label: "白天投票" };
    state.round.day = { speechQueue: [], votes: {}, pkCandidates: [], pkSpeechQueue: [], pkVotes: {} };
    state.pendingActions = aliveIds.map((seatId) => ({ kind: "vote", seatId, voteType: "day", legalTargets: aliveIds.filter((id) => id !== seatId) }));
    for (const voterId of aliveIds) {
      state = applyCommand(state, { type: "SubmitVote", seatId: voterId, targetId: "abstain", privateReason: "全员弃票。" });
    }

    expect(state.events.some((event) => event.type === "NoExile" && String((event.payload as { reason?: string }).reason).includes("有效票"))).toBe(true);
    expect(state.events.some((event) => event.type === "PlayerExiled")).toBe(false);
    expect(state.phase.type.startsWith("night_")).toBe(true);
    expect(state.day).toBe(2);
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
