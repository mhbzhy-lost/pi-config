import test from "node:test";
test("controlled observation fail fixture", () => { throw Error("controlled failure"); });
