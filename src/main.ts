// Compiled entry point.
//
// @simplewebauthn/server pulls in @peculiar/x509 -> tsyringe, and tsyringe
// throws at import time unless a Reflect metadata polyfill is already loaded.
// x509 imports reflect-metadata itself, which is enough when modules load
// individually — but `bun build --compile` turns CommonJS imports into inline
// body assignments that run *after* every ESM dependency initializer, so no
// arrangement of static imports can get the polyfill in first.
//
// Two sequential dynamic imports force the ordering the bundler otherwise
// reorders away: the polyfill is fully evaluated before anything that needs it
// is even loaded.
//
// This fails only in the compiled binary, never under `bun test`, and a
// cross-compiled Linux binary cannot be run on the build Mac — which is why
// build-pi.sh boot-tests a natively-compiled binary before packaging.
await import("reflect-metadata");
await import("./index");
