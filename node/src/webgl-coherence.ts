/**
 * WebGL limit coherence of a persona profile, mirroring the engine's strict loader.
 *
 * ONE table keyed by (os_family, browser_family). Each row lists the relations as data (the sum of
 * the `sum` limits must not exceed the `max` limit) and the engine's own value for each limit a
 * profile leaves out. Evaluation is over the MERGED record: webgl1 first, then webgl2 overwriting
 * key by key. A relation is evaluated, with absent limits filled from the row's defaults, when at
 * least one of its limits is present; a relation with none present is skipped. A present limit
 * that is not a non-negative integer is a violation. A pair without a row has no rule; a new
 * platform or browser family is a new row. Keep in step with the engine and the
 * cloud's webgl-coherence-rules.ts.
 */

export interface WebGLRelation {
  sum: readonly string[];
  max: string;
}

export interface WebGLRuleRow {
  relations: readonly WebGLRelation[];
  defaults: Readonly<Record<string, number>>;
}

const CHROMIUM_DESKTOP: WebGLRuleRow = {
  relations: [
    { sum: ["MAX_VERTEX_UNIFORM_BLOCKS", "MAX_FRAGMENT_UNIFORM_BLOCKS"], max: "MAX_COMBINED_UNIFORM_BLOCKS" },
    { sum: ["MAX_COMBINED_UNIFORM_BLOCKS"], max: "MAX_UNIFORM_BUFFER_BINDINGS" },
    { sum: ["MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_TEXTURE_IMAGE_UNITS"], max: "MAX_COMBINED_TEXTURE_IMAGE_UNITS" },
  ],
  defaults: {
    MAX_VERTEX_UNIFORM_BLOCKS: 12,
    MAX_FRAGMENT_UNIFORM_BLOCKS: 12,
    MAX_COMBINED_UNIFORM_BLOCKS: 24,
    MAX_UNIFORM_BUFFER_BINDINGS: 24,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
    MAX_TEXTURE_IMAGE_UNITS: 16,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  },
};

/** Rule rows by `${os_family}/${browser_family}`. */
export const WEBGL_COHERENCE_RULES: Readonly<Record<string, WebGLRuleRow>> = {
  "windows/chromium": CHROMIUM_DESKTOP,
  "linux/chromium": CHROMIUM_DESKTOP,
  "macos/chromium": CHROMIUM_DESKTOP,
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Violations, as readable strings, of the rule row for (osFamily, browserFamily) in the merged
 * record of `webgl1` and `webgl2` parameter objects. Empty for an unknown pair.
 * Message: `incoherent WebGL limits: webgl2 A (14) + B (12) exceeds C (24)`; the set label is
 * webgl2 when any limit of the relation comes from webgl2, else webgl1.
 */
export function webglLimitViolations(
  osFamily: string,
  browserFamily: string,
  webgl1: Record<string, unknown> | undefined,
  webgl2: Record<string, unknown> | undefined,
): string[] {
  const row = WEBGL_COHERENCE_RULES[`${osFamily}/${browserFamily}`];
  if (row === undefined) return [];
  const find = (key: string): { value: unknown; set: "webgl1" | "webgl2" } | undefined => {
    if (webgl2 && webgl2[key] !== undefined) return { value: webgl2[key], set: "webgl2" };
    if (webgl1 && webgl1[key] !== undefined) return { value: webgl1[key], set: "webgl1" };
    return undefined;
  };
  const out: string[] = [];
  const reported = new Set<string>();
  for (const relation of row.relations) {
    const keys = [...relation.sum, relation.max];
    if (!keys.some((k) => find(k) !== undefined)) continue;
    let usable = true;
    let set: "webgl1" | "webgl2" = "webgl1";
    const values: number[] = [];
    for (const k of keys) {
      const found = find(k);
      if (found !== undefined) {
        if (found.set === "webgl2") set = "webgl2";
        if (!isCount(found.value)) {
          usable = false;
          if (!reported.has(k)) {
            reported.add(k);
            out.push(`${k} must be a non-negative integer, got ${JSON.stringify(found.value)}`);
          }
          continue;
        }
        values.push(found.value);
      } else {
        const fallback = row.defaults[k];
        if (fallback === undefined) usable = false;
        else values.push(fallback);
      }
    }
    if (!usable) continue;
    const total = values.slice(0, -1).reduce((a, b) => a + b, 0);
    const max = values[values.length - 1];
    if (total > max) {
      const sums = relation.sum.map((k, i) => `${k} (${values[i]})`).join(" + ");
      out.push(`incoherent WebGL limits: ${set} ${sums} exceeds ${relation.max} (${max})`);
    }
  }
  return out;
}
