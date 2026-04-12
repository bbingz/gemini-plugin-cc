import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".claude", "gemini-plugin");

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function configFilePath(workspaceRoot) {
  const slug = workspaceRoot
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return path.join(CONFIG_DIR, `config-${slug}.json`);
}

export function getConfig(workspaceRoot) {
  const file = configFilePath(workspaceRoot);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function setConfig(workspaceRoot, key, value) {
  ensureConfigDir();
  const config = getConfig(workspaceRoot);
  config[key] = value;
  fs.writeFileSync(configFilePath(workspaceRoot), JSON.stringify(config, null, 2) + "\n");
}
