declare module "wavedrom" {
  export function renderAny(
    index: number,
    source: Record<string, unknown>,
    skin: unknown,
  ): unknown[];
  export const waveSkin: unknown;
  const wavedrom: {
    renderAny: typeof renderAny;
    waveSkin: unknown;
  };
  export default wavedrom;
}

declare module "onml" {
  export function stringify(node: unknown[]): string;
  const onml: {
    stringify: typeof stringify;
  };
  export default onml;
}

declare module "bytefield-svg" {
  export default function bytefield(source: string): string;
}
