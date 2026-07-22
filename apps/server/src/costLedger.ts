import type { CostControls, PlayerId } from "@langrensha/shared";

const COST_EPSILON = 1e-12;

interface LedgerTotals {
  used: number;
  reserved: number;
}

export interface CostReservation {
  id: number;
  gameId: string;
  seatId: PlayerId;
  amount: number;
}

export class CostLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostLimitError";
  }
}

export class CostLedger {
  private readonly games = new Map<string, LedgerTotals>();
  private readonly seats = new Map<string, LedgerTotals>();
  private readonly reservations = new Map<number, CostReservation>();
  private nextReservationId = 1;

  reserve(gameId: string, seatId: PlayerId, amount: number, controls: CostControls): CostReservation {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("预算预留金额必须是有限非负数。");
    const game = this.getTotals(this.games, gameId);
    const seat = this.getTotals(this.seats, this.seatKey(gameId, seatId));
    const projectedGameCost = game.used + game.reserved + amount;
    const projectedSeatCost = seat.used + seat.reserved + amount;

    if (controls.maxGameCost > 0 && projectedGameCost - controls.maxGameCost > COST_EPSILON) {
      throw new CostLimitError(
        `成本保护：本次请求需预留 ${amount.toFixed(6)}，本局已使用/预留 ${(game.used + game.reserved).toFixed(6)}，将超过上限 ${controls.maxGameCost.toFixed(6)}。`
      );
    }
    if (controls.maxSeatCost > 0 && projectedSeatCost - controls.maxSeatCost > COST_EPSILON) {
      throw new CostLimitError(
        `成本保护：本次请求需预留 ${amount.toFixed(6)}，该 AI 已使用/预留 ${(seat.used + seat.reserved).toFixed(6)}，将超过上限 ${controls.maxSeatCost.toFixed(6)}。`
      );
    }

    const reservation: CostReservation = { id: this.nextReservationId++, gameId, seatId, amount };
    game.reserved += amount;
    seat.reserved += amount;
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  settle(reservation: CostReservation, chargedAmount: number): void {
    if (!Number.isFinite(chargedAmount) || chargedAmount < 0) throw new Error("预算结算金额必须是有限非负数。");
    if (!this.reservations.delete(reservation.id)) return;
    const game = this.getTotals(this.games, reservation.gameId);
    const seat = this.getTotals(this.seats, this.seatKey(reservation.gameId, reservation.seatId));
    game.reserved = Math.max(0, game.reserved - reservation.amount);
    seat.reserved = Math.max(0, seat.reserved - reservation.amount);
    game.used += chargedAmount;
    seat.used += chargedAmount;
  }

  release(reservation: CostReservation): void {
    if (!this.reservations.delete(reservation.id)) return;
    const game = this.getTotals(this.games, reservation.gameId);
    const seat = this.getTotals(this.seats, this.seatKey(reservation.gameId, reservation.seatId));
    game.reserved = Math.max(0, game.reserved - reservation.amount);
    seat.reserved = Math.max(0, seat.reserved - reservation.amount);
  }

  totals(gameId: string, seatId?: PlayerId): Readonly<LedgerTotals> {
    const source = seatId ? this.seats.get(this.seatKey(gameId, seatId)) : this.games.get(gameId);
    return source ? { ...source } : { used: 0, reserved: 0 };
  }

  reset(): void {
    this.games.clear();
    this.seats.clear();
    this.reservations.clear();
    this.nextReservationId = 1;
  }

  private getTotals(store: Map<string, LedgerTotals>, key: string): LedgerTotals {
    const existing = store.get(key);
    if (existing) return existing;
    const created = { used: 0, reserved: 0 };
    store.set(key, created);
    return created;
  }

  private seatKey(gameId: string, seatId: PlayerId): string {
    return `${gameId}\u0000${seatId}`;
  }
}
