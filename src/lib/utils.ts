/**
 * Tailwind class-name combiner. Filters falsy values and flattens nested
 * arrays/objects. No runtime dependencies.
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | { [key: string]: boolean | undefined | null }
  | ClassValue[];

export function cn(...values: ClassValue[]): string {
  const classes: string[] = [];

  const append = (value: ClassValue): void => {
    if (!value && value !== 0) return;
    if (typeof value === "string" || typeof value === "number") {
      classes.push(String(value));
    } else if (Array.isArray(value)) {
      value.forEach(append);
    } else if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (value[key]) classes.push(key);
      }
    }
  };

  values.forEach(append);
  return classes.join(" ");
}
