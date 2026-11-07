import { authTools } from './auth.js';
import { directMessageTools } from './direct-messages.js';
import type { ToolDefinition } from './framework.js';
import { bookmarkTools, listTools, relationshipTools } from './lists-relationships.js';
import { platformTools } from './platform.js';
import { postTools, userTools } from './posts.js';
import { mediaTools, spaceTools } from './spaces-media.js';

/** Every registered tool, in scope order. */
export function allTools(): ToolDefinition[] {
  return [...postTools, ...userTools, ...listTools, ...bookmarkTools, ...relationshipTools, ...directMessageTools, ...spaceTools, ...mediaTools, ...platformTools, ...authTools];
}
