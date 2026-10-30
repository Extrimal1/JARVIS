// ESM loader for assistant tests: resolves the `@/` tsconfig alias and
// extensionless relatives, and forces ESM for project TypeScript
// (package.json has no "type": "module"; Node type-strips .ts).
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function probe(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    path.join(base, "index.ts"),
  ];

  for (const candidate of candidates) {
    try {
      // Files only: `@/src/lib/finance` must resolve to finance.ts,
      // never to the sibling finance/ directory.
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Treat I/O errors as "not found".
    }
  }

  return null;
}

function withFormat(url) {
  if (url.endsWith(".ts") || url.endsWith(".tsx") || url.endsWith(".mts")) {
    // module-typescript: ESM + type stripping (plain "module" would
    // parse the file as JavaScript and choke on type syntax).
    return { url, format: "module-typescript", shortCircuit: true };
  }

  return { url, shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  // Test-only stand-in so route modules load outside the Next runtime.
  if (specifier === "next/server") {
    return {
      url: pathToFileURL(path.join(ROOT, "tests", "stubs", "next-server.mjs"))
        .href,
      shortCircuit: true,
    };
  }

  if (specifier.startsWith("@/")) {
    const found = probe(path.join(ROOT, specifier.slice(2)));

    if (found !== null) {
      return withFormat(pathToFileURL(found).href);
    }
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-z0-9]+$/i.test(specifier)
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const found = probe(
      path.join(path.dirname(parentPath), specifier),
    );

    if (found !== null) {
      return withFormat(pathToFileURL(found).href);
    }
  }

  const resolved = await nextResolve(specifier, context);

  if (
    typeof resolved.url === "string" &&
    (resolved.url.endsWith(".ts") || resolved.url.endsWith(".tsx"))
  ) {
    try {
      const location = fileURLToPath(resolved.url);

      if (location.startsWith(ROOT) && !location.includes("node_modules")) {
        return {
          ...resolved,
          format: "module-typescript",
          shortCircuit: true,
        };
      }
    } catch {
      // Fall through to the default resolution.
    }
  }

  return resolved;
}
