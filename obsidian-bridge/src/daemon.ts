#!/usr/bin/env node
import { startLocalDaemon } from "./local-daemon.js";

const daemon = await startLocalDaemon();
const close = () => { void daemon.close().finally(() => process.exit(0)); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
