import { directMessageTools } from './direct-messages.js';
import type { ToolDefinition } from './framework.js';
import { bookmarkTools, listTools, relationshipTools } from './lists-relationships.js';
import { postTools, userTools } from './posts.js';

/** Every registered tool, in scope order. */
export function allTools(): ToolDefinition[] {
  return [...postTools, ...userTools, ...listTools, ...bookmarkTools, ...relationshipTools, ...directMessageTools];
}
