import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { getOrderStatus, cancelOrder, resetMockOrders } from "../mcp-server/src/oms.ts";

beforeEach(() => resetMockOrders());
test("unknown mock orders cannot be looked up or cancelled", async () => {
  assert.equal(await getOrderStatus("missing"), null);
  assert.equal((await cancelOrder("missing")).reason, "ORDER_NOT_FOUND");
});
test("shipped mock orders remain unchanged after cancellation rejection", async () => {
  const before = await getOrderStatus("1001");
  const result = await cancelOrder("1001");
  assert.equal(result.success, false);
  assert.equal(result.reason, "NOT_CANCELLABLE");
  assert.deepEqual(await getOrderStatus("1001"), before);
});
test("processing mock order cancels once and lookup snapshots cannot mutate state", async () => {
  const snapshot = await getOrderStatus("1002");
  assert.ok(snapshot);
  snapshot.status = "Delivered";
  assert.equal((await getOrderStatus("1002"))?.status, "Processing");
  const result = await cancelOrder("1002");
  assert.equal(result.success, true);
  assert.equal(result.status, "Cancelled");
  assert.equal((await getOrderStatus("1002"))?.canCancel, false);
  assert.equal((await cancelOrder("1002")).success, false);
});
