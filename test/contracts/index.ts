import { directMessageCases } from './direct-messages.js';
import { listsRelationshipsCases } from './lists-relationships.js';
import { postsUsersCases } from './posts-users.js';
import { spacesMediaCases } from './spaces-media.js';
import type { ContractCase } from './types.js';

export const contractCases: ContractCase[] = [...postsUsersCases, ...listsRelationshipsCases, ...directMessageCases, ...spacesMediaCases];
