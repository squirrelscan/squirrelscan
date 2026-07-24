// CLI prompting utilities

import { createInterface } from "node:readline";

/**
 * Prompt for text input from the user
 */
export async function promptForInput(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a project name when targeting local addresses
 */
export async function promptForProjectName(
  suggestedName: string,
  url: string
): Promise<string> {
  console.log("");
  console.log(`Local development URL detected: ${url}`);
  console.log(`Default project name: ${suggestedName}`);
  console.log("Tip: Set [project].name in squirrel.toml to skip this prompt.");
  console.log("");

  const input = await promptForInput(`Project name [${suggestedName}]: `);
  return input || suggestedName;
}
