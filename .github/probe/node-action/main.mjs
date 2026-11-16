import { execFileSync } from "node:child_process";
console.log(`action.process_version: ${process.version}`);
console.log(`action.exec_path: ${process.execPath}`);
console.log(`action.path_node: ${execFileSync("node", ["--version"]).toString().trim()}`);
