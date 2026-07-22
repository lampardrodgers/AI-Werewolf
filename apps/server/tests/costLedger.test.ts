import { describe, expect, it } from "vitest";
import { CostLedger, CostLimitError } from "../src/costLedger";

const controls = {
  enabled: true,
  maxGameCost: 1,
  maxSeatCost: 0.75,
  maxOutputTokensPerCall: 1000
};

describe("server cost ledger", () => {
  it("atomically includes active reservations in game and seat limits", () => {
    const ledger = new CostLedger();
    const first = ledger.reserve("game-1", "player_1", 0.6, controls);

    expect(() => ledger.reserve("game-1", "player_2", 0.5, controls)).toThrow(CostLimitError);
    expect(() => ledger.reserve("game-1", "player_1", 0.2, controls)).toThrow(CostLimitError);
    expect(ledger.totals("game-1")).toEqual({ used: 0, reserved: 0.6 });

    ledger.settle(first, 0.4);
    expect(ledger.totals("game-1")).toEqual({ used: 0.4, reserved: 0 });
    expect(ledger.reserve("game-1", "player_2", 0.5, controls)).toBeDefined();
  });

  it("does not let client-side history reset server-accounted spend", () => {
    const ledger = new CostLedger();
    const first = ledger.reserve("game-1", "player_1", 0.7, controls);
    ledger.settle(first, 0.7);

    expect(() => ledger.reserve("game-1", "player_2", 0.31, controls)).toThrow("将超过上限");
    expect(ledger.totals("game-1")).toEqual({ used: 0.7, reserved: 0 });
  });
});
