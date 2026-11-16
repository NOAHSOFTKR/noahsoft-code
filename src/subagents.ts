import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk';

export const SUBAGENT_NAMES = ['explorer', 'reviewer'] as const;
export const SUBAGENT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', ...(process.platform === 'win32' ? ['PowerShell'] : [])];

export function subagentDefinitions(effort?: Options['effort']): Record<string, AgentDefinition> {
  const prompt = 'You are a CVP CLI subagent. You may read, edit, and run commands only under the assigned permission policy. Work only inside the parent working directory and explicitly allowed additional directories. Never delegate further or bypass permission denials. Coordinate file ownership with the parent and avoid concurrent edits to the same file. Report concrete findings with file paths and distinguish facts from uncertainty. Answer in the user\'s language.';
  return {
    explorer: {
      description: 'Explore code, locate implementations, and explain project structure. Use for independent research tasks.',
      prompt, tools: [...SUBAGENT_TOOLS], model: 'inherit', effort, maxTurns: 12, background: false,
    },
    reviewer: {
      description: 'Review code changes for logical errors, security issues, edge cases, and consistency. Use for independent verification.',
      prompt, tools: [...SUBAGENT_TOOLS], model: 'inherit', effort, maxTurns: 12, background: false,
    },
  };
}

/** Validate delegation and keep it local, synchronous, and on the configured model. */
export function delegationInput(input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!SUBAGENT_NAMES.some((name) => name === input.subagent_type)) return undefined;
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.description !== 'string' || !input.description.trim()) return undefined;
  if (input.isolation !== undefined || input.run_in_background === true) return undefined;
  return { description: input.description, prompt: input.prompt, subagent_type: input.subagent_type, run_in_background: false };
}
