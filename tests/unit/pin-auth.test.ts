import { describe, it, expect } from "vitest";
import { hashPin, verifyPin, evaluatePinAttempt, MAX_FAILED_PIN_ATTEMPTS } from "@rcs/auth";

describe("PIN hashing", () => {
  it("verifikuje ispravan PIN protiv sopstvenog hash-a", async () => {
    const hash = await hashPin("1234");
    expect(await verifyPin("1234", hash)).toBe(true);
  });

  it("odbija pogrešan PIN", async () => {
    const hash = await hashPin("1234");
    expect(await verifyPin("9999", hash)).toBe(false);
  });

  it("dva hash-a istog PIN-a nisu identična (random salt)", async () => {
    const a = await hashPin("1234");
    const b = await hashPin("1234");
    expect(a).not.toBe(b);
  });

  it("ne baca grešku i vraća false za malformisan hash", async () => {
    expect(await verifyPin("1234", "not-a-valid-hash")).toBe(false);
  });
});

describe("evaluatePinAttempt — lockout logika", () => {
  it("uspešan pokušaj resetuje brojač", () => {
    const result = evaluatePinAttempt({
      isCorrect: true,
      currentFailedAttempts: 3,
      lockedUntil: null,
    });
    expect(result.success).toBe(true);
    expect(result.newFailedAttempts).toBe(0);
    expect(result.newLockedUntil).toBeNull();
  });

  it("pogrešan pokušaj ispod limita samo uvećava brojač, ne zaključava", () => {
    const result = evaluatePinAttempt({
      isCorrect: false,
      currentFailedAttempts: 1,
      lockedUntil: null,
    });
    expect(result.success).toBe(false);
    expect(result.locked).toBe(false);
    expect(result.newFailedAttempts).toBe(2);
    expect(result.remainingAttempts).toBe(MAX_FAILED_PIN_ATTEMPTS - 2);
  });

  it("dostizanje MAX_FAILED_PIN_ATTEMPTS zaključava nalog i resetuje brojač", () => {
    const result = evaluatePinAttempt({
      isCorrect: false,
      currentFailedAttempts: MAX_FAILED_PIN_ATTEMPTS - 1,
      lockedUntil: null,
    });
    expect(result.locked).toBe(true);
    expect(result.newFailedAttempts).toBe(0);
    expect(result.newLockedUntil).toBeInstanceOf(Date);
  });

  it("dok je nalog zaključan, čak i ISPRAVAN PIN se odbija bez provere brojača", () => {
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000); // 5 min u budućnosti
    const result = evaluatePinAttempt({
      isCorrect: true,
      currentFailedAttempts: 0,
      lockedUntil,
    });
    expect(result.success).toBe(false);
    expect(result.locked).toBe(true);
    expect(result.newLockedUntil).toEqual(lockedUntil);
  });

  it("posle isteka lockout perioda, ispravan PIN ponovo prolazi", () => {
    const expiredLock = new Date(Date.now() - 1000); // istekao pre 1s
    const result = evaluatePinAttempt({
      isCorrect: true,
      currentFailedAttempts: 0,
      lockedUntil: expiredLock,
    });
    expect(result.success).toBe(true);
    expect(result.locked).toBe(false);
  });
});
