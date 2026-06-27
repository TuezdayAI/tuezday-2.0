import fs from "fs/promises";
import path from "path";

async function processFile(filePath) {
  let content = await fs.readFile(filePath, "utf-8");
  let modified = false;

  // Replace page-header
  const headerRegex = /<div className="page-header">\s*<div>\s*<h1>(.*?)<\/h1>(?:\s*<p className="subtitle">([\s\S]*?)<\/p>)?\s*<\/div>(?:\s*<div className="page-actions">\s*([\s\S]*?)\s*<\/div>\s*)?<\/div>/g;
  
  if (headerRegex.test(content)) {
    content = content.replace(headerRegex, (match, title, subtitle, actions) => {
      let props = `title="${title}"`;
      if (subtitle) {
        props += ` subtitle={<>${subtitle.trim()}</>}`;
      }
      if (actions) {
        props += ` actions={<>\n${actions.trim().split('\\n').map(l => '            ' + l).join('\\n')}\n          </>}`;
      }
      return `<PageHeader ${props} />`;
    });
    modified = true;
  }

  // Find all `<p className="empty">...</p>`
  const emptyRegex = /<p className="empty">([\s\S]*?)<\/p>/g;
  if (emptyRegex.test(content)) {
    content = content.replace(emptyRegex, (match, text) => {
      if (text.trim() === "Loading…") {
        return `<EmptyState description="Loading…" />`;
      }
      return `<EmptyState description={<>${text.trim()}</>} />`;
    });
    modified = true;
  }
  
  if (modified) {
    let importsToAdd = [];
    if (content.includes("<PageHeader") && !content.includes("import { PageHeader }")) {
      importsToAdd.push("PageHeader");
    }
    if (content.includes("<EmptyState") && !content.includes("import { EmptyState }")) {
      importsToAdd.push("EmptyState");
    }
    
    if (importsToAdd.length > 0) {
      let importStr = "";
      if (importsToAdd.includes("PageHeader")) importStr += 'import { PageHeader } from "@/src/components/page-header";\n';
      if (importsToAdd.includes("EmptyState")) importStr += 'import { EmptyState } from "@/src/components/empty-state";\n';
      
      // insert safely after "use client";
      if (content.startsWith('"use client";')) {
        content = '"use client";\n\n' + importStr + content.slice(13);
      } else {
        content = importStr + content;
      }
    }
    await fs.writeFile(filePath, content, "utf-8");
    console.log("Modified", filePath);
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
