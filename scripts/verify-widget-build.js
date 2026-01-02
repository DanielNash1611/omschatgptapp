const path = require("node:path");
const fs = require("node:fs/promises");

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(repoRoot, "frontend", "dist");
const widgetHtml = path.resolve(distDir, "widget.html");
const indexHtml = path.resolve(distDir, "index.html");

const pathExists = async target => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const listDir = async target => {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.map(entry =>
      entry.isDirectory() ? `${entry.name}/` : entry.name
    );
  } catch {
    return null;
  }
};

const main = async () => {
  const distExists = await pathExists(distDir);
  if (!distExists) {
    console.error("[verify-widget] dist missing:", distDir);
    process.exitCode = 1;
    return;
  }

  const hasWidget = await pathExists(widgetHtml);
  const hasIndex = await pathExists(indexHtml);
  if (!hasWidget && !hasIndex) {
    const listing = await listDir(distDir);
    console.error(
      "[verify-widget] missing widget.html and index.html in:",
      distDir
    );
    if (listing) {
      console.error("[verify-widget] dist contents:", listing.join(", "));
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "[verify-widget] ok:",
    hasWidget ? "widget.html" : "index.html"
  );
};

main().catch(error => {
  console.error("[verify-widget] failed:", error);
  process.exit(1);
});
