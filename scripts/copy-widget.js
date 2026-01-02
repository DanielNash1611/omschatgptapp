const path = require("node:path");
const fs = require("node:fs/promises");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.resolve(repoRoot, "frontend", "dist");
const targetDir = path.resolve(repoRoot, "mcp-server", "widget-dist");

const pathExists = async target => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  if (!(await pathExists(sourceDir))) {
    console.error("[copy-widget] source missing:", sourceDir);
    process.exitCode = 1;
    return;
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });

  console.log("[copy-widget] copied:", sourceDir, "->", targetDir);
};

main().catch(error => {
  console.error("[copy-widget] failed:", error);
  process.exit(1);
});
