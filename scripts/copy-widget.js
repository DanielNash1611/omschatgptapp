const path = require("node:path");
const fs = require("node:fs/promises");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.resolve(repoRoot, "frontend", "dist");
const targetDir = path.resolve(repoRoot, "mcp-server", "widget-dist");
const sourceWidgetHtml = path.resolve(sourceDir, "widget.html");
const sourceIndexHtml = path.resolve(sourceDir, "index.html");
const targetWidgetHtml = path.resolve(targetDir, "widget.html");
const targetIndexHtml = path.resolve(targetDir, "index.html");

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

  const hasWidget = await pathExists(sourceWidgetHtml);
  const hasIndex = await pathExists(sourceIndexHtml);
  if (!hasWidget && hasIndex) {
    await fs.copyFile(targetIndexHtml, targetWidgetHtml);
    console.log("[copy-widget] created widget.html from index.html");
  }

  console.log("[copy-widget] copied:", sourceDir, "->", targetDir);
};

main().catch(error => {
  console.error("[copy-widget] failed:", error);
  process.exit(1);
});
