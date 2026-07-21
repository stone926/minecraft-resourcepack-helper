import * as assert from "node:assert";
import { RegistrationScope } from "../../registration/registrationScope";

describe("registration scope", () => {
  it("disposes registrations once in reverse order", () => {
    const order: number[] = [];
    const scope = new RegistrationScope();
    scope.subscriptions.push(
      { dispose: () => { order.push(1); } },
      { dispose: () => { order.push(2); } }
    );

    scope.dispose();
    scope.dispose();

    assert.deepStrictEqual(order, [2, 1]);
  });

  it("continues cleanup and aggregates disposal failures", () => {
    const order: number[] = [];
    const scope = new RegistrationScope();
    scope.subscriptions.push(
      { dispose: () => { order.push(1); } },
      { dispose: () => { order.push(2); throw new Error("two"); } },
      { dispose: () => { order.push(3); throw new Error("three"); } }
    );

    assert.throws(() => scope.dispose(), error => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors.length, 2);
      return true;
    });
    assert.deepStrictEqual(order, [3, 2, 1]);
  });
});
