import fs from "fs";
import path from "path";

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );

for (const f of walk("src").filter((f) => f.endsWith(".jsx"))) {
  const s = fs.readFileSync(f, "utf8");
  if (/^import React\b/m.test(s)) continue;
  fs.writeFileSync(f, 'import React from "react";\n' + s);
  console.log("fixed", f);
}