import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(scriptDirectory, "../src");

function findJsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findJsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".jsx") ? [entryPath] : [];
  });
}

for (const filePath of findJsxFiles(sourceDirectory)) {
  const contents = fs.readFileSync(filePath, "utf8");
  if (/^import React\b/m.test(contents)) continue;
  fs.writeFileSync(filePath, `import React from "react";\n${contents}`);
  console.log(`Added React import: ${path.relative(sourceDirectory, filePath)}`);
}