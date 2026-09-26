export function readTemplate(src: string, openIdx: number): [string, number];
export function spliceTemplate(src: string, openIdx: number, endIdx: number, replacement: string): string;
export function guardInterpolations(code: string): { guarded: string; subs: string[] };
export function minifyInterpolatedJs(code: string): Promise<string>;
