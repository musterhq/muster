#!/usr/bin/env node
// The CLI entry. It installs the warning filter first and only then loads the
// CLI, because Node emits the SQLite experimental warning while it links
// `node:sqlite`, before any statically imported module body runs.
import { installWarningFilter } from "./warning-filter.js";

installWarningFilter();
await import("./main.js");
