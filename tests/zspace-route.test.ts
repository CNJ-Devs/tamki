import test from "node:test";
import assert from "node:assert/strict";
import { samePrivateNetwork, ZSpaceRoute } from "../src/providers/zspace-route";
const networks = () => ({
  en0: [
    {
      address: "192.168.42.2",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      internal: false,
      mac: "00:00:00:00:00:01",
      cidr: "192.168.42.2/24",
    },
  ],
});
test("LAN candidates must be private, on an active local subnet and not this machine", () => {
  for (const ip of [
    "192.168.43.2",
    "8.8.8.8",
    "127.0.0.1",
    "192.168.42.2",
    "192.168.42.999",
  ])
    assert.equal(samePrivateNetwork(ip, networks()), false);
  assert(samePrivateNetwork("192.168.42.10", networks()));
});
test("routing requires explicit HTTP consent and changes route after network changes", async () => {
  let consent = false,
    local = true,
    calls = 0;
  const route = new ZSpaceRoute(
    async (args) => {
      calls++;
      assert(args.includes("cloud"));
      return { list: [{ ipv4_address: "192.168.42.10", status: "up" }] };
    },
    () => consent,
    async (_ip, secure) => !secure,
    () => (local ? networks() : {}),
  );
  assert((await route.select()).includes("cloud"));
  consent = true;
  assert((await route.select()).includes("--allow-insecure-http"));
  await route.select();
  assert.equal(calls, 2);
  local = false;
  assert((await route.select()).includes("cloud"));
});
test("verified TLS is preferred; discovery failure falls back without disabling TLS", async () => {
  const route = new ZSpaceRoute(
    async () => ({ list: [{ ipv4_address: "192.168.42.10", status: "up" }] }),
    () => true,
    async () => true,
    networks,
  );
  assert.deepEqual(await route.select(), [
    "--mode",
    "lan",
    "--host",
    "https://192.168.42.10:5056",
  ]);
  const offline = new ZSpaceRoute(
    async () => {
      throw Error("offline");
    },
    () => true,
    async () => true,
    networks,
  );
  assert((await offline.select()).includes("cloud"));
});
