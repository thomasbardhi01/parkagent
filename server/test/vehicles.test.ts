/**
 * /me profile + vehicles CRUD: ownership, the global (plate, state)
 * uniqueness, and PATCH /me clearing phone_verified on a phone change.
 */

import { expect, test } from "vitest";

import { API_KEY, NONADMIN_API_KEY, makeTestApp, seedSession, seedVehicle } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };

test("GET /me returns the profile; PATCH edits name and phone", async () => {
  const { app, state } = makeTestApp({});
  // Start from a VERIFIED phone, or "unverified after the edit" would be
  // the seed's default rather than anything PATCH did.
  Object.assign(
    state.users.find((u) => u.id === "u1")!,
    {
      phone: "+1 617 555 0199",
      phoneVerified: true,
    },
  );
  const me = await app.inject({ method: "GET", url: "/me", headers: HEADERS });
  expect(me.statusCode).toBe(200);
  expect(me.json().user.name).toBe("Thomas");

  const patched = await app.inject({
    method: "PATCH",
    url: "/me",
    headers: HEADERS,
    payload: { name: "Tom", phone: "+1 617 555 0100" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().user.name).toBe("Tom");
  expect(patched.json().user.phone).toBe("+1 617 555 0100");
  // No verification flow ran — the phone is unverified by definition.
  expect(patched.json().user.phoneVerified).toBe(false);
  expect(state.users.find((u) => u.id === "u1")?.name).toBe("Tom");

  const bad = await app.inject({
    method: "PATCH",
    url: "/me",
    headers: HEADERS,
    payload: { phone: "not a phone" },
  });
  expect(bad.statusCode).toBe(400);
});

test("vehicles: add, list, edit, remove — scoped to the caller", async () => {
  const { app } = makeTestApp({});
  const created = await app.inject({
    method: "POST",
    url: "/me/vehicles",
    headers: HEADERS,
    payload: { plate: "abc 1234", state: "ny", label: "The wagon" },
  });
  expect(created.statusCode).toBe(200);
  const vehicle = created.json().vehicle;
  expect(vehicle).toMatchObject({ plate: "ABC 1234", state: "NY", label: "The wagon" });

  const listed = await app.inject({ method: "GET", url: "/me/vehicles", headers: HEADERS });
  expect(listed.json().vehicles).toHaveLength(1);

  // Another user can't see, edit, or delete it.
  const otherHeaders = { "x-api-key": NONADMIN_API_KEY };
  const otherList = await app.inject({ method: "GET", url: "/me/vehicles", headers: otherHeaders });
  expect(otherList.json().vehicles).toHaveLength(0);
  const foreignPatch = await app.inject({
    method: "PATCH",
    url: `/me/vehicles/${vehicle.id}`,
    headers: otherHeaders,
    payload: { label: "mine now" },
  });
  expect(foreignPatch.statusCode).toBe(404);
  const foreignDelete = await app.inject({
    method: "DELETE",
    url: `/me/vehicles/${vehicle.id}`,
    headers: otherHeaders,
  });
  expect(foreignDelete.statusCode).toBe(404);
  const stillThere = await app.inject({ method: "GET", url: "/me/vehicles", headers: HEADERS });
  expect(stillThere.json().vehicles.map((v: { id: string }) => v.id)).toEqual([vehicle.id]);

  const patched = await app.inject({
    method: "PATCH",
    url: `/me/vehicles/${vehicle.id}`,
    headers: HEADERS,
    payload: { label: null },
  });
  expect(patched.json().vehicle.label).toBeNull();

  const deleted = await app.inject({
    method: "DELETE",
    url: `/me/vehicles/${vehicle.id}`,
    headers: HEADERS,
  });
  expect(deleted.statusCode).toBe(200);
  const after = await app.inject({ method: "GET", url: "/me/vehicles", headers: HEADERS });
  expect(after.json().vehicles).toHaveLength(0);
});

test("a plate already registered (any user) refuses with plate_taken", async () => {
  const { app, state } = makeTestApp({});
  seedVehicle(state, { userId: "u2", plate: "TAKEN1", state: "MA" });
  const res = await app.inject({
    method: "POST",
    url: "/me/vehicles",
    headers: HEADERS,
    payload: { plate: "TAKEN1", state: "MA" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("plate_taken");
});

test("deleting a vehicle detaches its sessions but keeps them", async () => {
  const { app, state } = makeTestApp({});
  const vehicle = seedVehicle(state, { userId: "u1", plate: "GONE12", state: "NY" });
  const session = seedSession(state, { userId: "u1", vehicleId: vehicle.id, status: "stopped" });

  const res = await app.inject({
    method: "DELETE",
    url: `/me/vehicles/${vehicle.id}`,
    headers: HEADERS,
  });
  expect(res.statusCode).toBe(200);
  expect(state.vehicles).toHaveLength(0);
  expect(state.sessions.find((s) => s.id === session.id)?.vehicleId).toBeNull();
});
