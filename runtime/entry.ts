// Keep Bun/OpenCode diagnostics away from the private JSON-lines channel.
console.log = console.error.bind(console)
console.info = console.error.bind(console)
console.debug = console.error.bind(console)
await import("./native-worker.ts")
