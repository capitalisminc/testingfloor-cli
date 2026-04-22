import { runAction } from "./action-core.js";

runAction().catch((error) => {
  console.error(`::error::${escapeCommand(error.message)}`);
  process.exitCode = 1;
});

function escapeCommand(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
