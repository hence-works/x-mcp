import { directMessageCases } from './direct-messages.js';
import { listsRelationshipsCases } from './lists-relationships.js';
import { postsUsersCases } from './posts-users.js';
import type { ContractCase } from './types.js';

export const contractCases: ContractCase[] = [...postsUsersCases, ...listsRelationshipsCases, ...directMessageCases];
