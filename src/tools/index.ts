import type { ToolDefinition } from './framework.js';
import { postTools, userTools } from './posts.js';

/** Every registered tool, in scope order. */
export function allTools(): ToolDefinition[] {
  return [...postTools, ...userTools];
}
