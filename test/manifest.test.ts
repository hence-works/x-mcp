import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allTools } from '../src/tools/index.js';
import { contractCases } from './contracts/index.js';

interface ManifestParam {
  composio: string;
  required: boolean;
  in: string;
  composio_enum?: string[];
  x_enum?: string[];
}
interface ManifestTool {
  name: string;
  scope: string;
  endpoints: { operationId: string; method: string; path: string; auth: string[] }[];
  params: ManifestParam[];
}
const manifest = JSON.parse(readFileSync(new URL('../coverage/manifest.json', import.meta.url), 'utf8')) as {
  baseline: { tool_count: number };
  tools: ManifestTool[];
  extra_tools: { name: string; operationId: string }[];
};
const byName = new Map(manifest.tools.map((t) => [t.name, t]));
const tools = allTools();

/** Deliberate required-ness differences from Composio, each with a reason. */
const REQUIREDNESS_DEVIATIONS: Record<string, string> = {};

function templateRegex(path: string): RegExp {
  return new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$');
}

describe('coverage manifest conformance', () => {
  it('has the expected baseline size and unique tool names', () => {
    expect(manifest.tools).toHaveLength(manifest.baseline.tool_count);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  for (const tool of tools) {
    describe(tool.name, () => {
      const entry = byName.get(tool.name);
      const extra = manifest.extra_tools.find((e) => e.name === tool.name);

      it('is declared in the manifest with matching X operations', () => {
        if (!tool.composio) {
          expect(extra, 'non-Composio tools must be listed under extra_tools').toBeDefined();
          expect(tool.operationIds).toEqual([extra!.operationId]);
          return;
        }
        expect(entry, 'missing from coverage/manifest.json').toBeDefined();
        expect(tool.scope).toBe(entry!.scope);
        expect([...tool.operationIds]).toEqual(entry!.endpoints.map((e) => e.operationId));
      });

      it('accepts every Composio parameter with matching required-ness and the official enum', () => {
        if (!entry) return;
        const shape = tool.inputSchema.shape as Record<string, z.ZodType>;
        for (const p of entry.params) {
          const schema = shape[p.composio];
          expect(schema, `parameter ${p.composio} missing`).toBeDefined();
          const key = `${tool.name}.${p.composio}`;
          if (!REQUIREDNESS_DEVIATIONS[key]) {
            expect(schema!.safeParse(undefined).success, `${p.composio} required-ness`).toBe(!p.required);
          }
          const officialEnum = p.x_enum ?? p.composio_enum;
          if (officialEnum && p.in !== 'ignored') {
            for (const value of officialEnum) {
              const sample = schema!.safeParse(value);
              const arraySample = schema!.safeParse([value]);
              expect(sample.success || arraySample.success, `${p.composio} should accept official value ${value}`).toBe(true);
            }
          }
          if (p.x_enum && p.composio_enum) {
            for (const value of p.composio_enum.filter((v) => !p.x_enum!.includes(v))) {
              expect(schema!.safeParse(value).success, `${p.composio} should reject non-X value ${value}`).toBe(false);
            }
          }
        }
      });

      it('has a mocked contract case that hits the manifest endpoint', () => {
        const cases = contractCases.filter((c) => c.tool === tool.name);
        expect(cases.length, 'no contract case').toBeGreaterThan(0);
        const endpoints = entry?.endpoints ?? [];
        for (const c of cases) {
          for (const call of c.calls) {
            if (endpoints.length === 0) continue;
            const match = endpoints.some((e) => e.method === call.method && templateRegex(e.path).test(call.path));
            expect(match, `${call.method} ${call.path} is not a manifest endpoint`).toBe(true);
          }
        }
      });
    });
  }
});
