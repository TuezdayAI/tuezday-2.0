import fs from "fs/promises";
import path from "path";

async function processFile(filePath) {
  let content = await fs.readFile(filePath, "utf-8");
  let modified = false;

  const needsHeader = content.includes("<PageHeader");
  const needsEmpty = content.includes("<EmptyState");
  
  const hasHeaderImport = content.includes("import { PageHeader }");
  const hasEmptyImport = content.includes("import { EmptyState }");

  if (needsHeader && !hasHeaderImport) {
    const importStr = 'import { PageHeader } from "@/src/components/page-header";\n';
    const lines = content.split('\n');
    let lastImport = -1;
    for (let i=0; i<lines.length; i++) {
      if (lines[i].startsWith("import ")) lastImport = i;
    }
    if (lastImport !== -1) {
      lines.splice(lastImport + 1, 0, importStr);
    } else {
      lines.splice(1, 0, importStr); // After "use client" if it exists
    }
    content = lines.join('\n');
    modified = true;
  }
  
  if (needsEmpty && !hasEmptyImport) {
    const importStr = 'import { EmptyState } from "@/src/components/empty-state";\n';
    const lines = content.split('\n');
    let lastImport = -1;
    for (let i=0; i<lines.length; i++) {
      if (lines[i].startsWith("import ")) lastImport = i;
    }
    if (lastImport !== -1) {
      lines.splice(lastImport + 1, 0, importStr);
    } else {
      lines.splice(1, 0, importStr); // After "use client" if it exists
    }
    content = lines.join('\n');
    modified = true;
  }

  if (modified) {
    await fs.writeFile(filePath, content, "utf-8");
    console.log("Added imports to", filePath);
  }
}

async function main() {
  const dir = path.join(process.cwd(), "apps/web/app/workspaces/[id]");
  const walk = async (dir) => {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const f of files) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) await walk(full);
      else if (f.isFile() && f.name.endsWith(".tsx")) await processFile(full);
    }
  };
  await walk(dir);
}

main().catch(console.error);
