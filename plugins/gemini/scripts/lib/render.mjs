/**
 * Render setup report as human-readable markdown.
 */
export function renderSetupReport(report) {
  const lines = [];

  lines.push("## Gemini CLI Status\n");

  const status = report.ready ? "Ready" : "Not Ready";
  lines.push(`**Status:** ${status}\n`);

  lines.push("| Component | Status | Detail |");
  lines.push("|-----------|--------|--------|");
  lines.push(
    `| Node.js | ${report.node.available ? "OK" : "Missing"} | ${report.node.detail} |`
  );
  lines.push(
    `| npm | ${report.npm.available ? "OK" : "Missing"} | ${report.npm.detail} |`
  );
  lines.push(
    `| Gemini CLI | ${report.gemini.available ? "OK" : "Missing"} | ${report.gemini.detail} |`
  );
  lines.push(
    `| Authentication | ${report.auth.loggedIn ? "OK" : "Not logged in"} | ${report.auth.detail} |`
  );

  if (report.auth.model) {
    lines.push(`\n**Default model:** ${report.auth.model}`);
  }

  if (report.actionsTaken.length > 0) {
    lines.push("\n**Actions taken:**");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("\n**Next steps:**");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Render ask/review result as human-readable markdown.
 */
export function renderGeminiResult(result) {
  if (!result.ok) {
    return `**Error:** ${result.error}\n`;
  }

  const lines = [];
  lines.push(result.response);

  // Token stats
  const models = result.stats?.models;
  if (models) {
    const modelName = Object.keys(models)[0];
    if (modelName) {
      const tokens = models[modelName]?.tokens;
      if (tokens) {
        lines.push("");
        lines.push(
          `---\n*Model: ${modelName} | Tokens: ${tokens.total?.toLocaleString() ?? "?"} (input: ${tokens.input?.toLocaleString() ?? "?"}, cached: ${tokens.cached?.toLocaleString() ?? "0"}) | Latency: ${models[modelName]?.api?.totalLatencyMs ?? "?"}ms*`
        );
      }
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Render review result with diff context.
 */
export function renderReviewResult(result, { truncated = false } = {}) {
  const lines = [];

  if (truncated) {
    lines.push(
      "> **Note:** The diff was truncated because it exceeded the size limit. Some changes may not be covered in this review.\n"
    );
  }

  lines.push(renderGeminiResult(result));
  return lines.join("\n");
}
