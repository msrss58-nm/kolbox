// Platform Stage 5 - TEST-ONLY fault-injection shim, substituted for
// api/election-day/_ownerAuth.ts by scripts/stage5/buildHandlers.mjs.
//
// Re-exports the REAL module unchanged, except that getServiceClient() returns
// the REAL service client wrapped in a Proxy. With no fault registered every
// call passes straight through to the real local stack. A test registers a
// fault on globalThis.__S5_FAULTS to make ONE named RPC or Auth-admin call
// fail (or answer) deterministically - this is how the provisioning failure
// branches (mint failure, seat failure, unconfirmed cleanup, audit-write
// failure, link failure) are exercised against real GoTrue + Postgres without
// touching production code. Never bundled into the app or deployed.
import * as real from "kolbox-real-owner-auth";

export const extractBearerToken = real.extractBearerToken;
export const verifyOwnerJwt = real.verifyOwnerJwt;
export const getAnonAuthClient = real.getAnonAuthClient;

function faults() {
  return globalThis.__S5_FAULTS ?? {};
}

function wrapAdmin(adminApi) {
  return new Proxy(adminApi, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args) => {
        const fault = faults().admin?.[prop];
        if (fault) return Promise.resolve(fault(...args));
        return value.apply(target, args);
      };
    },
  });
}

function wrapAuth(authApi) {
  return new Proxy(authApi, {
    get(target, prop) {
      if (prop === "admin") return wrapAdmin(target.admin);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function getServiceClient() {
  const client = real.getServiceClient();
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "rpc") {
        return (name, params) => {
          const fault = faults().rpc?.[name];
          if (fault) return Promise.resolve(fault(params));
          return target.rpc(name, params);
        };
      }
      if (prop === "auth") return wrapAuth(target.auth);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
